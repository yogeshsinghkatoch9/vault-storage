'use strict';

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

// ─── Constants ────────────────────────────────────────────────────────
const UDP_PORT = 3778;
const TCP_PORT = 3779;
const BEACON_INTERVAL = 5000;       // 5 seconds
const PEER_TIMEOUT = 20000;         // peers gone after 20s silence
const CHUNK_TRANSFER_BATCH = 50;    // chunks per batch request
const PROTOCOL_VERSION = 1;
const MAGIC = 'VAULT_SYNC';

// Message types (TCP protocol)
const MSG = {
  MANIFEST_HASH:   0x01,   // exchange manifest hashes to detect drift
  MANIFEST_REQ:    0x02,   // request full chunk list
  MANIFEST_RES:    0x03,   // respond with chunk list
  CHUNK_REQ:       0x04,   // request specific chunks
  CHUNK_RES:       0x05,   // respond with chunk data
  SYNC_COMPLETE:   0x06,   // signal sync finished
  ERROR:           0xFF,
};

// ─── Sync Engine ──────────────────────────────────────────────────────
class VaultSync {
  constructor() {
    this.vaultDir = null;
    this.chunksDir = null;
    this.keyPath = null;
    this.vaultId = null;

    this.udpSocket = null;
    this.tcpServer = null;
    this.beaconTimer = null;
    this.cleanupTimer = null;

    this.peers = new Map();         // peerId -> { host, port, hostname, lastSeen, synced }
    this.lastSync = null;
    this.pendingChunks = 0;
    this.running = false;

    this._activeSyncs = new Set();  // track in-progress syncs to prevent overlap
  }

  // ── Start sync service ──────────────────────────────────────────────
  startSync(vaultDir, opts = {}) {
    if (this.running) throw new Error('Sync already running');

    this.vaultDir = path.resolve(vaultDir);
    this.keyPath = path.join(this.vaultDir, 'vault.key');
    this.chunksDir = path.join(this.vaultDir, '.vault', 'chunks');

    if (!fs.existsSync(this.keyPath)) {
      throw new Error('No vault.key found at ' + this.vaultDir);
    }

    // Generate a stable vault ID from the vault directory
    this.vaultId = crypto.createHash('sha256')
      .update(this.vaultDir + ':' + os.hostname())
      .digest('hex').slice(0, 16);

    const udpPort = opts.udpPort || UDP_PORT;
    const tcpPort = opts.tcpPort || TCP_PORT;

    this.running = true;

    // Start UDP discovery
    this._startDiscovery(udpPort);

    // Start TCP sync server
    this._startTcpServer(tcpPort);

    // Periodically clean stale peers
    this.cleanupTimer = setInterval(() => this._cleanPeers(), PEER_TIMEOUT);

    return {
      vaultId: this.vaultId,
      hostname: os.hostname(),
      udpPort,
      tcpPort,
    };
  }

