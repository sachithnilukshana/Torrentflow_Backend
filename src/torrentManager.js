import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import parseTorrent from 'parse-torrent';
import magnetURI from 'magnet-uri';
import config from './config.js';
import { getWebTorrentClient, destroyWebTorrentClient } from './webtorrent.js';
import { broadcast } from './socket.js';
import { BackblazeB2UploadQueue } from './backblazeB2UploadQueue.js';
import { registerUploadedMovie, removeMovieByB2FileId } from './movieCatalogue.js';
import { cleanupExpiredBackblazeB2Files, syncBucketLifecycleRules } from './backblazeB2.js';
import { getSystemMetrics } from './systemMetrics.js';

// In-memory registry of all torrent tasks (active, queued, completed, error)
const torrentRegistry = new Map();

// Queue of infoHashes waiting to start
const downloadQueue = [];

// Shared progress-broadcast timer; initialized once and released on shutdown.
let progressInterval = null;
let b2CleanupInterval = null;

// The environment value is the first-run default. The dashboard setting is
// persisted with torrent metadata so an explicit user choice survives restarts.
let autoUploadEnabled = config.autoUploadToBackblazeB2;
let metadataLoaded = false;

// Serializes completed-file uploads so they do not contend with one another or
// with WebTorrent's network traffic.
const backblazeB2UploadQueue = new BackblazeB2UploadQueue({
  maxAttempts: config.backblazeB2UploadMaxAttempts,
  retryDelayMs: config.backblazeB2RetryDelayMs
});

// Event listeners/hooks for external notifications (Telegram, etc.)
const completionHooks = [];
const backblazeB2UploadCompletionHooks = [];

// High-performance public BitTorrent & WebRTC trackers to maximize swarm discovery and speed
export const HIGH_PERFORMANCE_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://movies.zsw.ca:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.swatech.info:2710/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
  'wss://tracker.btorrent.xyz'
];

// Metadata persistence file
const metaFilePath = path.join(config.temporaryDownloadPath, '.torrentflow-meta.json');

function getUploadFilePath(file) {
  return file.path || file.name;
}

function getUploadKey(task, filePath) {
  return `${task.infoHash}:${filePath}`;
}

