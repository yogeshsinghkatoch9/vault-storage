'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { entropy } = require('./chunker');

// ─── Disk X-Ray Scanner ──────────────────────────────────────────────
// Scans a directory and produces a full analysis:
// - File type breakdown (size per type)
// - Duplicate detection (exact + near via size+partial hash)
// - Largest files
// - Estimated vault savings
// - Directory size treemap data

const SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt', '.cache',
  '.DS_Store', 'Thumbs.db', '.Trash', '.Spotlight-V100',
  '.vault', '.svn', '.hg',
]);

function scan(targetDir, opts = {}) {
  const maxDepth = opts.maxDepth || 20;
  const maxFiles = opts.maxFiles || 500000;
  const t0 = performance.now();

  const files = [];         // { path, size, ext, dir, mtime }
  const bySize = new Map(); // size → [file indices] (for dupe detection)
  const byExt = {};         // ext → { count, totalSize }
  const dirs = {};          // dir → totalSize (for treemap)
  let totalSize = 0;
  let totalFiles = 0;
  let scannedDirs = 0;
  let skippedDirs = 0;

  // ── Walk filesystem ─────────────────────────────────────────────
  function walk(dir, depth) {
    if (depth > maxDepth || totalFiles >= maxFiles) return;
    scannedDirs++;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (SKIP.has(e.name)) { skippedDirs++; continue; }

      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (totalFiles >= maxFiles) break;

        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }

        const ext = path.extname(e.name).toLowerCase() || '(none)';
        const relDir = path.relative(targetDir, dir) || '.';

        const idx = files.length;
        files.push({
          path: path.relative(targetDir, full),
          name: e.name,
          size: stat.size,
          ext,
          dir: relDir,
          mtime: stat.mtimeMs,
        });

        totalSize += stat.size;
        totalFiles++;

        // Index by size for dupe detection
        if (!bySize.has(stat.size)) bySize.set(stat.size, []);
        bySize.get(stat.size).push(idx);

        // Aggregate by extension
        if (!byExt[ext]) byExt[ext] = { count: 0, totalSize: 0 };
        byExt[ext].count++;
        byExt[ext].totalSize += stat.size;

        // Aggregate by directory
        if (!dirs[relDir]) dirs[relDir] = 0;
        dirs[relDir] += stat.size;
      }
    }
  }

  walk(path.resolve(targetDir), 0);

  // ── Detect exact duplicates (same size + same hash) ─────────────
  const duplicates = [];     // { hash, size, files: [paths] }
  let dupeWaste = 0;
  let dupeGroups = 0;

  for (const [size, indices] of bySize) {
    if (indices.length < 2 || size === 0) continue;

    // Group by partial hash (first 4KB + last 4KB) for speed
    const byPartial = new Map();
    for (const idx of indices) {
      const f = files[idx];
      const fullPath = path.join(targetDir, f.path);
      let partialHash;
      try {
        const fd = fs.openSync(fullPath, 'r');
        const headBuf = Buffer.alloc(Math.min(4096, size));
        fs.readSync(fd, headBuf, 0, headBuf.length, 0);

        if (size > 8192) {
          const tailBuf = Buffer.alloc(4096);
          fs.readSync(fd, tailBuf, 0, 4096, size - 4096);
          partialHash = crypto.createHash('md5')
            .update(headBuf).update(tailBuf).digest('hex');
        } else {
          partialHash = crypto.createHash('md5')
            .update(headBuf).digest('hex');
        }
        fs.closeSync(fd);
      } catch (_) { continue; }

      if (!byPartial.has(partialHash)) byPartial.set(partialHash, []);
      byPartial.get(partialHash).push(idx);
    }

    // Groups with 2+ files are duplicates
    for (const [hash, group] of byPartial) {
      if (group.length < 2) continue;
      const paths = group.map(i => files[i].path);
      const waste = size * (group.length - 1);
      duplicates.push({ hash, size, count: group.length, files: paths, waste });
      dupeWaste += waste;
      dupeGroups++;
    }
  }

  // Sort duplicates by waste (biggest first)
  duplicates.sort((a, b) => b.waste - a.waste);

  // ── Largest files ───────────────────────────────────────────────
  const largest = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 30)
    .map(f => ({ path: f.path, size: f.size, ext: f.ext }));

  // ── File type breakdown (sorted by size) ────────────────────────
  const typeBreakdown = Object.entries(byExt)
    .map(([ext, d]) => ({ ext, count: d.count, totalSize: d.totalSize, pct: ((d.totalSize / totalSize) * 100).toFixed(1) }))
    .sort((a, b) => b.totalSize - a.totalSize);

  // ── Directory treemap data ──────────────────────────────────────
  const dirTree = Object.entries(dirs)
    .map(([dir, size]) => ({ dir, size, pct: ((size / totalSize) * 100).toFixed(1) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 100);

  // ── Estimate vault savings ──────────────────────────────────────
  // Conservative estimate: dupes eliminated + text compressed ~5x + other ~1.2x
  let estTextSize = 0, estMediaSize = 0, estOtherSize = 0;
  const TEXT_EXTS = new Set(['.txt','.md','.csv','.json','.js','.ts','.py','.html','.css','.xml','.yml','.yaml','.log','.sql','.sh','.rb','.java','.c','.cpp','.h','.go','.rs','.swift','.jsx','.tsx','.vue','.svelte','.env','.conf','.ini','.toml']);
  const MEDIA_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.mp4','.mov','.mkv','.avi','.mp3','.aac','.ogg','.wav','.webm','.webp','.heic','.flac']);

  for (const f of files) {
    if (TEXT_EXTS.has(f.ext)) estTextSize += f.size;
    else if (MEDIA_EXTS.has(f.ext)) estMediaSize += f.size;
    else estOtherSize += f.size;
  }

  const estVaultSize = Math.round(
    (estTextSize / 5) +        // text compresses ~5x
    (estMediaSize * 0.98) +    // media barely compresses (already compressed)
    (estOtherSize / 1.5) +     // other compresses ~1.5x
    - dupeWaste                // duplicates eliminated entirely
  );
  const estSavings = Math.max(0, totalSize - Math.max(estVaultSize, 0));

  const dt = performance.now() - t0;

  return {
    targetDir: path.resolve(targetDir),
    scanTime: Math.round(dt),
    totalFiles,
    totalSize,
    scannedDirs,
    skippedDirs,
    duplicates: {
      groups: dupeGroups,
      wastedBytes: dupeWaste,
      details: duplicates.slice(0, 50), // top 50 worst offenders
    },
    largest,
    typeBreakdown,
    dirTree,
    vaultEstimate: {
      originalSize: totalSize,
      estimatedVaultSize: Math.max(estVaultSize, 0),
      estimatedSavings: estSavings,
      estimatedRatio: estVaultSize > 0 ? (totalSize / estVaultSize).toFixed(1) : '0',
      savingsPct: totalSize > 0 ? ((estSavings / totalSize) * 100).toFixed(1) : '0',
    },
  };
}

module.exports = { scan };
