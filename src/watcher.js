'use strict';

const fs = require('fs');
const path = require('path');
const Vault = require('./engine');

// ─── Auto-Backup Watcher ─────────────────────────────────────────────
// Monitors directories for changes and auto-vaults new/modified files.
// Uses fs.watch (inotify on Linux, FSEvents on macOS, ReadDirectoryChanges on Windows).

const SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt', '.cache',
  '.DS_Store', 'Thumbs.db', '.vault', '.svn', '.hg', 'dist', 'build',
  '.venv', 'venv', '.tox', '.pytest_cache', 'bower_components',
]);

class Watcher {
  constructor(vaultDir, password) {
    this.vault = new Vault(vaultDir);
    this.password = password;
    this.watchers = new Map();  // dir → FSWatcher
    this.watchDirs = [];        // dirs being watched
    this.debounce = new Map();  // path → timeout
    this.stats = { added: 0, updated: 0, errors: 0, lastEvent: null };
    this.log = [];
    this._running = false;
  }

  // ── Start watching directories ────────────────────────────────
  start(dirs) {
    if (fs.existsSync(this.vault.keyPath)) {
      this.vault.open(this.password);
    } else {
      this.vault.init(this.password);
    }

    this._running = true;
    this.watchDirs = dirs.map(d => path.resolve(d));

    for (const dir of this.watchDirs) {
      this._watchRecursive(dir, dir);
    }

    this._log(`watching ${this.watchDirs.length} directory(s)`);
    return this;
  }

  stop() {
    this._running = false;
    for (const [, w] of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers.clear();
    this._log('stopped');
  }

  getStatus() {
    return {
      running: this._running,
      watchedDirs: this.watchDirs,
      watcherCount: this.watchers.size,
      ...this.stats,
      recentLog: this.log.slice(-20),
    };
  }

  // ── Recursive directory watcher ───────────────────────────────
  _watchRecursive(dir, baseDir) {
    if (!fs.existsSync(dir)) return;
    if (this.watchers.has(dir)) return;

    try {
      const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
        if (!filename) return;
        if (this._shouldSkip(filename)) return;

        const fullPath = path.join(dir, filename);
        this._debounced(fullPath, () => this._handleChange(fullPath, baseDir));
      });

      watcher.on('error', () => {
        // Directory deleted or permissions changed — clean up
        this.watchers.delete(dir);
      });

      this.watchers.set(dir, watcher);
    } catch (_) {
      // Can't watch this dir (permissions, etc.)
    }

    // Watch subdirectories
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !this._shouldSkip(e.name)) {
          this._watchRecursive(path.join(dir, e.name), baseDir);
        }
      }
    } catch (_) {}
  }

  // ── Handle a file change ──────────────────────────────────────
  _handleChange(fullPath, baseDir) {
    if (!this._running) return;

    let stat;
    try { stat = fs.statSync(fullPath); } catch (_) { return; } // file deleted

    if (stat.isDirectory()) {
      // New directory — start watching it
      this._watchRecursive(fullPath, baseDir);
      return;
    }

    if (!stat.isFile() || stat.size === 0) return;
    if (this._shouldSkip(path.basename(fullPath))) return;

    const virtualPath = path.relative(baseDir, fullPath);

    // Check if file is already in vault with same size
    const existing = this.vault.manifest.files[virtualPath];
    if (existing && existing.size === stat.size && existing.modified === stat.mtimeMs) {
      return; // No change
    }

    try {
      this.vault.add(fullPath, virtualPath);
      if (existing) {
        this.stats.updated++;
        this._log(`updated: ${virtualPath} (${fmtBytes(stat.size)})`);
      } else {
        this.stats.added++;
        this._log(`added: ${virtualPath} (${fmtBytes(stat.size)})`);
      }
      this.stats.lastEvent = Date.now();
    } catch (e) {
      this.stats.errors++;
      this._log(`error: ${virtualPath} — ${e.message}`);
    }
  }

  // ── Debounce rapid changes (300ms) ────────────────────────────
  _debounced(key, fn) {
    if (this.debounce.has(key)) clearTimeout(this.debounce.get(key));
    this.debounce.set(key, setTimeout(() => {
      this.debounce.delete(key);
      fn();
    }, 300));
  }

  _shouldSkip(name) {
    return SKIP.has(name) || name.startsWith('.');
  }

  _log(msg) {
    const entry = { time: Date.now(), msg };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    if (this.onLog) this.onLog(entry);
  }
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

module.exports = { Watcher };
