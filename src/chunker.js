'use strict';

const crypto = require('crypto');

// Gear hash lookup table (deterministic PRNG)
const GEAR = new Uint32Array(256);
let _s = 0x5A5A5A5A;
for (let i = 0; i < 256; i++) {
  _s = (Math.imul(_s, 1103515245) + 12345) >>> 0;
  GEAR[i] = _s;
}

// ─── Content-Defined Chunking (FastCDC-inspired) ──────────────────────
// Splits data at content-determined boundaries using Gear rolling hash.
// Identical regions across different files produce identical chunks → dedup.

function chunkBuffer(buffer, opts = {}) {
  const min = opts.minSize || 8192;       // 8 KB minimum
  const avg = opts.avgSize || 32768;      // 32 KB average target
  const max = opts.maxSize || 131072;     // 128 KB maximum
  const avgBits = Math.round(Math.log2(avg));
  const maskS = (1 << (avgBits + 2)) - 1; // strict (below avg → prefer bigger)
  const maskL = (1 << (avgBits - 2)) - 1; // loose  (above avg → split sooner)

  const chunks = [];
  let pos = 0;

  while (pos < buffer.length) {
    const remaining = buffer.length - pos;
    if (remaining <= min) {
      chunks.push(buffer.subarray(pos));
      break;
    }

    let i = pos + min;
    let h = 0;

    // Phase 1: min → avg — use strict mask (bigger chunks)
    const p1End = Math.min(pos + avg, buffer.length);
    while (i < p1End) {
      h = ((h << 1) + GEAR[buffer[i]]) >>> 0;
      if ((h & maskS) === 0) break;
      i++;
    }

    // Phase 2: avg → max — use loose mask (split sooner)
    if (i >= p1End) {
      const p2End = Math.min(pos + max, buffer.length);
      while (i < p2End) {
        h = ((h << 1) + GEAR[buffer[i]]) >>> 0;
        if ((h & maskL) === 0) break;
        i++;
      }
    }

    const end = Math.min(i + 1, buffer.length);
    chunks.push(Buffer.from(buffer.subarray(pos, end)));
    pos = end;
  }

  return chunks;
}

// ─── Entropy estimation (bits per byte, max 8.0) ─────────────────────
function entropy(buf) {
  if (buf.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) freq[buf[i]]++;
  let h = 0;
  const n = buf.length;
  for (let i = 0; i < 256; i++) {
    if (!freq[i]) continue;
    const p = freq[i] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// ─── SHA-256 ──────────────────────────────────────────────────────────
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { chunkBuffer, entropy, sha256 };
