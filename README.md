<p align="center">
  <h1 align="center">vault</h1>
  <p align="center"><strong>Free, open-source storage engine that saves you 60-90% disk space.</strong></p>
  <p align="center">Content-defined chunking &middot; Smart deduplication &middot; AES-256 encryption &middot; P2P sync &middot; Web UI</p>
  <p align="center">
    <a href="https://vault-storage.onrender.com"><strong>Live Demo &rarr;</strong></a>
  </p>
  <p align="center">
    <a href="#install">Install</a> &middot;
    <a href="#why-vault">Why Vault</a> &middot;
    <a href="#benchmarks">Benchmarks</a> &middot;
    <a href="#usage">Usage</a> &middot;
    <a href="#how-it-works">How It Works</a> &middot;
    <a href="#license">License</a>
  </p>
</p>

---

## The Problem

You're paying $10-20/month for cloud storage. Your hard drive is full. External drives pile up. And **90% of what you're storing is redundant** — duplicate files, near-identical versions, app caches, backups of backups.

Vault fixes this. For free. Forever.

## What Vault Does

```
667 MB of project files  -->  vault add .  -->  50 MB stored  (13.3x compression)
```

Drop any files or folders in. Vault automatically:

1. **Detects file types** — knows a JPEG from a CSV from a Python script
2. **Splits intelligently** — content-defined chunks that detect shared regions across files
3. **Deduplicates** — identical chunks stored once, even across different files
4. **Compresses smart** — max compression on text, zero wasted CPU on already-compressed media
5. **Verifies everything** — SHA-256 on every extraction, zero tolerance for data corruption

You get your files back **byte-for-byte identical**, verified, in milliseconds.

## Why Vault

### vs Google Drive / Dropbox / iCloud ($120+/year)

| | Cloud Storage | Vault |
|---|---|---|
| **Cost** | $10-20/month forever | Free. Forever. |
| **Privacy** | They scan your files | Your data never leaves your machine |
| **Encryption** | They hold the keys | AES-256-GCM, only you have the password |
| **Compression** | None — 1 GB stored = 1 GB billed | 60-90% smaller on real-world data |
| **Dedup** | Per-file at best | Sub-file, cross-file, content-aware |
| **Vendor lock-in** | Yes | Open source, MIT license, your data |
| **Offline** | Needs internet | Fully offline |
| **Speed** | Network-bound | 400 MB/s local extraction |

### vs ZIP / 7-Zip / tar.gz

| | ZIP/7z | Vault |
|---|---|---|
| **Deduplication** | None | Content-defined, cross-file |
| **Similar files** | Compressed independently | Shared chunks, only diffs stored |
| **Extract one file** | Unpack entire archive | Instant, single-file extraction |
| **Already-compressed files** | Wastes CPU re-compressing | Detects and stores raw (smart) |
| **Encryption** | ZIP AES is weak | AES-256-GCM with PBKDF2 |
| **Integrity** | CRC32 (weak) | SHA-256 (cryptographic) |
| **Incremental updates** | Rewrite entire archive | Add/remove individual files |
| **Web UI** | None | Full drag-and-drop browser interface |

### vs Git LFS / restic / borg

| | Git LFS / restic / borg | Vault |
|---|---|---|
| **Target user** | Developers / sysadmins | Everyone |
| **Dependencies** | Python, Go runtimes, C libraries | Zero. Just Node.js. |
| **Setup** | Config files, remote repos, SSH keys | `vault init`. Done. |
| **Web UI** | None | Built-in PWA, works on phone |
| **P2P sync** | Needs a server | Zero-config LAN discovery |
| **Single-file extract** | Slow (restore pipeline) | Milliseconds |
| **File type awareness** | None | 80+ types, adaptive compression |
| **Install** | Package managers, compilation | `npm install -g vault-storage` |

### vs Amazon S3 / Azure Blob ($0.023/GB/month)

| | S3 / Azure | Vault |
|---|---|---|
| **1 TB for 1 year** | ~$276 | $0 |
| **10 TB for 5 years** | ~$13,800 | $0 |
| **Egress fees** | $0.09/GB to download YOUR data | Free, it's on your disk |
| **Encryption** | Server-side (they see it) | Client-side, zero-knowledge |
| **Latency** | 50-200ms network | <1ms local |
| **Vendor lock-in** | High | None |
| **Requires internet** | Yes | No |

## Benchmarks

Tested on a real project backup (mixed files: source code, documents, images, configs):

```
Original:     667.4 MB
Vault stored:  50.0 MB
Ratio:         13.3 : 1
Savings:       92.5%
```

Engine performance (66/66 tests passing):

| Metric | Result |
|---|---|
| Extraction speed | **392 MB/s** |
| Extraction time (1 MB file) | **< 3 ms** |
| Dedup (exact duplicate) | **100%** — zero new bytes stored |
| Dedup (near-duplicate, small edit) | **90%** — only changed chunks stored |
| SHA-256 verification | Every extraction, every file |
| File types detected | **80+** via magic bytes + extension |
| Compression strategies | 7 (ultra/high/standard/light/store + 2 adaptive) |