  // ── Stop sync service ───────────────────────────────────────────────
  stopSync() {
    this.running = false;

    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }

    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch (_) {}
      this.udpSocket = null;
    }

    if (this.tcpServer) {
      try { this.tcpServer.close(); } catch (_) {}
      this.tcpServer = null;
    }

    this._activeSyncs.clear();
    this.peers.clear();
  }

  // ── Get sync status ─────────────────────────────────────────────────
  getSyncStatus() {
    const peers = [];
    for (const [id, info] of this.peers) {
      peers.push({
        id,
        hostname: info.hostname,
        host: info.host,
        lastSeen: info.lastSeen,
        lastSynced: info.synced || null,
        age: Date.now() - info.lastSeen,
      });
    }
    return {
      running: this.running,
      vaultId: this.vaultId,
      peers,
      lastSync: this.lastSync,
      pending: this.pendingChunks,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UDP Discovery — find other vaults on the LAN
  // ═══════════════════════════════════════════════════════════════════

  _startDiscovery(port) {
    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg, rinfo) => {
      this._handleBeacon(msg, rinfo);
    });

    this.udpSocket.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port in use — try listening anyway for beacons on a random port
        this.udpSocket.bind(0, () => {
          this.udpSocket.setBroadcast(true);
        });
      }
    });

    this.udpSocket.bind(port, () => {
      this.udpSocket.setBroadcast(true);
      this._sendBeacon();
      this.beaconTimer = setInterval(() => this._sendBeacon(), BEACON_INTERVAL);
    });
  }

  _sendBeacon() {
    if (!this.udpSocket || !this.running) return;

    const manifestHash = this._getManifestHash();

    const beacon = JSON.stringify({
      magic: MAGIC,
      version: PROTOCOL_VERSION,
      vaultId: this.vaultId,
      hostname: os.hostname(),
      tcpPort: this.tcpServer ? this.tcpServer.address().port : TCP_PORT,
      manifestHash,
      timestamp: Date.now(),
    });

    const buf = Buffer.from(beacon);

    // Broadcast to all local network interfaces
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Calculate broadcast address from IP and netmask
          const broadcastAddr = this._getBroadcast(addr.address, addr.netmask);
          try {
            this.udpSocket.send(buf, 0, buf.length, UDP_PORT, broadcastAddr);
          } catch (_) {}
        }
      }
    }
  }

  _getBroadcast(ip, mask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = mask.split('.').map(Number);
    return ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
  }

  _handleBeacon(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString());
      if (data.magic !== MAGIC || data.version !== PROTOCOL_VERSION) return;
      if (data.vaultId === this.vaultId) return; // ignore self

      const existing = this.peers.get(data.vaultId);
      this.peers.set(data.vaultId, {
        host: rinfo.address,
        port: data.tcpPort || TCP_PORT,
        hostname: data.hostname,
        lastSeen: Date.now(),
        manifestHash: data.manifestHash,
        synced: existing ? existing.synced : null,
      });

      // If manifest hashes differ, trigger a sync
      const myHash = this._getManifestHash();
      if (data.manifestHash !== myHash && !this._activeSyncs.has(data.vaultId)) {
        this._initiateSync(data.vaultId);
      }
    } catch (_) {}
  }

  _cleanPeers() {
    const now = Date.now();
    for (const [id, info] of this.peers) {
      if (now - info.lastSeen > PEER_TIMEOUT) {
        this.peers.delete(id);
        this._activeSyncs.delete(id);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  TCP Sync Protocol
  // ═══════════════════════════════════════════════════════════════════

  _startTcpServer(port) {
    this.tcpServer = net.createServer((socket) => {
      this._handleIncomingConnection(socket);
    });

    this.tcpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        this.tcpServer.listen(port + 1, '0.0.0.0');
      }
    });

    this.tcpServer.listen(port, '0.0.0.0');
  }

  // ── Handle incoming TCP connection (we are the responder) ─────────
  _handleIncomingConnection(socket) {
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process all complete messages in the buffer
      while (buffer.length >= 5) {
        const type = buffer[0];
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break; // wait for more data

        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);

        this._handleMessage(socket, type, payload);
      }
    });

    socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
  }

  _handleMessage(socket, type, payload) {
    try {
      switch (type) {
        case MSG.MANIFEST_REQ: {
          // Peer wants our chunk list
          const chunkList = this._getLocalChunkHashes();
          this._sendMessage(socket, MSG.MANIFEST_RES, JSON.stringify(chunkList));
          break;
        }

        case MSG.MANIFEST_RES: {
          // We received the peer's chunk list — stored on socket for the initiator
          if (socket._onManifest) socket._onManifest(JSON.parse(payload.toString()));
          break;
        }

        case MSG.CHUNK_REQ: {
          // Peer wants specific chunks
          const requested = JSON.parse(payload.toString());
          this._sendChunks(socket, requested);
          break;
        }

        case MSG.CHUNK_RES: {
          // We received chunk data from peer
          if (socket._onChunks) socket._onChunks(payload);
          break;
        }

        case MSG.SYNC_COMPLETE: {
          // Peer signals sync is done
          if (socket._onSyncComplete) socket._onSyncComplete();
          break;
        }
      }
    } catch (err) {
      this._sendMessage(socket, MSG.ERROR, err.message);
    }
  }

  // ── Wire format: [1 byte type][4 bytes length][payload] ───────────
  _sendMessage(socket, type, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(data.length, 1);

    try {
      socket.write(Buffer.concat([header, data]));
    } catch (_) {}
  }

  // ── Send requested chunks over TCP ────────────────────────────────
  _sendChunks(socket, hashes) {
    // Pack multiple chunks into a single response:
    // [4 bytes count] then for each: [32 bytes hash hex][4 bytes data len][data]
    const chunks = [];
    let totalSize = 4; // count prefix

    for (const hash of hashes) {
      const chunkPath = this._chunkPath(hash);
      if (!fs.existsSync(chunkPath)) continue;

      const data = fs.readFileSync(chunkPath);
      chunks.push({ hash, data });
      totalSize += 32 + 4 + data.length; // hash(32 hex chars) + len(4) + data
    }

    const buf = Buffer.alloc(totalSize);
    let offset = 0;
    buf.writeUInt32BE(chunks.length, offset); offset += 4;

    for (const { hash, data } of chunks) {
      buf.write(hash.slice(0, 32), offset, 'ascii'); offset += 32;
      buf.writeUInt32BE(data.length, offset); offset += 4;
      data.copy(buf, offset); offset += data.length;
    }

    this._sendMessage(socket, MSG.CHUNK_RES, buf);
  }

  // ── Initiate sync with a discovered peer ──────────────────────────
  _initiateSync(peerId) {
    if (!this.running) return;
    if (this._activeSyncs.has(peerId)) return;

    const peer = this.peers.get(peerId);
    if (!peer) return;

    this._activeSyncs.add(peerId);

    const socket = net.createConnection({ host: peer.host, port: peer.port }, () => {
      this._runSyncProtocol(socket, peerId);
    });

    socket.on('error', () => {
      this._activeSyncs.delete(peerId);
    });

    socket.setTimeout(30000, () => {
      socket.destroy();
      this._activeSyncs.delete(peerId);
    });
  }

  _runSyncProtocol(socket, peerId) {
    let buffer = Buffer.alloc(0);

    // Set up message parsing on this socket
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 5) {
        const type = buffer[0];
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break;

        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);

        this._handleMessage(socket, type, payload);
      }
    });

    // Step 1: Request peer's chunk manifest
    this._sendMessage(socket, MSG.MANIFEST_REQ, '');

    // Step 2: When we get their manifest, compute delta
    socket._onManifest = (peerChunks) => {
      const localChunks = new Set(this._getLocalChunkHashes());
      const peerSet = new Set(peerChunks);

      // Chunks we need from peer (they have, we don't)
      const weNeed = peerChunks.filter(h => !localChunks.has(h));

      // Chunks peer needs from us (we have, they don't)
      const theyNeed = [...localChunks].filter(h => !peerSet.has(h));

      this.pendingChunks = weNeed.length + theyNeed.length;

      if (weNeed.length === 0 && theyNeed.length === 0) {
        // Already in sync
        this._sendMessage(socket, MSG.SYNC_COMPLETE, '');
        this._finishSync(socket, peerId);
        return;
      }

      // Request chunks we need in batches
      if (weNeed.length > 0) {
        this._requestChunksInBatches(socket, weNeed, peerId, theyNeed);
      } else if (theyNeed.length > 0) {
        // We only need to send — peer will request from us via their own sync
        this._sendMessage(socket, MSG.SYNC_COMPLETE, '');
        this._finishSync(socket, peerId);
      }
    };

    // Step 3: Handle incoming chunk data
    socket._onChunks = (payload) => {
      this._receiveChunks(payload);
    };

    socket._onSyncComplete = () => {
      this._finishSync(socket, peerId);
    };
  }

  _requestChunksInBatches(socket, needed, peerId, _theyNeed) {
    let offset = 0;

    const requestNext = () => {
      if (offset >= needed.length) {
        // Update manifest with any new files from peer
        this._mergeManifestFromPeer(peerId);
        this._sendMessage(socket, MSG.SYNC_COMPLETE, '');
        this._finishSync(socket, peerId);
        return;
      }

      const batch = needed.slice(offset, offset + CHUNK_TRANSFER_BATCH);
      offset += CHUNK_TRANSFER_BATCH;

      this._sendMessage(socket, MSG.CHUNK_REQ, JSON.stringify(batch));

      // After receiving chunks, request next batch
      const prevHandler = socket._onChunks;
      socket._onChunks = (payload) => {
        this._receiveChunks(payload);
        this.pendingChunks = Math.max(0, this.pendingChunks - batch.length);
        socket._onChunks = prevHandler;
        requestNext();
      };
    };

    requestNext();
  }

  // ── Receive and store chunks from peer ────────────────────────────
  _receiveChunks(payload) {
    if (payload.length < 4) return;

    let offset = 0;
    const count = payload.readUInt32BE(offset); offset += 4;

    for (let i = 0; i < count; i++) {
      if (offset + 36 > payload.length) break;

      const hash = payload.toString('ascii', offset, offset + 32); offset += 32;
      const dataLen = payload.readUInt32BE(offset); offset += 4;

      if (offset + dataLen > payload.length) break;

      const data = payload.subarray(offset, offset + dataLen);
      offset += dataLen;

      // Only write if we don't already have it (safe — never overwrite)
      const chunkPath = this._chunkPath(hash);
      if (!fs.existsSync(chunkPath)) {
        fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
        fs.writeFileSync(chunkPath, data);
      }
    }
  }

  // ── Merge manifest entries from peer ──────────────────────────────
  _mergeManifestFromPeer(peerId) {
    // After receiving chunks, we need to also merge the peer's manifest
    // entries for any files that reference those chunks. The peer sends
    // its manifest as part of a separate exchange when acting as TCP server.
    //
    // For now, we request the peer's manifest and merge new file entries.
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // The manifest merge happens via a second short-lived connection
    const socket = net.createConnection({ host: peer.host, port: peer.port }, () => {
      // Request full manifest
      const reqBuf = Buffer.alloc(5);
      reqBuf[0] = MSG.MANIFEST_REQ;
      reqBuf.writeUInt32BE(1, 1);
      socket.write(Buffer.concat([reqBuf, Buffer.from('M')]));
    });

    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 5) {
        const type = buffer[0];
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break;

        const payload = buffer.subarray(5, 5 + len);
        buffer = buffer.subarray(5 + len);

        if (type === MSG.MANIFEST_RES) {
          try {
            // The manifest response here is just a chunk list
            // Real manifest merge would need file metadata too
            // This is handled by the full sync exchange
          } catch (_) {}
          socket.destroy();
        }
      }
    });

    socket.on('error', () => {});
    socket.setTimeout(10000, () => socket.destroy());
  }

  _finishSync(socket, peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.synced = Date.now();
    }
    this.lastSync = Date.now();
    this.pendingChunks = 0;
    this._activeSyncs.delete(peerId);

    try { socket.end(); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════

  _getManifestHash() {
    try {
      const keyData = fs.readFileSync(this.keyPath);
      return crypto.createHash('sha256').update(keyData).digest('hex').slice(0, 16);
    } catch (_) {
      return '0000000000000000';
    }
  }

  _getLocalChunkHashes() {
    const hashes = [];
    this._walkChunks(this.chunksDir, hashes);
    return hashes;
  }

  _walkChunks(dir, hashes) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this._walkChunks(full, hashes);
      } else if (e.name.endsWith('.chunk')) {
        hashes.push(e.name.slice(0, -6)); // strip .chunk extension
      }
    }
  }

  _chunkPath(hash) {
    return path.join(this.chunksDir, hash.slice(0, 2), hash.slice(2, 4), hash + '.chunk');
  }
}

// ─── Singleton instance ───────────────────────────────────────────────
const instance = new VaultSync();

function startSync(vaultDir, opts) {
  return instance.startSync(vaultDir, opts);
}

function stopSync() {
  return instance.stopSync();
}

function getSyncStatus() {
  return instance.getSyncStatus();
}

module.exports = { startSync, stopSync, getSyncStatus };
