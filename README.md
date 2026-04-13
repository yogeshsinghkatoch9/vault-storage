# vault

Content-addressable storage engine. Tiny key file controls massive data. Zero dependencies.

Vault splits files into content-defined chunks, deduplicates identical regions across your entire collection, compresses intelligently based on file type, and stores everything in a tamper-proof SHA-256 verified archive. One small `vault.key` file is all you need to reconstruct everything.

## Install

```bash
npm install -g vault-engine
```

Or clone and link locally:

```bash
git clone https://github.com/user/vault-engine.git
cd vault-engine
npm link
```

Requires Node.js >= 18. Zero npm dependencies.

## CLI Commands

### Initialize a vault

```bash
vault init
```

Creates `vault.key` and `.vault/chunks/` in the current directory.

### Store files

```bash
vault add report.pdf
vault add photos/                  # recursive directory
vault add data.csv --as backup/data.csv   # custom virtual path
```

### Extract files

```bash
vault get report.pdf
vault get report.pdf --out ~/Desktop/report.pdf
```

Every extraction is SHA-256 verified. If a single byte is wrong, extraction fails.

### List stored files

```bash
vault ls                           # all files
vault ls "\.pdf$"                  # regex filter
```

### Vault statistics

```bash
vault info
```

Shows file count, original vs stored size, compression ratio, dedup savings, and per-category breakdown.

### Remove a file

```bash
vault rm report.pdf
```

Automatically garbage-collects orphaned chunks.

### Verify integrity

```bash
vault verify
```

Checks every file's chunks exist on disk. Returns non-zero exit code if any are missing.

### Web UI

```bash
vault serve
vault serve --port 8080
```

Opens a browser-based dashboard at `http://localhost:3777` with drag-and-drop upload, file listing, extraction, deletion, live stats, compression ratio display, and category breakdown.

The web UI has a dark minimal design with an amber accent. The top bar shows file count, original size, stored size, and space saved. The sidebar contains the drop zone, compression ratio, classification breakdown, and dedup stats. The main panel lists all stored files with badges for their detected type.

### P2P Sync

```bash
vault sync                         # start discovery + sync
vault sync status                  # show peers and sync state
```

Discovers other vault instances on the local network and synchronizes chunks bidirectionally. Press Ctrl+C to stop.

### Encryption

Create an encrypted vault by passing a password:

```bash
vault init -p "mypassword"
vault add secrets.pdf -p "mypassword"
vault get secrets.pdf -p "mypassword" --out ~/Desktop/secrets.pdf
```

Every chunk is encrypted with AES-256-GCM before being written to disk. Without the password, the chunks are unreadable.

### Using a different vault location

All commands accept `--dir <path>`:

```bash
vault --dir /mnt/backup init
vault --dir /mnt/backup add ~/Documents/
vault --dir /mnt/backup ls
```

## Architecture

```
                         vault CLI / Web UI
                               |
                    +----------+-----------+
                    |                      |
               Vault Engine           Sync Engine
               (src/engine.js)        (src/sync.js)
                    |                      |
          +---------+---------+       UDP broadcast
          |         |         |       (discovery)
       Chunker  Classifier  Crypto        +
       (CDC)    (magic/ext)  (AES)    TCP transfer
          |         |         |       (delta sync)
          +----+----+----+----+
               |
        .vault/chunks/
        ab/cd/abcd...ef.chunk
```

### On-disk layout

```
my-project/
  vault.key                     # gzipped manifest (tiny)
  .vault/
    chunks/
      ab/
        cd/
          abcdef...42.chunk     # [1-byte flag][compressed data]
          abcdef...99.chunk
      3f/
        a1/
          3fa1bc...de.chunk
```

- `vault.key`: 16-byte header (`VAULT02\0` magic + version) followed by gzip-compressed JSON manifest. Contains file metadata, chunk references, and classification info. This single file is all you need to back up.
- `.vault/chunks/`: content-addressed chunk store. Two levels of directory sharding (first 2 + next 2 hex chars) prevent filesystem bottlenecks. Each chunk file has a 1-byte flag (`0x00` = raw, `0x01` = gzipped) followed by the data.

## How CDC Chunking Works

Vault uses **FastCDC-inspired content-defined chunking** with a Gear rolling hash.

Instead of splitting files at fixed byte boundaries (which breaks dedup when you insert a single byte), CDC finds split points based on the file's actual content. A rolling hash slides over each byte; when the hash matches a bitmask, that becomes a chunk boundary.

