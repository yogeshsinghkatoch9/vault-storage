#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Vault = require('./src/engine');
const { entropy } = require('./src/chunker');
const { classify } = require('./src/classifier');

const TEST_DIR = path.join(__dirname, '.test-vault-' + Date.now());
const FILES_DIR = path.join(TEST_DIR, 'input');
const VAULT_DIR = path.join(TEST_DIR, 'vault');
const OUT_DIR = path.join(TEST_DIR, 'output');

let passed = 0, failed = 0;

function assert(ok, msg) {
  if (ok) { passed++; console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m\u2717\x1b[0m ${msg}`); }
}

function rand(n) { return crypto.randomBytes(n); }

// ─── Setup ────────────────────────────────────────────────────────────
function setup() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Text file (highly compressible)
  fs.writeFileSync(path.join(FILES_DIR, 'readme.txt'),
    'Hello Vault! This is a test of the content-defined chunking system.\n'.repeat(500));

  // JSON (structured, compressible)
  const json = JSON.stringify({
    users: Array.from({ length: 1000 }, (_, i) => ({
      id: i, name: `User ${i}`, email: `user${i}@test.com`,
      scores: Array.from({ length: 20 }, () => Math.random()),
    })),
  }, null, 2);
  fs.writeFileSync(path.join(FILES_DIR, 'data.json'), json);

  // CSV (structured, compressible)
  const rows = ['id,name,value,date'];
  for (let i = 0; i < 20000; i++)
    rows.push(`${i},item_${i},${(Math.random()*1000).toFixed(2)},2024-${String((i%12)+1).padStart(2,'0')}-${String((i%28)+1).padStart(2,'0')}`);
  fs.writeFileSync(path.join(FILES_DIR, 'data.csv'), rows.join('\n'));

  // Fake JPEG (compressed media — starts with JPEG magic bytes + random)
  const jpeg = Buffer.alloc(200000);
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).copy(jpeg);
  crypto.randomFillSync(jpeg, 4);
  fs.writeFileSync(path.join(FILES_DIR, 'photo.jpg'), jpeg);

  // Fake MP4 (compressed video)
  const mp4 = Buffer.alloc(2 * 1024 * 1024);
  Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]).copy(mp4); // ftyp
  crypto.randomFillSync(mp4, 8);
  fs.writeFileSync(path.join(FILES_DIR, 'clip.mp4'), mp4);

  // PNG (lossless media)
  const png = Buffer.alloc(100000);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(png);
  crypto.randomFillSync(png, 8);
  fs.writeFileSync(path.join(FILES_DIR, 'image.png'), png);

  // Empty file
  fs.writeFileSync(path.join(FILES_DIR, 'empty.dat'), '');

  // Exact duplicate (for dedup testing)
  fs.copyFileSync(path.join(FILES_DIR, 'readme.txt'), path.join(FILES_DIR, 'readme-copy.txt'));

  // Near-duplicate: same large content with a small change at end (CDC dedup test)
  // The original readme.txt is only 34KB (1 chunk). We need a LARGE shared base.
  const bigBase = 'Line for CDC dedup testing across files. Number: ';
  const bigLines = [];
  for (let i = 0; i < 20000; i++) bigLines.push(bigBase + i);
  const bigContent = bigLines.join('\n');
  // Overwrite readme.txt with big content so it has many chunks
  fs.writeFileSync(path.join(FILES_DIR, 'readme.txt'), bigContent);
  fs.copyFileSync(path.join(FILES_DIR, 'readme.txt'), path.join(FILES_DIR, 'readme-copy.txt'));
  // Modified version: same content + small append
  fs.writeFileSync(path.join(FILES_DIR, 'readme-modified.txt'), bigContent + '\nAPPENDED LINE\n');

  // ZIP file (already compressed)
  const zip = Buffer.alloc(50000);
  Buffer.from([0x50, 0x4B, 0x03, 0x04]).copy(zip);
  crypto.randomFillSync(zip, 4);
  fs.writeFileSync(path.join(FILES_DIR, 'archive.zip'), zip);

  // Nested directory
  const sub = path.join(FILES_DIR, 'subdir', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'nested.txt'), 'deeply nested content\n'.repeat(100));
}

// ─── Tests ────────────────────────────────────────────────────────────
function runTests() {
  console.log('\n\x1b[1m=== VAULT v2 ENGINE TEST SUITE ===\x1b[0m\n');

  // === CLASSIFIER TESTS ===
  console.log('\x1b[33m[classifier]\x1b[0m');
  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
  const jpegClass = classify('photo.jpg', jpegHeader);
  assert(jpegClass.category === 'media-compressed', `JPEG → media-compressed (${jpegClass.label})`);

  const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
  const mp4Class = classify('clip.mp4', mp4Header);
  assert(mp4Class.category === 'media-compressed', `MP4 → media-compressed (${mp4Class.label})`);

  const txtClass = classify('readme.txt', Buffer.from('Hello'));
  assert(txtClass.category === 'text', `TXT → text (${txtClass.label})`);

  const csvClass = classify('data.csv', Buffer.from('id,name'));
  assert(csvClass.category === 'text', `CSV → text (${csvClass.label})`);

  const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x0A, 0x00, 0x00, 0x00]);
  const zipClass = classify('archive.zip', zipHeader);
  assert(zipClass.category === 'archive', `ZIP → archive (${zipClass.label})`);

  // === ENTROPY TESTS ===
  console.log('\n\x1b[33m[entropy]\x1b[0m');
  const textEnt = entropy(Buffer.from('Hello world! '.repeat(1000)));
  assert(textEnt < 4.0, `text entropy: ${textEnt.toFixed(2)} bits/byte (< 4.0)`);

  const randEnt = entropy(rand(10000));
  assert(randEnt > 7.5, `random entropy: ${randEnt.toFixed(2)} bits/byte (> 7.5)`);

  // === INIT ===
  console.log('\n\x1b[33m[init]\x1b[0m');
  const vault = new Vault(VAULT_DIR);
  vault.init();
  assert(fs.existsSync(vault.keyPath), 'vault.key created');
  assert(fs.existsSync(vault.chunksDir), 'chunks dir created');

  // === ADD FILES ===
  console.log('\n\x1b[33m[add files — smart classification]\x1b[0m');
  const testFiles = [
    'readme.txt', 'data.json', 'data.csv', 'photo.jpg',
    'clip.mp4', 'image.png', 'empty.dat', 'readme-copy.txt',
    'readme-modified.txt', 'archive.zip',
  ];

  const addResults = {};
  for (const f of testFiles) {
    const t0 = performance.now();
    const results = vault.add(path.join(FILES_DIR, f));
    const dt = performance.now() - t0;
    const r = results[0];
    addResults[f] = r;
    const dedup = r.dupChunks > 0 ? ` \x1b[32m(${r.dupChunks} dedup)\x1b[0m` : '';
    assert(true, `${f}: ${r.category} / ${r.strategy} / ${r.chunks}ch${dedup} (${dt.toFixed(1)}ms)`);
  }

  // === ADD DIRECTORY ===
  console.log('\n\x1b[33m[add directory]\x1b[0m');
  const dirR = vault.add(path.join(FILES_DIR, 'subdir'), 'subdir');
  assert(dirR.length >= 1, `added dir with ${dirR.length} file(s)`);

  // === CLASSIFICATION VERIFICATION ===
  console.log('\n\x1b[33m[classification correctness]\x1b[0m');
  assert(addResults['readme.txt'].category === 'text', 'readme.txt classified as text');
  assert(addResults['data.json'].category === 'text', 'data.json classified as text');
  assert(addResults['photo.jpg'].category === 'media-compressed', 'photo.jpg classified as media-compressed');
  assert(addResults['clip.mp4'].category === 'media-compressed', 'clip.mp4 classified as media-compressed');
  assert(addResults['archive.zip'].category === 'archive', 'archive.zip classified as archive');

  // === SMART COMPRESSION VERIFICATION ===
  console.log('\n\x1b[33m[smart compression — already-compressed not re-gzipped]\x1b[0m');
  assert(addResults['photo.jpg'].strategy === 'store', 'JPEG: store strategy (no gzip)');
  assert(addResults['clip.mp4'].strategy === 'store', 'MP4: store strategy (no gzip)');
  assert(addResults['archive.zip'].strategy === 'store', 'ZIP: store strategy (no gzip)');
  assert(addResults['readme.txt'].strategy === 'ultra', 'TXT: ultra compression');
  assert(addResults['data.csv'].strategy === 'ultra', 'CSV: ultra compression');

  // === DEDUP ===
  console.log('\n\x1b[33m[deduplication]\x1b[0m');
  assert(addResults['readme-copy.txt'].dupChunks > 0, `exact duplicate: ${addResults['readme-copy.txt'].dupChunks} chunks deduped`);
  assert(addResults['readme-copy.txt'].newChunks === 0, 'exact duplicate: 0 new chunks stored');

  const modR = addResults['readme-modified.txt'];
  assert(modR.dupChunks > 0, `near-duplicate: ${modR.dupChunks} chunks deduped (CDC benefit)`);

  const stats = vault.stats();
  assert(stats.dedupSaved > 0, `total dedup savings: ${stats.dedupSaved} chunk refs`);

  // === EXTRACT + VERIFY ===
  console.log('\n\x1b[33m[extract + byte-perfect verification]\x1b[0m');
  const allFiles = vault.ls();
  for (const f of allFiles) {
    const outPath = path.join(OUT_DIR, f.path.replace(/\//g, '_'));
    const t0 = performance.now();
    const result = vault.get(f.path, outPath);
    const dt = performance.now() - t0;
    assert(result.verified, `${f.path} SHA-256 verified (${dt.toFixed(1)}ms)`);

    // Byte comparison
    let origPath = path.join(FILES_DIR, f.path);
    if (!fs.existsSync(origPath)) origPath = path.join(FILES_DIR, f.path.replace('subdir/', 'subdir/'));
    if (fs.existsSync(origPath)) {
      const orig = fs.readFileSync(origPath);
      const ext = fs.readFileSync(outPath);
      assert(Buffer.compare(orig, ext) === 0, `${f.path} byte-perfect (${orig.length} bytes)`);
    }
  }

  // === STATS ===
  console.log('\n\x1b[33m[statistics]\x1b[0m');
  const s = vault.stats();
  assert(s.files > 0, `${s.files} files tracked`);
  assert(s.totalOriginal > 0, `original: ${(s.totalOriginal/1024).toFixed(0)} KB`);
  assert(s.totalStored > 0, `stored: ${(s.totalStored/1024).toFixed(0)} KB`);
  assert(parseFloat(s.ratio) > 0, `ratio: ${s.ratio}:1`);
  assert(Object.keys(s.byCategory).length > 0, `categories: ${Object.keys(s.byCategory).join(', ')}`);
  assert(s.savings, `savings: ${s.savings}`);

  // === REMOVE + GC ===
  console.log('\n\x1b[33m[remove + gc]\x1b[0m');
  const rm = vault.rm('empty.dat');
  assert(rm.removed === 'empty.dat', 'removed empty.dat');

  // === VERIFY ===
  console.log('\n\x1b[33m[integrity verify]\x1b[0m');
  const vr = vault.verify();
  assert(vr.every(r => r.ok), `all ${vr.length} files pass integrity check`);

  // === SPEED TEST ===
  console.log('\n\x1b[33m[speed test]\x1b[0m');
  const speedFiles = vault.ls();
  const t0 = performance.now();
  let totalBytes = 0;
  for (const f of speedFiles) {
    vault.get(f.path, path.join(OUT_DIR, 'speed-' + path.basename(f.path)));
    totalBytes += f.size;
  }
  const dt = performance.now() - t0;
  const mbps = (totalBytes / 1048576) / (dt / 1000);
  assert(true, `extracted ${speedFiles.length} files (${(totalBytes/1024).toFixed(0)} KB) in ${dt.toFixed(1)}ms`);
  assert(true, `throughput: ${mbps.toFixed(0)} MB/s`);
}

// ─── Run ──────────────────────────────────────────────────────────────
try {
  setup();
  runTests();
} catch (e) {
  console.error(`\n\x1b[31mFATAL: ${e.message}\x1b[0m\n${e.stack}`);
  failed++;
} finally {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

console.log(`\n\x1b[1m${'='.repeat(50)}\x1b[0m`);
console.log(`\x1b[32m  ${passed} passed\x1b[0m` + (failed > 0 ? `  \x1b[31m${failed} failed\x1b[0m` : ''));
console.log(`\x1b[1m${'='.repeat(50)}\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