function getPrimaryFile(files = []) {
  return files.slice().sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

function makeUploadRecord(file, existing = {}) {
  const filePath = getUploadFilePath(file);
  return {
    filePath,
    filename: file.name || path.basename(filePath),
    size: file.length || existing.size || 0,
    status: existing.status || 'waiting',
    progress: existing.status === 'completed' ? 100 : Number(existing.progress) || 0,
    attempts: Number(existing.attempts) || 0,
    url: existing.url || null,
    id: existing.id || null,
    uploadedAt: existing.uploadedAt || null,
    failedAt: existing.failedAt || null,
    nextRetryAt: existing.nextRetryAt || null,
    error: existing.error || null,
    errorCode: existing.errorCode || null,
    retryable: typeof existing.retryable === 'boolean' ? existing.retryable : null,
    telegramNotificationState: existing.telegramNotificationState || null,
    telegramNotifiedAt: existing.telegramNotifiedAt || null
  };
}

function ensureUploadRecords(task) {
  const current = new Map((task.backblazeB2Uploads || []).map((upload) => [upload.filePath, upload]));
  const primaryFile = getPrimaryFile(task.files || []);

  task.backblazeB2Uploads = (task.files || []).map((file) => {
    const filePath = getUploadFilePath(file);
    const record = makeUploadRecord(file, current.get(filePath));

    return record;
  });

  return task.backblazeB2Uploads;
}

function recoverInterruptedUploads(task) {
  for (const upload of ensureUploadRecords(task)) {
    // A process can stop while an upload is in progress. The file is complete,
    // but the remote result is unknown, so make it eligible for a safe retry.
    if (upload.status === 'uploading') {
      upload.status = 'waiting';
      upload.nextRetryAt = null;
      upload.error = 'Upload interrupted by application shutdown. It will resume when automatic uploads are enabled.';
      upload.retryable = true;
    }
  }
}

function getUploadRecord(task, filePath) {
  return (task.backblazeB2Uploads || []).find((upload) => upload.filePath === filePath) || null;
}

function canAutoUpload() {
  return autoUploadEnabled && Boolean(config.backblazeB2ApiToken);
}

function loadPersistedMeta() {
  try {
    if (fs.existsSync(metaFilePath)) {
      const persisted = JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
      // Version 1 was a bare torrent array. Keep it readable while migrating
      // future writes to the versioned document below.
      const torrents = Array.isArray(persisted) ? persisted : persisted.torrents;
      if (typeof persisted?.settings?.autoUploadEnabled === 'boolean') {
        autoUploadEnabled = persisted.settings.autoUploadEnabled;
      }

      if (Array.isArray(torrents)) {
        for (const item of torrents) {
          if (!item?.infoHash) continue;
          const task = {
            ...item,
            status: 'completed',
            downloadSpeed: 0,
            uploadSpeed: 0,
            peers: 0,
            progress: 1,
            _engine: null
          };
          recoverInterruptedUploads(task);
          torrentRegistry.set(item.infoHash.toLowerCase(), task);
        }
      }
    }
  } catch (err) {
    console.warn('[TorrentManager] Could not load persisted torrent metadata:', err.message);
  }
}

function savePersistedMeta() {
  // The application server calls initTorrentManager() before accepting work.
  // Do not let an imported manager (for example, a test process) overwrite a
  // real user's persisted queue before that initialization has happened.
  if (!metadataLoaded) return;

  try {
    const completedList = Array.from(torrentRegistry.values())
      .filter((t) => t.status === 'completed')
      .map((t) => {
        ensureUploadRecords(t);
        return {
          infoHash: t.infoHash,
          name: t.name,
          totalSize: t.totalSize,
          downloadedSize: t.downloadedSize,
          completedAt: t.completedAt,
          addedAt: t.addedAt,
          files: t.files,
          accessKey: t.accessKey || null,
          telegramUser: t.telegramUser || null,
          backblazeB2Url: t.backblazeB2Url || null,
          backblazeB2Uploads: (t.backblazeB2Uploads || []).map(({ _lastProgressBroadcastAt, ...upload }) => upload)
        };
      });
    fs.writeFileSync(metaFilePath, JSON.stringify({
      version: 2,
      settings: { autoUploadEnabled },
      torrents: completedList
    }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[TorrentManager] Failed to persist torrent metadata:', err.message);
  }
}

/**
 * Normalizes infoHash string to 40-character lowercase hex.
 */
export function normalizeInfoHash(hash) {
  if (!hash || typeof hash !== 'string') return '';
  const normalized = hash.trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

/**
 * Returns count of currently active (non-queued, non-completed, non-error) downloads.
 */
function getActiveCount() {
  let count = 0;
  for (const t of torrentRegistry.values()) {
    if (t.status === 'downloading' || t.status === 'metadata') {
      count++;
    }
  }
  return count;
}

/**
 * Checks and starts the next queued torrent if active concurrency permits.
 */
function processQueue() {
  const activeCount = getActiveCount();
  const availableSlots = config.maxActiveTorrents - activeCount;

  if (availableSlots <= 0 || downloadQueue.length === 0) {
    return;
  }

  const nextHash = downloadQueue.shift();
  const task = torrentRegistry.get(nextHash);
  if (!task || task.status !== 'queued') {
    return processQueue();
  }

  startTorrentEngine(task);
}

/**
 * Starts the WebTorrent download for a registered task.
 */
function startTorrentEngine(task) {
  const client = getWebTorrentClient();
  task.status = 'metadata';

  const torrentIdentifier = task.rawTorrent || task.magnetUri;
  const taskAnnounce = Array.isArray(task.announce) ? task.announce : [];
  const mergedAnnounce = Array.from(new Set([...taskAnnounce, ...HIGH_PERFORMANCE_TRACKERS]));

  const options = {
    // WebTorrent requires random-access local storage. This is a working area,
    // not permanent storage; verified B2 uploads are removed afterwards.
    path: config.temporaryDownloadPath,
    destroyStoreOnDestroy: false,
    announce: mergedAnnounce,
    strategy: config.torrentStrategy || 'rarest',
    maxWebConns: 32,
    maxConns: config.maxConnections || 1000,
    storeCacheSlots: config.storeCacheSlots || 128
  };

  try {
    const wtTorrent = client.add(torrentIdentifier, options, (torrent) => {
      onTorrentReady(task, torrent);
    });

    task._engine = wtTorrent;

    wtTorrent.on('infoHash', () => {
      task.infoHash = normalizeInfoHash(wtTorrent.infoHash);
    });

    wtTorrent.on('metadata', () => {
      task.name = wtTorrent.name || task.name || 'Unnamed Torrent';
      task.totalSize = wtTorrent.length || 0;
      task.status = 'downloading';
      if (wtTorrent.files) {
        task.files = wtTorrent.files.map((f) => ({
          name: f.name,
          path: f.path,
          length: f.length
        }));
        // Select all files to maximize download bandwidth
        wtTorrent.files.forEach((f) => {
          if (typeof f.select === 'function') f.select();
        });
      }
      broadcastSnapshot();
    });

    wtTorrent.on('error', (err) => {
      console.error(`[Torrent Error] ${task.name || task.infoHash}:`, err.message);
      task.status = 'error';
      task.errorMessage = err.message || 'WebTorrent download error';
      broadcast('torrent:error', formatTorrentOutput(task));
      processQueue();
    });

    wtTorrent.on('warning', (warn) => {
      console.warn(`[Torrent Warning] ${task.name || task.infoHash}:`, warn.message || warn);
    });

    wtTorrent.on('done', () => {
      onTorrentDone(task, wtTorrent);
    });
  } catch (err) {
    console.error(`[Torrent Start Error] ${task.infoHash}:`, err.message);
    task.status = 'error';
    task.errorMessage = err.message;
    broadcast('torrent:error', formatTorrentOutput(task));
    processQueue();
  }
}

function onTorrentReady(task, torrent) {
  task.name = torrent.name || task.name || 'Torrent';
  task.totalSize = torrent.length || 0;
  task.downloadedSize = torrent.downloaded || 0;
  task.status = torrent.done ? 'completed' : 'downloading';
  if (torrent.files) {
    task.files = torrent.files.map((f) => ({
      name: f.name,
      path: f.path,
      length: f.length
    }));
  }
  broadcastSnapshot();
}

async function onTorrentDone(task, torrent) {
  // WebTorrent can surface completion through more than one path. Process it
  // once so files, uploads, and notifications cannot be duplicated.
  if (task._completionHandled) return;
  task._completionHandled = true;

  task.status = 'completed';
  task.progress = 1;
  task.downloadedSize = torrent.length || task.totalSize;
  task.totalSize = torrent.length || task.totalSize;
  task.downloadSpeed = 0;
  task.uploadSpeed = 0;
  task.peers = 0;
  task.completedAt = new Date().toISOString();

  if (torrent.files) {
    task.files = torrent.files.map((f) => ({
      name: f.name,
      path: f.path,
      length: f.length
    }));
  }

  ensureUploadRecords(task);
  savePersistedMeta();

  console.log(`[TorrentManager] Download complete: "${task.name}" (${task.infoHash})`);
  const formatted = formatTorrentOutput(task);
  broadcast('torrent:completed', formatted);

  // Trigger completion hooks (e.g. Telegram notifications)
  for (const hook of completionHooks) {
    try {
      hook(formatted);
    } catch (err) {
      console.error('[TorrentManager] Error executing completion hook:', err.message);
    }
  }

  // Queue every completed file only when the user has enabled auto-upload.
  queuePendingUploadsForTask(task);

  // Start next in queue
  processQueue();
}

function queuePendingUploadsForTask(task, { manual = false } = {}) {
  if (task.status !== 'completed' || (!manual && !canAutoUpload())) return 0;

  let queuedCount = 0;
  for (const upload of ensureUploadRecords(task)) {
    if (upload.status !== 'waiting') continue;
    if (queueBackblazeB2Upload(task, upload, { manual })) queuedCount++;
  }
  return queuedCount;
}

function queueBackblazeB2Upload(task, upload, { manual = false } = {}) {
  if (upload.status === 'completed' || (!manual && !canAutoUpload()) || !config.backblazeB2ApiToken) {
    return false;
  }

  const targetPath = path.join(config.temporaryDownloadPath, upload.filePath);
  return backblazeB2UploadQueue.enqueue({
    key: getUploadKey(task, upload.filePath),
    targetPath,
    attempts: upload.attempts,
    onState: (state) => {
      if (torrentRegistry.get(task.infoHash) !== task) return;
      Object.assign(upload, state);
      if (state.status === 'uploading') {
        upload.startedAt = new Date().toISOString();
        upload.progress = 0;
        upload.statusMessage = 'Uploading to Backblaze B2';
      }
      savePersistedMeta();
      broadcastSnapshot();
    },
    onProgress: (progress) => {
      if (torrentRegistry.get(task.infoHash) !== task) return;
      upload.progress = progress.progress;
      upload.uploadedBytes = progress.uploadedBytes;
      upload.totalBytes = progress.totalBytes;
      upload.uploadSpeed = progress.uploadSpeed || 0;
      upload.estimatedRemainingSeconds = progress.estimatedRemainingSeconds ?? null;

      const now = Date.now();
      if (!upload._lastProgressBroadcastAt || now - upload._lastProgressBroadcastAt >= 500 || progress.progress === 100) {
        upload._lastProgressBroadcastAt = now;
        broadcast('upload:progress', {
          infoHash: task.infoHash,
          filePath: upload.filePath,
          filename: upload.filename,
          ...progress
        });
      }
    },
    onCompleted: (result, attempts) => {
      if (torrentRegistry.get(task.infoHash) !== task) return;
      Object.assign(upload, {
        status: 'completed',
        progress: 100,
        attempts,
        url: result.url,
        id: result.id,
        objectKey: result.objectKey || null,
        uploadedAt: new Date().toISOString(),
        failedAt: null,
        nextRetryAt: null,
        error: null,
        errorCode: null,
        retryable: null
      });
      upload.statusMessage = 'Upload complete';
      task.backblazeB2Url ||= result.url;
      task.accessKey ||= ('TF-' + crypto.randomBytes(6).toString('hex').toUpperCase());
      upload.accessKey = task.accessKey;
      try {
        registerUploadedMovie({
          filename: upload.filename,
          size: upload.size,
          b2FileId: result.id,
          objectKey: result.objectKey,
          torrentName: task.name,
          infoHash: task.infoHash,
          telegramUser: task.telegramUser || null,
          accessKey: task.accessKey
        });
      } catch (error) { console.error('[TorrentManager] Could not register uploaded movie:', error.message); }
      savePersistedMeta();
      broadcastSnapshot();
      broadcast('upload:completed', {
        infoHash: task.infoHash,
        filePath: upload.filePath,
        filename: upload.filename,
        url: result.url,
        id: result.id,
        uploadedAt: upload.uploadedAt
      });
      void notifyBackblazeB2UploadCompleted(task, upload);
      void cleanupVerifiedTemporaryFile(task, upload, targetPath);
    },
    onFailed: (error, { attempts, retryable }) => {
      if (torrentRegistry.get(task.infoHash) !== task) return;
      Object.assign(upload, {
        status: 'failed',
        attempts,
        failedAt: new Date().toISOString(),
        nextRetryAt: null,
        error: error.message,
        errorCode: error.code || null,
        retryable
      });
      savePersistedMeta();
      broadcastSnapshot();
      broadcast('upload:error', {
        infoHash: task.infoHash,
        filePath: upload.filePath,
        filename: upload.filename,
        error: error.message,
        retryable
      });
    }
  });
}

async function cleanupVerifiedTemporaryFile(task, upload, targetPath) {
  if (!config.deleteTemporaryFilesAfterUpload) return;
  try {
    // If all uploads for this task are completed or finishing,
    // detach and destroy the WebTorrent engine so file locks are released on Windows.
    const allDone = (task.backblazeB2Uploads || []).every(
      (u) => u.status === 'completed' || u.filePath === upload.filePath
    );
    if (allDone && task._engine) {
      try {
        const client = getWebTorrentClient();
        await new Promise((resolve) => {
          client.remove(task._engine, { destroyStore: false }, () => resolve());
        });
      } catch (_) {}
      task._engine = null;
    }

    // On Windows, file handles may need a brief interval to be fully closed
    let removed = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        if (!fs.existsSync(targetPath)) {
          removed = true;
          break;
        }
        if (fs.statSync(targetPath).isFile()) {
          fs.unlinkSync(targetPath);
          removed = true;
          break;
        }
      } catch (err) {
        if (attempt < 5) {
          await new Promise((res) => setTimeout(res, 200 * attempt));
        } else {
          throw err;
        }
      }
    }

    if (removed) {
      upload.localFileRemovedAt = new Date().toISOString();
      upload.statusMessage = 'Upload complete (temporary file removed)';
      console.log(`[TorrentManager] Successfully removed local file from disk after B2 upload: ${upload.filename}`);

      // Check if parent directory inside temp-downloads is now empty
      try {
        const parentDir = path.dirname(targetPath);
        const tempBase = path.resolve(config.temporaryDownloadPath);
        if (parentDir !== tempBase && parentDir.startsWith(tempBase)) {
          const remaining = fs.readdirSync(parentDir);
          if (remaining.length === 0) {
            fs.rmSync(parentDir, { recursive: true, force: true });
            console.log(`[TorrentManager] Cleaned up empty directory: ${path.basename(parentDir)}`);
          }
        }
      } catch (_) {}

      savePersistedMeta();
      broadcastSnapshot();
    }
  } catch (error) {
    console.warn(`[TorrentManager] Uploaded file retained because cleanup failed: ${error.message}`);
  }
}

async function notifyBackblazeB2UploadCompleted(task, upload) {
  if (
    backblazeB2UploadCompletionHooks.length === 0 ||
    upload.telegramNotificationState === 'sending' ||
    upload.telegramNotificationState === 'sent'
  ) {
    return;
  }

  // Persist the attempt first. If the process stops during delivery, this
  // prevents a restart from sending the same link repeatedly.
  upload.telegramNotificationState = 'sending';
  savePersistedMeta();

  let delivered = false;
  for (const hook of backblazeB2UploadCompletionHooks) {
    try {
      delivered = (await hook(formatTorrentOutput(task), { ...upload })) || delivered;
    } catch (err) {
      console.error('[TorrentManager] Error sending Backblaze B2 link notification:', err.message);
    }
  }

  upload.telegramNotificationState = delivered ? 'sent' : 'failed';
  if (delivered) upload.telegramNotifiedAt = new Date().toISOString();
  savePersistedMeta();
  broadcastSnapshot();
}

/**
 * Formats a torrent record into a clean JSON-friendly object.
 */
export function formatTorrentOutput(task) {
  const engine = task._engine;
  let progress = task.progress || 0;
  let downloadSpeed = 0;
  let uploadSpeed = 0;
  let peers = 0;
  let downloadedSize = task.downloadedSize || 0;
  let totalSize = task.totalSize || 0;

  if (engine && !engine.destroyed) {
    peers = engine.numPeers || 0;
    downloadSpeed = engine.downloadSpeed || 0;
    uploadSpeed = engine.uploadSpeed || 0;
    downloadedSize = engine.downloaded || downloadedSize;
    totalSize = engine.length || totalSize;

    if (task.status === 'completed' || engine.done) {
      progress = 1;
      downloadSpeed = 0;
    } else if (totalSize > 0) {
      // Never report 100% until engine marks it done
      const calculated = downloadedSize / totalSize;
      progress = calculated >= 1 ? 0.999 : calculated;
    }
  } else if (task.status === 'completed') {
    progress = 1;
  }

  return {
    infoHash: task.infoHash,
    name: task.name || (task.infoHash ? `Torrent (${task.infoHash.slice(0, 8)})` : 'Loading...'),
    totalSize,
    downloadedSize,
    uploadedSize: task.uploadedSize || (engine?.uploaded || 0),
    progress: Math.round(progress * 1000) / 1000,
    progressPercent: Math.round(progress * 1000) / 10,
    downloadSpeed,
    uploadSpeed,
    peers,
    status: task.status,
    addedAt: task.addedAt,
    completedAt: task.completedAt || null,
    errorMessage: task.errorMessage || null,
    backblazeB2Url: task.backblazeB2Url || null,
    backblazeB2Uploads: (task.backblazeB2Uploads || []).map((upload) => ({
      filePath: upload.filePath,
      filename: upload.filename,
      size: upload.size,
      status: upload.status,
      progress: upload.progress,
      attempts: upload.attempts,
      url: upload.url,
      uploadedAt: upload.uploadedAt,
      failedAt: upload.failedAt,
      nextRetryAt: upload.nextRetryAt,
      error: upload.error,
      errorCode: upload.errorCode,
      retryable: upload.retryable
    })),
    files: (task.files || []).map((f) => ({
      name: f.name,
      path: f.path || f.name,
      length: f.length || 0
    })),
    accessKey: task.accessKey || null,
    telegramUser: task.telegramUser || null
  };
}

let tickCount = 0;

/**
 * Periodic tick to refresh speeds and broadcast updates.
 */
function tick() {
  if (torrentRegistry.size === 0) return;
  tickCount++;

  const activeTorrents = [];
  let totalDlSpeed = 0;
  let totalUlSpeed = 0;

  for (const task of torrentRegistry.values()) {
    const formatted = formatTorrentOutput(task);
    totalDlSpeed += formatted.downloadSpeed;
    totalUlSpeed += formatted.uploadSpeed;

    if (task.status === 'downloading' || task.status === 'metadata' || task.status === 'paused') {
      activeTorrents.push(formatted);
    }

    // Auto-boost every 15s: unchoke wires and prioritize active swarm pieces
    if (tickCount % 15 === 0 && task.status === 'downloading' && task._engine && !task._engine.destroyed) {
      const engine = task._engine;
      if (engine.wires) {
        for (const wire of engine.wires) {
          if (typeof wire.unchoke === 'function') {
            try { wire.unchoke(); } catch (_) {}
          }
        }
      }
    }
  }

  broadcast('torrent:progress', {
    torrents: activeTorrents,
    totalDownloadSpeed: totalDlSpeed,
    totalUploadSpeed: totalUlSpeed,
    activeCount: getActiveCount(),
    queuedCount: downloadQueue.length,
    system: getSystemMetrics({
      downloadSpeed: totalDlSpeed,
      uploadSpeed: totalUlSpeed
    })
  });
}

function broadcastSnapshot() {
  const all = Array.from(torrentRegistry.values()).map(formatTorrentOutput);
  broadcast('torrent:snapshot', {
    torrents: all,
    activeCount: getActiveCount(),
    queuedCount: downloadQueue.length,
    maxActiveTorrents: config.maxActiveTorrents
  });
}

/**
 * Scans Backblaze B2 and removes files older than retention period (default: 2 days),
 * updating catalogue and metadata accordingly.
 */
export async function runBackblazeB2Cleanup() {
  if (!config.b2BucketId || !config.b2ApplicationKey) return { deletedCount: 0 };
  try {
    const result = await cleanupExpiredBackblazeB2Files({
      retentionDays: config.b2RetentionDays || 2
    });
    if (result.deletedFiles && result.deletedFiles.length > 0) {
      for (const del of result.deletedFiles) {
        removeMovieByB2FileId(del.fileId);
        for (const task of torrentRegistry.values()) {
          for (const u of task.backblazeB2Uploads || []) {
            if (u.id === del.fileId || u.objectKey === del.fileName) {
              u.statusMessage = 'File expired and removed from Backblaze B2 (2-day retention)';
              u.expiredAt = new Date().toISOString();
            }
          }
        }
      }
      savePersistedMeta();
      broadcastSnapshot();
    }
    return result;
  } catch (err) {
    console.warn('[TorrentManager] Backblaze B2 expiration cleanup error:', err.message);
    return { deletedCount: 0, error: err.message };
  }
}

/**
 * Initializes the TorrentManager, loads persisted metadata, and starts the progress timer.
 */
export function initTorrentManager() {
  if (!metadataLoaded) {
    loadPersistedMeta();
    metadataLoaded = true;
  }

  if (!progressInterval) {
    progressInterval = setInterval(tick, 1000);
  }

  // Wipe any orphaned local files for completed B2 uploads from disk
  if (config.deleteTemporaryFilesAfterUpload) {
    for (const task of torrentRegistry.values()) {
      for (const upload of task.backblazeB2Uploads || []) {
        if (upload.status === 'completed') {
          const targetPath = path.join(config.temporaryDownloadPath, upload.filePath);
          if (fs.existsSync(targetPath)) {
            try {
              fs.unlinkSync(targetPath);
              console.log(`[TorrentManager] Cleaned up stale local file for completed upload: ${upload.filename}`);
            } catch (_) {}
          }
        }
      }
    }
  }

  if (canAutoUpload()) {
    for (const task of torrentRegistry.values()) {
      queuePendingUploadsForTask(task);
    }
  }

  // Initialize Backblaze B2 2-day retention: sync bucket rule + run cleanup
  if (config.b2BucketId && config.b2ApplicationKey) {
    void syncBucketLifecycleRules(config.b2RetentionDays || 2);
    void runBackblazeB2Cleanup();

    if (!b2CleanupInterval) {
      // Run expiration scan every hour
      b2CleanupInterval = setInterval(() => {
        void runBackblazeB2Cleanup();
      }, 60 * 60 * 1000);
    }
  }
}

/**
 * Returns the user-facing automatic-upload setting without exposing the API key.
 */
export function getBackblazeB2Settings() {
  return {
    autoUploadEnabled,
    backblazeB2Configured: Boolean(config.backblazeB2ApiToken),
    maxAttempts: backblazeB2UploadQueue.maxAttempts
  };
}

/**
 * Persists an explicit dashboard choice and queues waiting completed files when
 * uploading is enabled. A missing API key never starts an upload.
 */
export function setAutoUploadEnabled(enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error('autoUploadEnabled must be a boolean value');
  }

  autoUploadEnabled = enabled;
  if (autoUploadEnabled && config.backblazeB2ApiToken) {
    for (const task of torrentRegistry.values()) {
      queuePendingUploadsForTask(task);
    }
  }

  savePersistedMeta();
  broadcastSnapshot();
  return getBackblazeB2Settings();
}

/**
 * Explicitly retries one failed file or every failed file in a completed torrent.
 * Manual retry is intentional user permission and therefore works even when the
 * automatic setting is disabled.
 */
export function retryBackblazeB2Upload(infoHash, filePath = null) {
  if (!config.backblazeB2ApiToken) {
    throw new Error('B2_API_TOKEN is not configured. Add an account token before retrying uploads.');
  }

  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);
  if (!task) throw new Error(`Torrent not found for hash: ${infoHash}`);
  if (task.status !== 'completed') throw new Error('Only fully completed torrents can be uploaded to Backblaze B2.');

  const uploads = ensureUploadRecords(task);
  const selected = filePath
    ? uploads.filter((upload) => upload.filePath === filePath)
    : uploads.filter((upload) => upload.status === 'failed');

  if (selected.length === 0) {
    throw new Error(filePath
      ? 'The selected file does not have a failed Backblaze B2 upload to retry.'
      : 'This torrent has no failed Backblaze B2 uploads to retry.');
  }

  for (const upload of selected) {
    if (upload.status !== 'failed') {
      throw new Error('Only failed Backblaze B2 uploads can be retried.');
    }
    Object.assign(upload, {
      status: 'waiting',
      progress: 0,
      attempts: 0,
      nextRetryAt: null,
      error: null,
      errorCode: null,
      retryable: null,
      failedAt: null
    });
    queueBackblazeB2Upload(task, upload, { manual: true });
  }

  savePersistedMeta();
  broadcastSnapshot();
  return formatTorrentOutput(task);
}