### Compression by file type

| File Type | Typical Ratio | Strategy |
|---|---|---|
| Source code (.js, .py, .ts) | 5-15x | Ultra (gzip level 9) |
| JSON / CSV / XML | 8-20x | Ultra |
| Plain text / Markdown / Logs | 4-10x | Ultra |
| PDF documents | 1.1-2x | Standard |
| JPEG / MP4 / MP3 | 1:1 (stored raw) | Skip — already compressed |
| PNG / FLAC | 1.05-1.2x | Light |
| ZIP / DOCX / XLSX | 1:1 (stored raw) | Skip — already archived |
| Mixed project folders | **5-15x** | Adaptive per-chunk |

## Install

```bash
npm install -g vault-storage
```

Or clone and link:

```bash
git clone https://github.com/yogeshsinghkatoch9/vault-storage.git
cd vault-storage
npm link
```

**Requirements:** Node.js >= 18. Zero npm dependencies.

## Usage

### Quick Start

```bash
# Create a vault
vault init

# Store files
vault add myfiles/

# See what's stored
vault ls

# Check compression stats
vault info

# Extract a file
vault get myfiles/report.pdf

# Launch web UI
vault serve
```

### All Commands

| Command | Description |
|---|---|
| `vault init` | Create a new vault in current directory |
| `vault add <file\|dir>` | Store files (recursive for directories) |
| `vault get <path> [--out dest]` | Extract a single file |
| `vault ls [pattern]` | List files (supports regex filter) |
| `vault info` | Vault statistics + compression breakdown |
| `vault rm <path>` | Remove a file (auto garbage-collects chunks) |
| `vault verify` | Verify SHA-256 integrity of all files |
| `vault serve [--port N]` | Launch web UI (default: port 3777) |
| `vault scan <dir>` | Disk X-Ray — find duplicates and wasted space |
| `vault watch <dir> [dir2...]` | Auto-backup — monitor folders for changes |
| `vault sync` | Start P2P sync (LAN auto-discovery) |

### Encryption

```bash
# Create an encrypted vault
vault init -p "your-password"

# All operations require the password
vault add secrets/ -p "your-password"
vault get secrets/keys.txt -p "your-password"
vault info -p "your-password"
```

- AES-256-GCM authenticated encryption
- PBKDF2 key derivation (100,000 iterations, SHA-512)
- Every chunk encrypted individually
- Password never stored on disk

### Web UI

```bash
vault serve
```

Opens at `http://localhost:3777`. Features:

- Drag-and-drop files and **folders** (recursively reads all contents)
- Auto-skips `node_modules`, `.git`, `__pycache__`, `dist`, `build`, and 15+ other regenerable directories
- Parallel uploads (5 at a time) with progress bar
- Live compression stats, classification breakdown, and storage location
- Per-file extract, delete, and preview (images render inline, text shows first 200 lines)
- **Download entire vault or individual folders as ZIP** — preserves full directory structure
- Folder grouping with per-folder ZIP buttons
- Search, sort (by name, size, date, category), dark/light theme toggle
- Auto-backup panel — start/stop watching a directory from the browser
- Disk X-Ray link — scan any folder for waste
- Mobile-ready PWA — install on your phone's home screen
- Service worker for offline caching
- Batch operations: extract all, delete all

### Disk X-Ray

```bash
vault scan ~/Documents
```

Scans any directory and reports:

- **Total size** and file count
- **Duplicate detection** — finds exact duplicates via partial hash matching (head + tail bytes)
- **Wasted space** — shows how many bytes are wasted on duplicates
- **File type breakdown** — which types consume the most space
- **Largest files** — top 30 biggest files ranked
- **Vault savings estimate** — predicts how much vault would compress your data
- **Web visualization** at `http://localhost:3777/xray` — interactive treemap, type bar chart, duplicate cards

### Auto-Backup Watcher

```bash
vault watch ~/Documents ~/Desktop
```

Monitors directories in real time. When you save, create, or modify any file, it's automatically vaulted — deduplicated, compressed, SHA-256 verified. No manual backup needed.

- Uses `fs.watch` (FSEvents on macOS, inotify on Linux, ReadDirectoryChanges on Windows)
- Recursive directory monitoring — watches subdirectories automatically
- 300ms debounce for rapid saves (prevents duplicate processing)
- Skips `node_modules`, `.git`, and other regenerable directories
- Detects new files, modified files, and new directories
- Live status: files added, updated, errors
- Also available in the web UI sidebar — start/stop from the browser

### P2P Sync

```bash
# On machine A
vault sync

# On machine B (same network)
vault sync
```

Vaults discover each other automatically via UDP broadcast and sync missing chunks over TCP. No server needed. No configuration. Bidirectional, resumable, chunk-level delta.

