'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { chunkBuffer, entropy, sha256 } = require('./chunker');
const { classify, adaptStrategy } = require('./classifier');
const { deriveKey, encrypt, decrypt, generateSalt, SALT_LENGTH } = require('./crypto');

// ─── Constants ────────────────────────────────────────────────────────
const MAGIC = Buffer.from('VAULT02\0');    // V2: content-defined chunking
const VERSION = 2;
const MAX_MEM_FILE = 256 * 1024 * 1024;   // 256 MB — files larger use fixed chunking
const FIXED_CHUNK = 64 * 1024;             // 64 KB fallback for huge files

// Chunk flag bytes
const FLAG_RAW           = 0x00;  // raw uncompressed unencrypted
const FLAG_GZIP          = 0x01;  // gzip compressed unencrypted
const FLAG_RAW_ENCRYPTED = 0x02;  // raw encrypted (no compression)
const FLAG_GZIP_ENCRYPTED = 0x03; // gzip + encrypted

// Key file layout (encrypted vault):
//   [MAGIC(8)] [VERSION(4)] [FLAGS(4)] [SALT(32)] [ENCRYPTED_MANIFEST]
// Key file layout (unencrypted vault):
//   [MAGIC(8)] [VERSION(4)] [FLAGS(4)] [GZIPPED_MANIFEST]
//
// FLAGS byte 0: 0x00 = unencrypted, 0x01 = encrypted

// ─── Vault Engine v2 ─────────────────────────────────────────────────
class Vault {
  constructor(dir) {
    this.dir = path.resolve(dir || '.');
    this.keyPath = path.join(this.dir, 'vault.key');
    this.chunksDir = path.join(this.dir, '.vault', 'chunks');
    this.manifest = null;
    this._masterKey = null;   // 32-byte AES key (null if unencrypted)
    this._encrypted = false;  // whether this vault uses encryption
  }

  // ── Initialize ────────────────────────────────────────────────────
  init(password) {
    if (fs.existsSync(this.keyPath)) throw new Error('Vault already exists here');
    fs.mkdirSync(this.chunksDir, { recursive: true });
    this.manifest = { created: Date.now(), version: VERSION, files: {} };

    if (password) {
      const salt = generateSalt();
      this._masterKey = deriveKey(password, salt);
      this._encrypted = true;
      this._salt = salt;
    }

    this._saveKey();
    return {
      keyPath: this.keyPath,
      keySize: fs.statSync(this.keyPath).size,
      chunksDir: this.chunksDir,
      encrypted: this._encrypted,
    };
  }

  // ── Open ──────────────────────────────────────────────────────────
  open(password) {
    if (!fs.existsSync(this.keyPath)) throw new Error('No vault.key found');
    const raw = fs.readFileSync(this.keyPath);
    if (raw.length < 16) throw new Error('Corrupt vault key');

    const magic = raw.subarray(0, 8).toString();
    if (magic !== 'VAULT02\0' && magic !== 'VAULT01\0') throw new Error('Invalid vault key');

    // Check encryption flag in header
    const flags = raw.readUInt32LE(12);
    const isEncrypted = (flags & 0x01) !== 0;

    if (isEncrypted) {
      // Encrypted vault: header(16) + salt(32) + encrypted_manifest
      if (!password) {
        throw new Error('This vault is encrypted — password required');
      }
      if (raw.length < 16 + SALT_LENGTH) {
        throw new Error('Corrupt vault key: missing salt');
      }

      const salt = raw.subarray(16, 16 + SALT_LENGTH);
      const encryptedManifest = raw.subarray(16 + SALT_LENGTH);

      this._masterKey = deriveKey(password, salt);
      this._encrypted = true;
      this._salt = salt;

      // Decrypt manifest — the encrypted payload is gzipped JSON
      let decrypted;
      try {
        decrypted = decrypt(encryptedManifest, this._masterKey);
      } catch (err) {
        throw new Error('Wrong password or corrupted vault key');
      }

      this.manifest = JSON.parse(zlib.gunzipSync(decrypted).toString('utf8'));
    } else {
      // Unencrypted vault (backward compatible)
      if (password) {
        throw new Error('This vault is not encrypted — do not provide a password');
      }
      const gz = raw.subarray(16);
      this.manifest = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
      this._encrypted = false;
      this._masterKey = null;
    }

    return this.manifest;
  }