/**
 * Adds a torrent from a Magnet URI.
 */
export function addTorrentFromMagnet(rawMagnetUri, options = {}) {
  if (!rawMagnetUri || typeof rawMagnetUri !== 'string') {
    throw new Error('A valid magnet URI string is required');
  }

  const trimmed = rawMagnetUri.trim();
  if (!trimmed.startsWith('magnet:?')) {
    throw new Error('Invalid magnet URI: string must begin with "magnet:?"');
  }

  // Parse magnet to validate and extract infoHash
  const parsed = magnetURI(trimmed);
  if (!parsed.infoHash) {
    throw new Error('Invalid magnet URI: missing exact topic (xt) info hash');
  }

  const hash = normalizeInfoHash(parsed.infoHash);
  if (!hash) throw new Error('Only 40-character hexadecimal v1 torrent info hashes are supported by this torrent metadata path.');

  // Check duplicate
  if (torrentRegistry.has(hash)) {
    const existing = torrentRegistry.get(hash);
    throw new Error(`Torrent is already added with status: "${existing.status}" (hash: ${hash})`);
  }

  const task = {
    infoHash: hash,
    name: parsed.name || `Magnet-${hash.slice(0, 8)}`,
    magnetUri: trimmed,
    announce: Array.isArray(parsed.announce) ? parsed.announce : [],
    rawTorrent: null,
    status: 'queued',
    totalSize: 0,
    downloadedSize: 0,
    progress: 0,
    addedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    files: [],
    _engine: null,
    telegramUser: options.telegramUser || null,
    accessKey: options.accessKey || ('TF-' + crypto.randomBytes(6).toString('hex').toUpperCase())
  };

  torrentRegistry.set(hash, task);
  downloadQueue.push(hash);

  processQueue();
  broadcastSnapshot();

  return formatTorrentOutput(task);
}

