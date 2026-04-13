# Vault Launch Posts — Ready to Copy & Paste

---

## 1. HACKER NEWS (Show HN)

**Post at: Tuesday or Wednesday, 9-10 AM EST**
**URL: https://news.ycombinator.com/submit**

**Title:**
```
Show HN: I built a free storage engine — 667 MB backup shrunk to 50 MB, zero dependencies
```

**URL field:** `https://github.com/yogeshsinghkatoch9/vault-storage`

**Text field (optional, for Show HN you can add context):**
```
I was paying $15/month for cloud storage and realized most of my data was redundant — duplicate files, near-identical versions, node_modules, caches. So I built Vault.

What it does:
- Splits files using content-defined chunking (Gear rolling hash)
- Deduplicates at the sub-file level — edit one line in a 10 MB file, only the changed chunk is stored again
- Detects 80+ file types and picks the right compression strategy (max compression on text, skips already-compressed JPEG/MP4)
- AES-256-GCM encryption with PBKDF2 key derivation
- P2P sync across devices on the same LAN (zero config, UDP discovery)
- Web UI with drag-and-drop, runs as a PWA on mobile

Real result on my project backup: 667 MB → 50 MB (13.3x). Extraction at 392 MB/s. SHA-256 verified on every file.

Zero npm dependencies. Just Node.js built-ins (crypto, zlib, fs, net, dgram). 66 tests passing.

npm install -g vault-storage && vault init && vault add myfiles/

MIT licensed. Would love feedback on the chunking strategy and what features would make this useful for you.
```

---

## 2. REDDIT POSTS

### r/selfhosted

**Title:**
```
I built a free, self-hosted storage engine that compressed my 667 MB backup down to 50 MB. No cloud. No subscription. No dependencies.
```

**Body:**
```
I got tired of paying for cloud storage when most of my data was duplicate junk. So I built Vault — a local storage engine that:

- **Deduplicates** at the chunk level — if two files share 90% of their content, only the 10% difference is stored
- **Compresses smart** — max compression on text/code, skips already-compressed media (doesn't waste CPU re-compressing your JPEGs)
- **Encrypts** with AES-256-GCM — password-protected, zero-knowledge
- **Syncs P2P** — two machines on the same network auto-discover and share chunks. No server needed.
- **Web UI** — drag-and-drop, dark theme, runs on your phone as a PWA

Real numbers on a project backup:
- Before: 667 MB
- After: 50 MB
- Ratio: 13.3:1
- Extraction speed: 392 MB/s

It's a single `npm install`, zero dependencies, runs entirely on your machine.

GitHub: https://github.com/yogeshsinghkatoch9/vault-storage

MIT licensed. Been working on this for a while and finally made it public. What features would make this useful for your self-hosted setup?
```

### r/datahoarder

**Title:**
```
Built a dedup + compression engine: 667 MB → 50 MB using content-defined chunking. Free, open source.
```

**Body:**
```
For the fellow datahoarders who obsess over storage efficiency:

I built Vault, a content-addressable storage engine that uses FastCDC-inspired chunking with a Gear rolling hash to deduplicate at the sub-file level.

**How it works:**
- Files are split at content-determined boundaries (not fixed offsets), so inserting a byte mid-file doesn't destroy all your dedup
- Every chunk is SHA-256 addressed — identical regions across ANY files in the vault are stored once
- 80+ file types detected via magic bytes — text gets gzip-9, already-compressed media stored raw
- Per-chunk entropy measurement — if a chunk looks random (>7.5 bits/byte), skip compression

**Results on real data:**
- Project backup: 667 MB → 50 MB (13.3x)
- Exact duplicate file: 100% dedup (0 new bytes)
- Near-duplicate (small edit): 90% dedup (only changed chunks stored)
- Extraction: 392 MB/s with SHA-256 verification

Also has AES-256-GCM encryption and P2P LAN sync.

Zero dependencies, Node.js only, MIT license.

https://github.com/yogeshsinghkatoch9/vault-storage

Curious what ratios you'd see on your hoards. Happy to answer questions about the chunking implementation.
```