  // ── Store file or directory ───────────────────────────────────────
  add(filePath, virtualPath) {
    if (!this.manifest) this.open();
    filePath = path.resolve(filePath);
    if (!fs.existsSync(filePath)) throw new Error('Not found: ' + filePath);
    const stat = fs.statSync(filePath);
    let results;
    if (stat.isDirectory()) {
      results = this._addDir(filePath, virtualPath || path.basename(filePath));
    } else {
      results = [this._addFile(filePath, virtualPath || path.basename(filePath))];
    }
    this._saveKey();
    return results;
  }

  // ── Add single file (enhanced with CDC + classification) ──────────
  _addFile(filePath, virtualPath) {
    const stat = fs.statSync(filePath);

    // Empty file
    if (stat.size === 0) {
      this.manifest.files[virtualPath] = {
        size: 0, hash: sha256(Buffer.alloc(0)), modified: stat.mtimeMs,
        stored: Date.now(), chunks: [], classification: { category: 'empty' },
      };
      return { virtualPath, size: 0, chunks: 0, newChunks: 0, dupChunks: 0,
               storedBytes: 0, category: 'empty', strategy: 'skip' };
    }

    // Read file header for classification
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(Math.min(16, stat.size));
    fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);

    const classification = classify(filePath, header);

    // Read file and chunk it
    let rawChunks;
    let fileBuffer;

    if (stat.size <= MAX_MEM_FILE) {
      // Content-defined chunking (better dedup)
      fileBuffer = fs.readFileSync(filePath);
      rawChunks = chunkBuffer(fileBuffer);
    } else {
      // Fixed chunking for very large files (memory-safe)
      rawChunks = this._fixedChunkFile(filePath, stat.size);
      // For file hash, we compute it streaming
      fileBuffer = null;
    }

    // Compute file hash
    let fileHash;
    if (fileBuffer) {
      fileHash = sha256(fileBuffer);
    } else {
      fileHash = this._streamHash(filePath);
    }

    // Process chunks
    const chunkHashes = [];
    let newChunks = 0, dupChunks = 0, storedBytes = 0;

    for (const chunk of rawChunks) {
      const data = chunk.data || chunk;
      const chunkHash = sha256(data);
      chunkHashes.push(chunkHash);

      const chunkPath = this._chunkPath(chunkHash);
      if (fs.existsSync(chunkPath)) {
        dupChunks++;
        continue;
      }

      // Adaptive compression: check entropy of this chunk
      const ent = entropy(data);
      const strategy = adaptStrategy(classification, ent);

      let compressed;
      let isCompressed = false;

      if (strategy.level === 0) {
        // Store raw (already compressed / high entropy)
        compressed = data;
      } else {
        compressed = zlib.gzipSync(data, { level: strategy.level });
        // If gzip made it bigger, store raw
        if (compressed.length >= data.length) {
          compressed = data;
        } else {
          isCompressed = true;
        }
      }

      // Determine payload and flag byte
      let payload = isCompressed ? compressed : data;
      let flag;

      if (this._encrypted && this._masterKey) {
        // Encrypt the payload (after compression, before writing)
        payload = encrypt(payload, this._masterKey);
        flag = isCompressed ? FLAG_GZIP_ENCRYPTED : FLAG_RAW_ENCRYPTED;
      } else {
        flag = isCompressed ? FLAG_GZIP : FLAG_RAW;
      }

      fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
      fs.writeFileSync(chunkPath, Buffer.concat([Buffer.from([flag]), payload]));

      newChunks++;
      storedBytes += 1 + payload.length;
    }

    // Record in manifest
    this.manifest.files[virtualPath] = {
      size: stat.size,
      hash: fileHash,
      modified: stat.mtimeMs,
      stored: Date.now(),
      chunks: chunkHashes,
      classification: {
        category: classification.category,
        type: classification.type,
        strategy: classification.label,
      },
    };