```
Fixed chunking:    |----32KB----|----32KB----|----32KB----|
                   insert 1 byte here ^
                   Every chunk after the insert changes. 0% dedup.

CDC chunking:      |--var--|----var----|---var---|--var--|
                   insert 1 byte here ^
                   Only the affected chunk changes. ~95% dedup.
```

Vault's implementation uses a two-phase approach:
- **Phase 1** (below average size): strict bitmask -- prefers larger chunks
- **Phase 2** (above average): loose bitmask -- splits sooner to avoid huge chunks

Target: 8 KB min, 32 KB average, 128 KB max. This balances dedup granularity against chunk management overhead.

## How Smart Classification Works

Every file is classified before storage using a two-layer detection system:

1. **Magic bytes**: reads the first 16 bytes and matches against known signatures (JPEG `FF D8 FF`, PNG `89 50 4E 47`, ZIP `50 4B 03 04`, MP4 `ftyp` at offset 4, etc.)
2. **Extension fallback**: maps 80+ extensions to categories

Categories and their compression strategies:

| Category | Strategy | Level | Examples |
|---|---|---|---|
| `text` | ultra | 9 | .js, .py, .csv, .json, .md |
| `media-compressed` | store | 0 | .jpg, .mp4, .mp3, .webp |
| `media-lossless` | light | 3 | .png, .flac |
| `media-raw` | standard | 6 | .bmp, .wav, .psd, .raw |
| `archive` | store | 0 | .zip, .gz, .7z, .docx |
| `document` | standard | 6 | .pdf, .doc |
| `binary` | standard | 6 | .exe, .dll, .wasm |

An **adaptive entropy check** overrides the base strategy per-chunk:
- Entropy > 7.5 bits/byte (effectively random) -> store raw, skip gzip
- Entropy < 3.0 bits/byte (highly structured) -> max compression

This means a PDF with an embedded JPEG won't waste CPU trying to recompress the image data.

## How Dedup Saves Space

Content-addressable storage means every chunk is identified by its SHA-256 hash. If two files (or two versions of the same file) share identical regions, those regions produce identical chunks with the same hash, and only one copy is stored.

```
report-v1.pdf   -->  [chunk A] [chunk B] [chunk C]
report-v2.pdf   -->  [chunk A] [chunk B] [chunk D]
                       ^same     ^same     ^new

Stored on disk: A, B, C, D  (3 unique chunks saved vs 6 total refs)
```

This works at the sub-file level. If you store 100 versions of a document where only the last page changes, vault stores the shared body once. CDC chunking makes this work even when edits happen in the middle of a file.

Exact duplicates (same file, different name) store zero new chunks.

## How Encryption Works

Vault uses **AES-256-GCM** authenticated encryption.

- **Key derivation**: PBKDF2 with 100,000 iterations of SHA-512 turns a password + 256-bit random salt into a 256-bit key
- **Encryption**: Each operation gets a fresh 96-bit IV (NIST recommended for GCM). Output format: `[IV (12 bytes)][Auth Tag (16 bytes)][Ciphertext]`
- **Authentication**: GCM mode provides built-in integrity. If any bit is tampered with, decryption fails with an explicit error rather than producing corrupt output
- **No key storage**: The encryption key is never written to disk. It exists only in memory during operations

The crypto module (`src/crypto.js`) exposes `encrypt`, `decrypt`, `deriveKey`, and `generateSalt`.

## How P2P Sync Works

Vault instances discover each other on the local network and synchronize automatically.

**Discovery** (UDP port 3778):
- Every 5 seconds, each vault broadcasts a beacon containing its vault ID, hostname, and a manifest hash
- When a vault sees a beacon with a different manifest hash, it knows the other side has changes

**Sync protocol** (TCP port 3779):
1. Connect to discovered peer
2. Exchange chunk hash lists (manifests)
3. Compute delta: which chunks does each side lack?
4. Transfer only the missing chunks in batches of 50
5. Update both manifests

Key properties:
- **Bidirectional**: both sides send and receive missing chunks
- **Chunk-level delta**: only transfers data the other side doesn't have
- **Resumable**: if the connection drops, the next beacon triggers a fresh delta calculation that picks up where it left off
- **Safe**: never overwrites existing chunks, only adds new ones
- **Zero config**: no IP addresses to enter, no pairing codes -- just run `vault sync` on two machines on the same network

Peers that haven't sent a beacon in 20 seconds are considered offline.

## Running Tests

```bash
npm test
```

The test suite creates a temporary vault, stores files of every category (text, JSON, CSV, JPEG, MP4, PNG, ZIP, empty, exact duplicates, near-duplicates), verifies classification, compression strategy selection, dedup, byte-perfect extraction with SHA-256 verification, statistics, removal with GC, and throughput benchmarking.

## License

MIT