/**
 * Adds a torrent from a .torrent file Buffer.
 */
export async function addTorrentFromFile(fileBuffer, originalFilename = 'upload.torrent', options = {}) {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error('A valid .torrent file Buffer is required');
  }

  let parsed;
  try {
    parsed = await parseTorrent(fileBuffer);
  } catch (err) {
    throw new Error(`Invalid or corrupt .torrent file: ${err.message}`);
  }

  if (!parsed.infoHash) {
    throw new Error('Could not extract infoHash from .torrent file');
  }

  const hash = normalizeInfoHash(parsed.infoHash);
  if (!hash) throw new Error('Only 40-character hexadecimal v1 torrent info hashes are supported by this torrent metadata path.');

  // Check duplicate
  if (torrentRegistry.has(hash)) {
    const existing = torrentRegistry.get(hash);
    throw new Error(`Torrent is already added with status: "${existing.status}" (hash: ${hash})`);
  }

  const task = {
    infoHash: hash,
    name: parsed.name || path.basename(originalFilename, '.torrent'),
    magnetUri: parsed.magnetURI || null,
    announce: Array.isArray(parsed.announce) ? parsed.announce : [],
    rawTorrent: fileBuffer,
    status: 'queued',
    totalSize: parsed.length || 0,
    downloadedSize: 0,
    progress: 0,
    addedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
    files: (parsed.files || []).map((f) => ({
      name: f.name,
      path: f.path,
      length: f.length
    })),
    _engine: null,
    telegramUser: options.telegramUser || null,
    accessKey: options.accessKey || ('TF-' + crypto.randomBytes(6).toString('hex').toUpperCase())
  };

  torrentRegistry.set(hash, task);
  downloadQueue.push(hash);

  processQueue();
  broadcastSnapshot();

  return formatTorrentOutput(task);
}