    return {
      virtualPath,
      size: stat.size,
      chunks: chunkHashes.length,
      newChunks,
      dupChunks,
      storedBytes,
      category: classification.category,
      strategy: classification.label,
    };
  }

  // ── Fixed-size chunking for large files ───────────────────────────
  _fixedChunkFile(filePath, fileSize) {
    const fd = fs.openSync(filePath, 'r');
    const chunks = [];
    const buf = Buffer.alloc(FIXED_CHUNK);
    try {
      while (true) {
        const n = fs.readSync(fd, buf, 0, FIXED_CHUNK);
        if (n === 0) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
    } finally {
      fs.closeSync(fd);
    }
    return chunks;
  }

  // ── Stream hash for large files ───────────────────────────────────
  _streamHash(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    try {
      while (true) {
        const n = fs.readSync(fd, buf, 0, buf.length);
        if (n === 0) break;
        hash.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }

  // ── Add directory recursively ─────────────────────────────────────
  _addDir(dirPath, virtualBase) {
    const results = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dirPath, e.name);
      const vPath = virtualBase + '/' + e.name;
      if (e.isDirectory()) results.push(...this._addDir(full, vPath));
      else if (e.isFile()) results.push(this._addFile(full, vPath));
    }
    return results;
  }

  // ── Read and decode a chunk from disk ─────────────────────────────
  _readChunk(chunkPath) {
    const raw = fs.readFileSync(chunkPath);
    const flag = raw[0];
    const payload = raw.subarray(1);

    switch (flag) {
      case FLAG_RAW:
        // Raw uncompressed unencrypted
        return payload;

      case FLAG_GZIP:
        // Gzip compressed unencrypted
        return zlib.gunzipSync(payload);

      case FLAG_RAW_ENCRYPTED: {
        // Raw encrypted (no compression)
        if (!this._masterKey) throw new Error('Chunk is encrypted — password required');
        return decrypt(payload, this._masterKey);
      }

      case FLAG_GZIP_ENCRYPTED: {
        // Gzip + encrypted: decrypt first, then decompress
        if (!this._masterKey) throw new Error('Chunk is encrypted — password required');
        const decrypted = decrypt(payload, this._masterKey);
        return zlib.gunzipSync(decrypted);
      }

      default:
        throw new Error('Unknown chunk flag: 0x' + flag.toString(16).padStart(2, '0'));
    }
  }

  // ── Extract a file ────────────────────────────────────────────────
  get(virtualPath, destPath) {
    if (!this.manifest) this.open();
    const file = this.manifest.files[virtualPath];
    if (!file) throw new Error('Not in vault: ' + virtualPath);

    destPath = path.resolve(destPath || path.basename(virtualPath));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const fd = fs.openSync(destPath, 'w');
    const verify = crypto.createHash('sha256');

    try {
      for (const ch of file.chunks) {
        const chunkPath = this._chunkPath(ch);
        if (!fs.existsSync(chunkPath)) throw new Error('Missing chunk: ' + ch.slice(0, 12));

        const data = this._readChunk(chunkPath);
        verify.update(data);
        fs.writeSync(fd, data);
      }
    } finally {
      fs.closeSync(fd);
    }

    const actualHash = verify.digest('hex');
    if (actualHash !== file.hash) {
      fs.unlinkSync(destPath);
      throw new Error('INTEGRITY FAILURE: SHA-256 mismatch for ' + virtualPath);
    }

    if (file.modified) {
      try { fs.utimesSync(destPath, new Date(), new Date(file.modified)); } catch (_) {}
    }

    return { virtualPath, destPath, size: file.size, chunks: file.chunks.length, verified: true };
  }

  // ── List files ────────────────────────────────────────────────────
  ls(pattern) {
    if (!this.manifest) this.open();
    let files = Object.entries(this.manifest.files)
      .map(([p, m]) => ({
        path: p, size: m.size, hash: m.hash, modified: m.modified,
        stored: m.stored, chunks: m.chunks.length,
        category: m.classification?.category || 'unknown',
        strategy: m.classification?.strategy || 'standard',
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (pattern) {
      const re = new RegExp(pattern, 'i');
      files = files.filter(f => re.test(f.path));
    }
    return files;
  }

  // ── Remove ────────────────────────────────────────────────────────
  rm(virtualPath) {
    if (!this.manifest) this.open();
    if (!this.manifest.files[virtualPath]) throw new Error('Not in vault: ' + virtualPath);
    delete this.manifest.files[virtualPath];
    const gc = this._gc();
    this._saveKey();
    return { removed: virtualPath, ...gc };
  }

  // ── Verify ────────────────────────────────────────────────────────
  verify() {
    if (!this.manifest) this.open();
    const results = [];
    for (const [vpath, meta] of Object.entries(this.manifest.files)) {
      let missing = 0;
      for (const ch of meta.chunks) {
        if (!fs.existsSync(this._chunkPath(ch))) missing++;
      }
      results.push({
        path: vpath, size: meta.size, chunks: meta.chunks.length,
        ok: missing === 0, missingChunks: missing, hash: meta.hash,
      });
    }
    return results;
  }

  // ── Statistics (enhanced with classification breakdown) ────────────
  stats() {
    if (!this.manifest) this.open();

    const files = Object.entries(this.manifest.files);
    const totalOriginal = files.reduce((s, [, m]) => s + m.size, 0);

    const allChunks = new Set();
    let totalRefs = 0;
    for (const [, m] of files) {
      for (const ch of m.chunks) allChunks.add(ch);
      totalRefs += m.chunks.length;
    }

    let totalStored = 0;
    for (const ch of allChunks) {
      const p = this._chunkPath(ch);
      if (fs.existsSync(p)) totalStored += fs.statSync(p).size;
    }

    const keySize = fs.existsSync(this.keyPath) ? fs.statSync(this.keyPath).size : 0;

    // Classification breakdown
    const byCategory = {};
    for (const [, m] of files) {
      const cat = m.classification?.category || 'unknown';
      if (!byCategory[cat]) byCategory[cat] = { files: 0, originalBytes: 0 };
      byCategory[cat].files++;
      byCategory[cat].originalBytes += m.size;
    }

    return {
      files: files.length,
      totalOriginal,
      totalStored,
      keySize,
      totalOnDisk: totalStored + keySize,
      ratio: totalStored > 0 ? (totalOriginal / totalStored).toFixed(2) : '0.00',
      savings: totalOriginal > 0
        ? ((1 - (totalStored + keySize) / totalOriginal) * 100).toFixed(1) + '%'
        : '0%',
      uniqueChunks: allChunks.size,
      totalChunkRefs: totalRefs,
      dedupSaved: totalRefs - allChunks.size,
      created: this.manifest.created,
      encrypted: this._encrypted,
      byCategory,
    };
  }

  // ── Garbage collect ───────────────────────────────────────────────
  _gc() {
    const refs = new Set();
    for (const m of Object.values(this.manifest.files)) {
      for (const ch of m.chunks) refs.add(ch);
    }
    let removed = 0, freed = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); try { fs.rmdirSync(full); } catch (_) {} }
        else if (e.name.endsWith('.chunk')) {
          const h = e.name.slice(0, -6);
          if (!refs.has(h)) { freed += fs.statSync(full).size; fs.unlinkSync(full); removed++; }
        }
      }
    };
    walk(this.chunksDir);
    return { chunksRemoved: removed, freedBytes: freed };
  }

  // ── Save key file ─────────────────────────────────────────────────
  _saveKey() {
    const manifestJson = Buffer.from(JSON.stringify(this.manifest));
    const gz = zlib.gzipSync(manifestJson, { level: 9 });

    const hdr = Buffer.alloc(16);
    MAGIC.copy(hdr, 0);
    hdr.writeUInt32LE(VERSION, 8);

    if (this._encrypted && this._masterKey) {
      // Set encryption flag in header
      hdr.writeUInt32LE(0x01, 12);
      // Encrypt the gzipped manifest
      const encryptedManifest = encrypt(gz, this._masterKey);
      // Write: [header(16)] [salt(32)] [encrypted_manifest]
      fs.writeFileSync(this.keyPath, Buffer.concat([hdr, this._salt, encryptedManifest]));
    } else {
      // Unencrypted: same as before
      hdr.writeUInt32LE(0, 12);
      fs.writeFileSync(this.keyPath, Buffer.concat([hdr, gz]));
    }
  }

  // ── Chunk path ────────────────────────────────────────────────────
  _chunkPath(hash) {
    return path.join(this.chunksDir, hash.slice(0, 2), hash.slice(2, 4), hash + '.chunk');
  }
}

module.exports = Vault;
