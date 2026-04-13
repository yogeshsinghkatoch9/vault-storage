'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const Vault = require('./engine');

// ─── Minimal ZIP builder (zero dependencies) ─────────────────────────
// Builds a valid ZIP archive in memory from an array of {name, data} entries
function buildZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const compressed = data; // store method (no compression — data is already compressed in vault)

    // Local file header
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // compression: store
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc, 14);          // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // filename length
    local.writeUInt16LE(0, 28);            // extra field length
    nameBuffer.copy(local, 30);

    localHeaders.push(Buffer.concat([local, compressed]));

    // Central directory header
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);            // flags
    central.writeUInt16LE(0, 10);           // compression: store
    central.writeUInt16LE(0, 12);           // mod time
    central.writeUInt16LE(0, 14);           // mod date
    central.writeUInt32LE(crc, 16);         // crc32
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);           // extra field length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk number
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);      // local header offset
    nameBuffer.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((s, b) => s + b.length, 0);

  // End of central directory
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirSize, 12);
  end.writeUInt32LE(centralDirOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...centralHeaders, end]);
}

// CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── PWA Manifest ──────────────────────────────────────────────────
const MANIFEST = JSON.stringify({
  name: 'Vault',
  short_name: 'Vault',
  description: 'Encrypted content-aware file vault with deduplication',
  start_url: '/',
  display: 'standalone',
  background_color: '#0a0a0f',
  theme_color: '#0a0a0f',
  orientation: 'any',
  icons: [
    {
      src: 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
        '<rect fill="#0a0a0f" width="512" height="512" rx="96"/>' +
        '<text y="340" x="256" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="280" font-weight="300" fill="#ffc864">V</text>' +
        '</svg>'
      ),
      sizes: '512x512',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
    {
      src: 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
        '<rect fill="#0a0a0f" width="192" height="192" rx="36"/>' +
        '<text y="128" x="96" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="108" font-weight="300" fill="#ffc864">V</text>' +
        '</svg>'
      ),
      sizes: '192x192',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
  ],
});

function startServer(vaultDir, port = 3777) {
  const vault = new Vault(vaultDir);

  // Ensure vault exists
  if (!fs.existsSync(vault.keyPath)) vault.init();
  else vault.open();

  const htmlPath = path.join(__dirname, 'web', 'index.html');
  const swPath = path.join(__dirname, 'web', 'sw.js');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // ─── Serve UI ──────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(htmlPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }

      // ─── Serve Service Worker ──────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/sw.js') {
        const sw = fs.readFileSync(swPath);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          // SW must not be cached aggressively — browsers check for updates
          'Cache-Control': 'no-cache',
          // Service worker scope — root
          'Service-Worker-Allowed': '/',
        });
        res.end(sw);
        return;
      }

      // ─── Serve PWA Manifest ────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/manifest.json') {
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(MANIFEST);
        return;
      }

      // ─── API: list files ───────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/list') {
        json(res, vault.ls(url.searchParams.get('q')));
        return;
      }

      // ─── API: stats ────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        json(res, vault.stats());
        return;
      }

      // ─── API: verify ───────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/verify') {
        json(res, vault.verify());
        return;
      }

      // ─── API: add file ─────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/add') {
        const filename = decodeURIComponent(req.headers['x-filename'] || 'upload');
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const tmp = path.join(os.tmpdir(), 'vault-' + Date.now() + '-' + path.basename(filename));
          try {
            fs.writeFileSync(tmp, body);
            const results = vault.add(tmp, filename);
            json(res, { ok: true, results, stats: vault.stats() });
          } catch (e) {
            json(res, { ok: false, error: e.message }, 500);
          } finally {
            try { fs.unlinkSync(tmp); } catch (_) {}
          }
        });
        return;
      }

      // ─── API: extract folder/all as ZIP ────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/extract-zip') {
        const prefix = url.searchParams.get('prefix') || '';
        const t0 = performance.now();
        const files = vault.ls();
        const matching = prefix
          ? files.filter(f => f.path.startsWith(prefix))
          : files;

        if (matching.length === 0) {
          json(res, { error: 'No files found' + (prefix ? ' with prefix: ' + prefix : '') }, 404);
          return;
        }

        const entries = [];
        for (const f of matching) {
          const tmp = path.join(os.tmpdir(), 'vault-zip-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          try {
            vault.get(f.path, tmp);
            entries.push({ name: f.path, data: fs.readFileSync(tmp) });
          } finally {
            try { fs.unlinkSync(tmp); } catch (_) {}
          }
        }

        const zipData = buildZip(entries);
        const dt = performance.now() - t0;
        const zipName = prefix ? prefix.replace(/\//g, '-').replace(/-$/, '') + '.zip' : 'vault-export.zip';

        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'Content-Length': zipData.length,
          'X-Extract-Ms': dt.toFixed(1),
          'X-Files-Count': matching.length,
        });
        res.end(zipData);
        return;
      }

      // ─── API: storage info ─────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/api/storage-info') {
        const vaultDir = path.resolve(vault.dir);
        const chunksDir = vault.chunksDir;

        // Count chunk files
        let chunkFiles = 0;
        let chunkBytes = 0;
        const walkChunks = (dir) => {
          if (!fs.existsSync(dir)) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walkChunks(full);
            else { chunkFiles++; chunkBytes += fs.statSync(full).size; }
          }
        };
        walkChunks(chunksDir);

        json(res, {
          vaultDir,
          keyFile: vault.keyPath,
          keySize: fs.statSync(vault.keyPath).size,
          chunksDir,
          chunkFiles,
          chunkBytes,
          totalOnDisk: fs.statSync(vault.keyPath).size + chunkBytes,
        });
        return;
      }

      // ─── API: extract file ─────────────────────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/api/extract/')) {
        const vpath = decodeURIComponent(url.pathname.slice('/api/extract/'.length));
        const tmp = path.join(os.tmpdir(), 'vault-ext-' + Date.now());
        const t0 = performance.now();
        const result = vault.get(vpath, tmp);
        const dt = performance.now() - t0;
        const data = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        const ext = path.extname(vpath).toLowerCase();
        const mime = MIMES[ext] || 'application/octet-stream';

        // If request accepts inline (for preview), don't force download
        const wantsInline = (req.headers['accept'] || '').includes('text/html') ||
                            (req.headers['sec-fetch-dest'] === 'image');
        const disposition = wantsInline ? 'inline' : `attachment; filename="${path.basename(vpath)}"`;

        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': data.length,
          'X-Extract-Ms': dt.toFixed(1),
          'X-Verified': 'sha256',
          'Cache-Control': 'private, max-age=300',
        });
        res.end(data);
        return;
      }

      // ─── API: remove file ──────────────────────────────────────
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/rm/')) {
        const vpath = decodeURIComponent(url.pathname.slice('/api/rm/'.length));
        const result = vault.rm(vpath);
        json(res, { ok: true, ...result, stats: vault.stats() });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`\n \x1b[33m\u25C6\x1b[0m vault web UI: \x1b[36mhttp://localhost:${port}\x1b[0m`);
    console.log(` \x1b[33m\u25C6\x1b[0m vault dir:    \x1b[36m${vaultDir}\x1b[0m\n`);
  });

  return server;
}

function json(res, data, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

const MIMES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.pdf': 'application/pdf', '.xml': 'text/xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.md': 'text/markdown', '.yaml': 'text/yaml', '.yml': 'text/yaml',
};

module.exports = { startServer };