/**
 * Pauses an active torrent.
 */
export function pauseTorrent(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);

  if (!task) {
    throw new Error(`Torrent not found for hash: ${infoHash}`);
  }

  if (task.status === 'paused') {
    return formatTorrentOutput(task);
  }

  if (task.status === 'queued') {
    // Remove from queue
    const idx = downloadQueue.indexOf(hash);
    if (idx !== -1) downloadQueue.splice(idx, 1);
    task.status = 'paused';
    broadcastSnapshot();
    return formatTorrentOutput(task);
  }

  if (task._engine) {
    if (typeof task._engine.pause === 'function') {
      task._engine.pause();
    }
    task.status = 'paused';
    broadcastSnapshot();
    processQueue();
    return formatTorrentOutput(task);
  }

  throw new Error(`Cannot pause torrent in current status: ${task.status}`);
}

/**
 * Resumes a paused torrent.
 */
export function resumeTorrent(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);

  if (!task) {
    throw new Error(`Torrent not found for hash: ${infoHash}`);
  }

  if (task.status !== 'paused') {
    return formatTorrentOutput(task);
  }

  if (task._engine && typeof task._engine.resume === 'function') {
    task._engine.resume();
    task.status = 'downloading';
    broadcastSnapshot();
    return formatTorrentOutput(task);
  }

  // If engine wasn't instantiated or was queued
  task.status = 'queued';
  downloadQueue.push(hash);
  processQueue();
  broadcastSnapshot();
  return formatTorrentOutput(task);
}