### r/opensource

**Title:**
```
I open-sourced Vault — a storage engine that saves 60-90% disk space. Free alternative to paying for cloud storage.
```

**Body:**
```
Just made Vault public. It's a storage engine that deduplicates, compresses, and encrypts your files locally — no cloud, no subscription.

**Why I built it:** I was paying $15/month for Google Drive and realized most of what I stored was redundant. Vault uses content-defined chunking to find and eliminate that redundancy.

**What makes it different from ZIP/7z:**
- Sub-file deduplication — two similar files share chunks, not compressed independently
- Smart compression — detects file type, doesn't waste CPU on JPEGs
- Single-file extraction in milliseconds, not "unpack entire archive"
- Web UI with drag-and-drop
- AES-256 encryption
- P2P sync between devices

**Real result:** 667 MB → 50 MB on a project backup.

Zero dependencies, MIT license, 66 tests passing.

`npm install -g vault-storage`

https://github.com/yogeshsinghkatoch9/vault-storage

Stars appreciated — trying to reach people who are overpaying for storage.
```

### r/node

**Title:**
```
Vault: zero-dependency storage engine in Node.js — CDC chunking, dedup, AES-256, P2P sync, web UI. 667 MB → 50 MB.
```

**Body:**
```
Built this entirely with Node.js built-ins — no npm dependencies at all. Uses:

- `crypto` — SHA-256 hashing, AES-256-GCM encryption, PBKDF2
- `zlib` — gzip compression with adaptive levels
- `fs` — streaming file I/O with content-defined chunking
- `net` + `dgram` — P2P sync (TCP transfer + UDP LAN discovery)
- `http` — web UI server (serves a PWA)

**The interesting technical bits:**

1. **Gear rolling hash for CDC** — splits files at content-determined boundaries instead of fixed offsets. When you edit a file, only the changed chunks get new hashes. ~90% dedup preserved on near-duplicates.

2. **Adaptive compression per chunk** — measures Shannon entropy of each chunk. High entropy (>7.5 bits/byte) = already compressed, store raw. Low entropy (<3.0) = very structured, gzip-9. Saves tons of CPU on mixed workloads.

3. **Magic byte detection** — reads first 16 bytes to classify files before choosing compression strategy. 80+ extensions mapped as fallback.

4. **Minimal ZIP builder** — built a zero-dependency ZIP writer for the "extract folder as ZIP" feature. Just the PKZIP spec, no libraries.

66 tests, 392 MB/s extraction throughput.

https://github.com/yogeshsinghkatoch9/vault-storage

Would love code review feedback. The CDC implementation is in `src/chunker.js` (~80 lines).
```

### r/privacy

**Title:**
```
Built a free, encrypted, local-only storage engine. Your data never leaves your machine. AES-256-GCM + zero-knowledge.
```

**Body:**
```
Vault is a storage engine that keeps your files local, compressed, deduplicated, and encrypted.

**Privacy features:**
- AES-256-GCM encryption on every chunk
- PBKDF2 key derivation (100,000 iterations, SHA-512)
- Password never stored on disk — exists only in memory during operations
- Zero network calls (unless you opt into P2P LAN sync)
- No telemetry, no analytics, no accounts
- Fully open source (MIT) — read every line of code
- SHA-256 integrity verification on every extraction

**Why it matters:** Cloud storage providers scan your files, hold your encryption keys, and charge you monthly for the privilege. Vault is the alternative — your data stays on your hardware, encrypted with a key only you know.

Also happens to compress well: 667 MB → 50 MB using smart deduplication and file-type-aware compression.

https://github.com/yogeshsinghkatoch9/vault-storage

`npm install -g vault-storage && vault init -p "your-password"`

No accounts. No cloud. No fees. Ever.
```

---

## 3. DEV.TO BLOG POST