### Custom Vault Location

```bash
vault --dir /mnt/usb-drive init
vault --dir /mnt/usb-drive add ~/Documents/
vault --dir /mnt/usb-drive serve
```

## How It Works

### Architecture

```
                         vault CLI / Web UI
                               |
              +--------+-------+-------+--------+
              |        |       |       |        |
           Engine   Scanner  Watcher  Sync    Server
              |        |       |       |        |
        +-----+-----+ |    fs.watch  UDP    HTTP +
        |     |     |  |              +      PWA
     Chunker Class Crypto         TCP sync
      (CDC) (magic) (AES)
        |     |     |
        +--+--+--+--+
           |
    .vault/chunks/
    ab/cd/abcd...ef.chunk
```

### Content-Defined Chunking (CDC)

Traditional tools split files at fixed byte boundaries. Insert one byte, and every chunk after it changes — destroying deduplication.

Vault uses a **Gear rolling hash** to find split points based on actual file content:

```
Fixed chunking:    |----32KB----|----32KB----|----32KB----|
                   insert 1 byte here ^
                   Every chunk after changes. 0% dedup.

CDC chunking:      |--var--|----var----|---var---|--var--|
                   insert 1 byte here ^
                   Only the affected chunk changes. ~90% dedup preserved.
```

Two-phase approach: strict bitmask below average size (prefers larger chunks), loose bitmask above (splits sooner to cap maximum size). Target: 8 KB min, 32 KB average, 128 KB max.

### Smart Classification

Every file is classified before storage:

1. **Magic bytes** — reads first 16 bytes, matches known signatures (JPEG `FF D8 FF`, PNG `89 50 4E 47`, MP4 `ftyp`, etc.)
2. **Extension fallback** — 80+ mapped extensions
3. **Entropy measurement** — per-chunk randomness check overrides strategy

Result: text gets maximum compression (gzip 9), already-compressed media is stored raw (zero wasted CPU), and everything in between gets the right level automatically.

### Deduplication

Every chunk is addressed by its SHA-256 hash. Same content = same hash = stored once.

```
report-v1.pdf   -->  [chunk A] [chunk B] [chunk C]
report-v2.pdf   -->  [chunk A] [chunk B] [chunk D]
                       ^same     ^same     ^new

Stored on disk: A, B, C, D  (saved 2 chunks = 33%)
```

This works across ALL files in the vault. 100 versions of a document with small edits? Only the diffs take space.

### On-Disk Format

```
my-project/
  vault.key                     # Manifest (file index + metadata)
  .vault/
    chunks/
      ab/cd/abcdef...42.chunk   # [1-byte flag][payload]
      3f/a1/3fa1bc...de.chunk
```

**vault.key**: 16-byte header + gzip-compressed JSON manifest. This tiny file maps every stored file to its chunks. Back up this one file and you have the index to everything.

**Chunk flags**: `0x00` raw, `0x01` gzipped, `0x02` raw+encrypted, `0x03` gzipped+encrypted.

**Directory sharding**: Two-level hex prefix (`ab/cd/`) prevents filesystem bottlenecks with millions of chunks.

## Project Structure

```
vault-storage/
  bin/vault             CLI (init, add, get, ls, info, rm, verify, serve, scan, watch, sync)
  src/
    engine.js           Core: CDC chunking, dedup, compression, encryption
    chunker.js          Content-defined chunking (Gear rolling hash)
    classifier.js       File type detection (magic bytes + 80+ extensions)
    crypto.js           AES-256-GCM encryption + PBKDF2 key derivation
    scanner.js          Disk X-Ray — duplicate detection, type analysis, savings estimation
    watcher.js          Auto-backup — fs.watch based real-time directory monitor
    sync.js             P2P sync — UDP discovery + TCP chunk transfer
    server.js           HTTP server + PWA manifest + ZIP builder
    web/
      index.html        Full web UI (PWA, drag-drop folders, dark/light, mobile-ready)
      xray.html         Disk X-Ray visualization (treemap, type chart, duplicate cards)
      sw.js             Service worker for offline caching
  test.js               66 tests covering all features
  LICENSE               MIT
```

**Zero external dependencies.** Built entirely on Node.js built-in modules: `crypto`, `zlib`, `fs`, `path`, `http`, `net`, `dgram`, `os`.

## Running Tests

```bash
npm test
```

66 tests covering: initialization, file classification, entropy detection, compression strategy selection, CDC chunking, exact-duplicate dedup, near-duplicate dedup, byte-perfect extraction with SHA-256 verification, statistics, removal with garbage collection, integrity verification, and throughput benchmarking.

## Contributing

Pull requests welcome. The codebase is intentionally simple — single-purpose modules, no abstractions, no build step.

## License

MIT &copy; 2026 Yogesh Singh Katoch

---

<p align="center">
  <strong>Stop paying for storage. Your data belongs to you.</strong>
</p>