/**
 * Boosts download speed by re-announcing to high-performance trackers,
 * prioritizing piece requests, and unchoking connected peers.
 */
export function boostTorrent(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);

  if (!task) {
    throw new Error(`Torrent not found for hash: ${infoHash}`);
  }

  if (task._engine && !task._engine.destroyed) {
    const engine = task._engine;

    // Reselect all files
    if (engine.files) {
      engine.files.forEach((f) => {
        if (typeof f.select === 'function') f.select();
      });
    }

    // Unchoke and re-interest all wires
    if (engine.wires) {
      engine.wires.forEach((wire) => {
        if (typeof wire.unchoke === 'function') {
          try { wire.unchoke(); } catch (_) {}
        }
      });
    }

    // Force discovery / tracker re-announce if supported
    if (engine.discovery && typeof engine.discovery.tracker?.announce === 'function') {
      try {
        engine.discovery.tracker.announce();
      } catch (_) {}
    }

    broadcastSnapshot();
    return formatTorrentOutput(task);
  }

  throw new Error(`Torrent is not currently active (status: ${task.status})`);
}

/**
 * Removes a torrent, with option to delete downloaded files on disk.
 */
export async function removeTorrent(infoHash, options = { deleteFiles: false }) {
  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);

  if (!task) {
    throw new Error(`Torrent not found for hash: ${infoHash}`);
  }

  // Remove from queue if present
  const qIdx = downloadQueue.indexOf(hash);
  if (qIdx !== -1) {
    downloadQueue.splice(qIdx, 1);
  }

  for (const upload of task.backblazeB2Uploads || []) {
    backblazeB2UploadQueue.cancel(getUploadKey(task, upload.filePath));
  }

  // Destroy WebTorrent instance
  if (task._engine) {
    const client = getWebTorrentClient();
    try {
      await new Promise((resolve) => {
        client.remove(task._engine, { destroyStore: Boolean(options.deleteFiles) }, () => {
          resolve();
        });
      });
    } catch (removeErr) {
      console.warn(`[TorrentManager] Notice on removing torrent engine: ${removeErr.message}`);
    }
    task._engine = null;
  }

  // If deleteFiles was requested and engine didn't delete them
  if (options.deleteFiles && task.files && task.files.length > 0) {
    for (const file of task.files) {
      for (const basePath of [config.temporaryDownloadPath, config.downloadPath]) {
        try {
          const fullPath = path.join(basePath, file.path || file.name);
          if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (rmErr) {
          console.warn(`[TorrentManager] Could not delete downloaded file "${file.name}":`, rmErr.message);
        }
      }
    }
  }

  torrentRegistry.delete(hash);
  savePersistedMeta();

  broadcastSnapshot();
  processQueue();

  return { success: true, infoHash: hash };
}