**Publish at: https://dev.to/new**

**Title:**
```
I stopped paying for cloud storage. Here's the open-source tool I built instead.
```

**Tags:** `opensource`, `node`, `storage`, `webdev`

**Cover image suggestion:** Screenshot of the web UI with the 13.3:1 ratio visible

**Body (Markdown):**

```markdown
## The $180/year problem

I was paying $15/month for Google Drive. Not because I had a lot of data — but because my data was full of waste.

Duplicate files. Near-identical versions of the same document. `node_modules` folders I'd backed up by accident. Photos I'd copied three times to "make sure they were safe."

One day I looked at a 667 MB project backup and thought: how much of this is actually unique?

The answer: **about 50 MB.** The other 617 MB was redundancy.

So I built a tool to fix it.

## What Vault does

Vault is a storage engine that runs on your machine. No cloud. No subscription. You give it files, it stores them efficiently, and gives them back byte-for-byte identical when you ask.

```bash
npm install -g vault-storage
vault init
vault add my-project-backup/
vault info
```

```
◆ VAULT
─────────────────────────────────────────────
files:           1,247
original size:   667.4 MB
stored size:     50.0 MB
ratio:           13.3:1
savings:         92.5%
```

92.5% savings. Same files. No quality loss. No data loss. Every file SHA-256 verified on extraction.

## How it works (the short version)

Three techniques, layered:

### 1. Content-defined chunking

Instead of storing whole files, Vault splits them into variable-size chunks using a rolling hash. The split points are determined by the content itself — not fixed byte offsets.

Why this matters: if you edit one paragraph in a 10 MB document, traditional backups store a whole new 10 MB copy. Vault stores only the ~32 KB chunk that changed.

### 2. Smart deduplication

Every chunk is identified by its SHA-256 hash. Same content = same hash = stored once.

If you have 100 copies of `package-lock.json` across different projects, Vault stores it once. If you have 50 versions of a report where only the last page changed, Vault stores the shared pages once.

### 3. File-type-aware compression

Vault detects 80+ file types via magic bytes and picks the right strategy:

- **Text/code/JSON/CSV:** Maximum compression (gzip level 9). These compress 5-20x.
- **JPEG/MP4/MP3:** Stored raw. They're already compressed — re-compressing wastes CPU and makes them bigger.
- **Everything else:** Measures actual entropy per chunk. High entropy = store raw. Low entropy = compress hard.

This sounds simple, but most tools don't do it. ZIP compresses your JPEGs and gains nothing. Vault doesn't.

## The full feature set

I kept building after the core engine worked:

- **Web UI** — drag-and-drop browser interface. Dark theme. Works as a PWA on mobile.
- **Encryption** — AES-256-GCM with PBKDF2 key derivation. Password never stored on disk.
- **P2P sync** — two machines on the same network auto-discover and sync. No server.
- **Folder ZIP export** — download your entire vault as a ZIP preserving full directory structure.
- **SHA-256 verification** — every extraction is cryptographically verified.

And it has **zero npm dependencies**. Just Node.js built-in modules.

## Why not just use Google Drive?

| | Google Drive | Vault |
|---|---|---|
| Cost | $180/year for 2 TB | Free |
| Privacy | Google scans your files | Data never leaves your machine |
| Encryption | They hold the keys | AES-256, only you have the password |
| Compression | None — 1 GB stored = 1 GB billed | 60-90% savings |
| Speed | Network-bound | 392 MB/s local |
| Lock-in | Yes | Open source, MIT |

## Why not just use ZIP?

ZIP compresses each file independently. It doesn't deduplicate across files. It doesn't know that your JPEG is already compressed. It can't extract a single file without touching the whole archive.

Vault does all of these.

## The numbers

| Metric | Result |
|---|---|
| Real backup (667 MB) | **50 MB stored (13.3x)** |
| Exact duplicate file | **0 new bytes stored** |
| Near-duplicate (small edit) | **90% chunks shared** |
| Extraction speed | **392 MB/s** |
| Test suite | **66/66 passing** |
| Dependencies | **Zero** |

## Try it

```bash
npm install -g vault-storage
vault init
vault add some-folder/
vault info
vault serve  # web UI at localhost:3777
```

GitHub: [github.com/yogeshsinghkatoch9/vault-storage](https://github.com/yogeshsinghkatoch9/vault-storage)

MIT licensed. Free forever.

If this saves you disk space (or money), a GitHub star helps other people find it.

---

*Stop paying for storage. Your data belongs to you.*
```

