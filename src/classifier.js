'use strict';

const path = require('path');

// ─── Magic byte signatures ────────────────────────────────────────────
const SIGS = [
  { m: [0xFF,0xD8,0xFF],                         t: 'jpeg',  cat: 'media-compressed' },
  { m: [0x89,0x50,0x4E,0x47],                    t: 'png',   cat: 'media-lossless' },
  { m: [0x47,0x49,0x46,0x38],                    t: 'gif',   cat: 'media-compressed' },
  { m: [0x52,0x49,0x46,0x46],                    t: 'riff',  cat: 'media-raw' },
  { m: [0x50,0x4B,0x03,0x04],                    t: 'zip',   cat: 'archive' },
  { m: [0x25,0x50,0x44,0x46],                    t: 'pdf',   cat: 'document' },
  { m: [0x1F,0x8B],                              t: 'gzip',  cat: 'archive' },
  { m: [0x42,0x5A,0x68],                         t: 'bzip2', cat: 'archive' },
  { m: [0xFD,0x37,0x7A,0x58,0x5A],              t: 'xz',    cat: 'archive' },
  { m: [0x37,0x7A,0xBC,0xAF,0x27,0x1C],         t: '7z',    cat: 'archive' },
  { m: [0x52,0x61,0x72,0x21],                    t: 'rar',   cat: 'archive' },
  { m: [0x49,0x44,0x33],                         t: 'mp3',   cat: 'media-compressed' },
  { m: [0xFF,0xFB],                              t: 'mp3',   cat: 'media-compressed' },
  { m: [0xFF,0xF3],                              t: 'mp3',   cat: 'media-compressed' },
  { m: [0x4F,0x67,0x67,0x53],                    t: 'ogg',   cat: 'media-compressed' },
  { m: [0x66,0x4C,0x61,0x43],                    t: 'flac',  cat: 'media-lossless' },
  { m: [0x00,0x00,0x00],                         t: 'mp4?',  cat: 'media-compressed' },
];

// Extension → category mapping
const EXT = {
  // Already compressed media
  '.jpg': 'media-compressed', '.jpeg': 'media-compressed', '.jfif': 'media-compressed',
  '.mp4': 'media-compressed', '.m4v': 'media-compressed', '.mov': 'media-compressed',
  '.mkv': 'media-compressed', '.webm': 'media-compressed', '.avi': 'media-compressed',
  '.wmv': 'media-compressed', '.flv': 'media-compressed',
  '.mp3': 'media-compressed', '.aac': 'media-compressed', '.wma': 'media-compressed',
  '.ogg': 'media-compressed', '.opus': 'media-compressed', '.m4a': 'media-compressed',
  '.webp': 'media-compressed', '.avif': 'media-compressed', '.heic': 'media-compressed',

  // Lossless / raw media (compressible)
  '.png': 'media-lossless', '.bmp': 'media-raw', '.tiff': 'media-raw', '.tif': 'media-raw',
  '.wav': 'media-raw', '.aiff': 'media-raw', '.flac': 'media-lossless',
  '.psd': 'media-raw', '.raw': 'media-raw', '.cr2': 'media-raw', '.nef': 'media-raw',
  '.svg': 'text',

  // Archives (already compressed)
  '.zip': 'archive', '.gz': 'archive', '.bz2': 'archive', '.xz': 'archive',
  '.7z': 'archive', '.rar': 'archive', '.tar': 'binary', '.zst': 'archive',
  '.docx': 'archive', '.xlsx': 'archive', '.pptx': 'archive',

  // Text (highly compressible)
  '.txt': 'text', '.md': 'text', '.csv': 'text', '.tsv': 'text',
  '.json': 'text', '.jsonl': 'text', '.ndjson': 'text',
  '.xml': 'text', '.html': 'text', '.htm': 'text',
  '.css': 'text', '.js': 'text', '.mjs': 'text', '.ts': 'text',
  '.jsx': 'text', '.tsx': 'text', '.vue': 'text', '.svelte': 'text',
  '.py': 'text', '.rb': 'text', '.java': 'text', '.kt': 'text',
  '.c': 'text', '.cpp': 'text', '.h': 'text', '.hpp': 'text',
  '.rs': 'text', '.go': 'text', '.swift': 'text', '.dart': 'text',
  '.php': 'text', '.pl': 'text', '.r': 'text', '.m': 'text',
  '.sh': 'text', '.bash': 'text', '.zsh': 'text', '.fish': 'text',
  '.yml': 'text', '.yaml': 'text', '.toml': 'text', '.ini': 'text',
  '.conf': 'text', '.cfg': 'text', '.env': 'text',
  '.sql': 'text', '.graphql': 'text', '.proto': 'text',
  '.log': 'text', '.gitignore': 'text', '.editorconfig': 'text',
  '.ejs': 'text', '.hbs': 'text', '.pug': 'text',

  // Documents
  '.pdf': 'document', '.doc': 'document', '.xls': 'document',
  '.ppt': 'document', '.rtf': 'text', '.odt': 'archive',

  // Executables / regenerable
  '.exe': 'binary', '.dll': 'binary', '.so': 'binary',
  '.dylib': 'binary', '.wasm': 'binary',
};

// ─── Compression strategies per category ──────────────────────────────
// level: gzip level (0 = store raw, 1-9 = gzip)
const STRATEGY = {
  'media-compressed': { level: 0, label: 'store',    desc: 'already compressed' },
  'media-lossless':   { level: 3, label: 'light',    desc: 'lossless media' },
  'media-raw':        { level: 6, label: 'standard', desc: 'raw media' },
  'archive':          { level: 0, label: 'store',    desc: 'already archived' },
  'text':             { level: 9, label: 'ultra',    desc: 'text/code' },
  'document':         { level: 6, label: 'standard', desc: 'document' },
  'binary':           { level: 6, label: 'standard', desc: 'binary' },
};

// ─── Classify a file ──────────────────────────────────────────────────
function classify(filePath, headerBytes) {
  const ext = path.extname(filePath).toLowerCase();

  // Try magic bytes first
  if (headerBytes && headerBytes.length >= 8) {
    // MP4/MOV: check for 'ftyp' at offset 4
    if (headerBytes.length >= 8 &&
        headerBytes[4] === 0x66 && headerBytes[5] === 0x74 &&
        headerBytes[6] === 0x79 && headerBytes[7] === 0x70) {
      return { type: 'mp4', category: 'media-compressed', ...STRATEGY['media-compressed'] };
    }

    for (const sig of SIGS) {
      let match = true;
      for (let i = 0; i < sig.m.length; i++) {
        if (headerBytes[i] !== sig.m[i]) { match = false; break; }
      }
      if (match) {
        return { type: sig.t, category: sig.cat, ...STRATEGY[sig.cat] };
      }
    }
  }

  // Fall back to extension
  const cat = EXT[ext] || 'binary';
  return { type: ext.slice(1) || 'unknown', category: cat, ...STRATEGY[cat] };
}

// ─── Adaptive: override strategy based on actual entropy ──────────────
function adaptStrategy(baseStrategy, chunkEntropy) {
  // If entropy > 7.5 bits/byte, data is effectively random → don't compress
  if (chunkEntropy > 7.5 && baseStrategy.level > 0) {
    return { ...baseStrategy, level: 0, label: 'store', desc: 'high entropy' };
  }
  // If entropy < 3.0, data is very structured → max compression
  if (chunkEntropy < 3.0 && baseStrategy.level < 9) {
    return { ...baseStrategy, level: 9, label: 'ultra', desc: 'low entropy' };
  }
  return baseStrategy;
}

module.exports = { classify, adaptStrategy, STRATEGY };