/**
 * Returns formatted details for a single torrent.
 */
export function getTorrent(infoHash) {
  const hash = normalizeInfoHash(infoHash);
  const task = torrentRegistry.get(hash);
  if (!task) return null;
  return formatTorrentOutput(task);
}

/**
 * Returns list of all tracked torrents.
 */
export function getAllTorrents() {
  return Array.from(torrentRegistry.values()).map(formatTorrentOutput);
}

/**
 * Scans the temporary working folder. Files disappear after verified upload.
 */
export function getCompletedDownloadsList() {
  try {
    const dir = config.temporaryDownloadPath;
    if (!fs.existsSync(dir)) return [];

    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Ignore hidden files and meta persistence file
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          results.push({
            name: entry.name,
            relativePath: entry.name,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            isDir: false
          });
        } else if (stat.isDirectory()) {
          results.push({
            name: entry.name,
            relativePath: entry.name,
            size: 0,
            modifiedAt: stat.mtime.toISOString(),
            isDir: true
          });
        }
      } catch (statErr) {
        // Skip unreadable files
      }
    }
    return results;
  } catch (err) {
    console.error('[TorrentManager] Error listing downloads directory:', err.message);
    return [];
  }
}

/**
 * Returns high-level system metrics.
 */
export function getSystemStats() {
  const all = Array.from(torrentRegistry.values()).map(formatTorrentOutput);
  let totalDlSpeed = 0;
  let totalUlSpeed = 0;
  let activeCount = 0;
  let completedCount = 0;

  for (const t of all) {
    totalDlSpeed += t.downloadSpeed;
    totalUlSpeed += t.uploadSpeed;
    if (t.status === 'downloading' || t.status === 'metadata') activeCount++;
    if (t.status === 'completed') completedCount++;
  }

  const system = getSystemMetrics({
    downloadSpeed: totalDlSpeed,
    uploadSpeed: totalUlSpeed
  });

  return {
    totalTorrents: all.length,
    activeCount,
    completedCount,
    queuedCount: downloadQueue.length,
    downloadSpeed: totalDlSpeed,
    uploadSpeed: totalUlSpeed,
    downloadPath: config.downloadPath,
    maxActiveTorrents: config.maxActiveTorrents,
    system
  };
}