---

## 4. TWITTER/X THREAD

**Tweet 1 (the hook):**
```
I was paying $180/year for Google Drive.

Then I realized 90% of my data was redundant — duplicates, near-identical versions, caches.

So I built a free, open-source storage engine:

667 MB → 50 MB. 13.3x compression. Zero dependencies.

🧵 How it works:
```

**Tweet 2:**
```
The trick: content-defined chunking.

Instead of storing whole files, Vault splits them into variable-size chunks based on content.

Edit one paragraph in a 10 MB document?

Traditional backup: stores a new 10 MB copy.
Vault: stores only the ~32 KB chunk that changed.
```

**Tweet 3:**
```
Then: deduplication.

Every chunk is identified by its SHA-256 hash.

Same content = same hash = stored once.

100 copies of package-lock.json across projects?
Stored once.

50 versions of a report with small edits?
Shared pages stored once.
```

**Tweet 4:**
```
Then: smart compression.

Vault detects 80+ file types and picks the right strategy:

- Text/JSON/CSV → max compression (5-20x)
- JPEG/MP4/MP3 → stored raw (already compressed)
- Unknown → measures entropy per chunk

Most tools waste CPU re-compressing your JPEGs. Vault doesn't.
```

**Tweet 5:**
```
Also built in:

- AES-256 encryption (password never stored on disk)
- P2P sync over LAN (zero config)
- Web UI with drag-and-drop
- Works as a PWA on your phone
- SHA-256 verified extraction
- Zero npm dependencies

All in ~3,800 lines of code.
```

**Tweet 6 (the CTA):**
```
It's free. Open source. MIT license.

npm install -g vault-storage

GitHub: github.com/yogeshsinghkatoch9/vault-storage

If you're tired of paying for storage, give it a try.

Star if it's useful — helps others find it. ⭐
```

---

## 5. PRODUCT HUNT

**Submit at: https://www.producthunt.com/posts/new**
**Best day: Tuesday, launch at 12:01 AM PT**

**Tagline:**
```
Free storage engine that saves 60-90% disk space. No cloud needed.
```

**Description:**
```
Vault is a free, open-source storage engine that compresses, deduplicates, and encrypts your files locally.

Real result: 667 MB of project files → 50 MB stored. 13.3x compression ratio.

It uses content-defined chunking to find and eliminate redundancy across all your files — even across different files that share similar content. Smart file-type detection means it doesn't waste time re-compressing your JPEGs.

Features: AES-256 encryption, P2P sync between devices, web UI with drag-and-drop, SHA-256 verification, zero dependencies.

Stop paying for cloud storage. Your data belongs to you.
```

**Topics:** Developer Tools, Open Source, Privacy, Productivity

---

## POSTING SCHEDULE

| Day | Platform | Time (EST) |
|---|---|---|
| Tuesday | Hacker News (Show HN) | 9:30 AM |
| Tuesday | r/selfhosted | 11:00 AM |
| Tuesday | Twitter/X thread | 12:00 PM |
| Wednesday | r/opensource + r/node | 10:00 AM |
| Wednesday | r/datahoarder + r/privacy | 2:00 PM |
| Thursday | dev.to blog post | 9:00 AM |
| Next Tuesday | Product Hunt launch | 12:01 AM PT |

**Rule: Don't post everywhere on the same day.** Spread it out so each post gets individual attention and you can respond to comments.