/**
 * Registers a hook to be notified when any torrent finishes downloading.
 */
export function onTorrentCompleted(callback) {
  if (typeof callback === 'function' && !completionHooks.includes(callback)) {
    completionHooks.push(callback);
  }
}

/**
 * Registers an idempotent listener for confirmed Backblaze B2 links. Telegram
 * uses this hook so it never receives an unfinished or failed URL.
 */
export function onBackblazeB2UploadCompleted(callback) {
  if (typeof callback !== 'function' || backblazeB2UploadCompletionHooks.includes(callback)) return;
  backblazeB2UploadCompletionHooks.push(callback);

  // If Backblaze B2 completed before an optional notifier initialized, deliver
  // each saved, confirmed link once the notifier is ready.
  for (const task of torrentRegistry.values()) {
    for (const upload of task.backblazeB2Uploads || []) {
      if (upload.status === 'completed') {
        void notifyBackblazeB2UploadCompleted(task, upload);
      }
    }
  }
}

/**
 * Graceful cleanup on server shutdown.
 */
export async function shutdownTorrentManager() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  if (b2CleanupInterval) {
    clearInterval(b2CleanupInterval);
    b2CleanupInterval = null;
  }
  // Test/API hosts can import the manager without initialization. Never let
  // that isolated registry overwrite persisted desktop download metadata.
  if (metadataLoaded) {
    savePersistedMeta();
  }
  await destroyWebTorrentClient();
}

export default {
  initTorrentManager,
  runBackblazeB2Cleanup,
  addTorrentFromMagnet,
  addTorrentFromFile,
  pauseTorrent,
  resumeTorrent,
  boostTorrent,
  removeTorrent,
  getTorrent,
  getAllTorrents,
  getCompletedDownloadsList,
  getSystemStats,
  onTorrentCompleted,
  onBackblazeB2UploadCompleted,
  getBackblazeB2Settings,
  setAutoUploadEnabled,
  retryBackblazeB2Upload,
  shutdownTorrentManager,
  formatTorrentOutput,
  normalizeInfoHash
};

