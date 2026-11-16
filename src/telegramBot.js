import TelegramBot from 'node-telegram-bot-api';
import https from 'https';
import config from './config.js';
import torrentManager from './torrentManager.js';

let botInstance = null;
let completionHookRegistered = false;
let backblazeB2UploadHookRegistered = false;

// Active progress trackers: infoHash -> Array<{ chatId, messageId, lastText, lastEditAt, finalized }>
const activeProgressTrackers = new Map();
let progressUpdateInterval = null;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return null;
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function renderProgressBar(ratio) {
  const totalBars = 10;
  const filledBars = Math.min(totalBars, Math.max(0, Math.round(ratio * totalBars)));
  const emptyBars = totalBars - filledBars;
  return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

/**
 * Checks if the sender Telegram user ID is explicitly allowed.
 */
export function isUserAllowed(userId) {
  if (!userId) return false;
  const numId = Number(userId);
  if (isNaN(numId)) return false;
  return config.telegramAllowedUserIds.includes(numId);
}

/**
 * Generates an up-to-date live progress status string with visual bar,
 * real download speeds, ETA, peer count, and Backblaze B2 status.
 */
export function formatLiveProgressMessage(t) {
  if (!t) return '';
  const bar = renderProgressBar(t.progress || 0);
  const remainingBytes = Math.max(0, (t.totalSize || 0) - (t.downloadedSize || 0));
  const etaSeconds =
    t.downloadSpeed && t.downloadSpeed > 0 && remainingBytes > 0
      ? remainingBytes / t.downloadSpeed
      : null;
  const etaText = etaSeconds ? ` | *ETA:* ${formatTime(etaSeconds)}` : '';

  if (t.status === 'queued') {
    return (
      `⏳ *Torrent Queued...*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Hash:* \`${t.infoHash}\`\n\n` +
      `_Waiting for available download slot..._`
    );
  }

  if (t.status === 'metadata') {
    return (
      `🔍 *Fetching Torrent Metadata...*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Peers:* ${t.peers || 0}\n` +
      `*Hash:* \`${t.infoHash}\`\n\n` +
      `_Connecting to BitTorrent swarm..._`
    );
  }

  if (t.status === 'downloading') {
    return (
      `⬇️ *Downloading Torrent...*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Progress:* [${bar}] ${t.progressPercent || 0}%\n` +
      `*Size:* ${formatBytes(t.downloadedSize)} / ${formatBytes(t.totalSize)}\n` +
      `*Speed:* ⬇ ${formatSpeed(t.downloadSpeed)} | ⬆ ${formatSpeed(t.uploadSpeed)}\n` +
      `*Peers:* ${t.peers || 0}${etaText}\n` +
      `*Hash:* \`${t.infoHash}\``
    );
  }

  if (t.status === 'paused') {
    return (
      `⏸️ *Torrent Paused*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Progress:* [${bar}] ${t.progressPercent || 0}%\n` +
      `*Size:* ${formatBytes(t.downloadedSize)} / ${formatBytes(t.totalSize)}\n` +
      `*Hash:* \`${t.infoHash}\``
    );
  }

  if (t.status === 'error') {
    return (
      `❌ *Download Error*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Error:* ${escapeMarkdown(t.errorMessage || 'Unknown error')}\n` +
      `*Hash:* \`${t.infoHash}\``
    );
  }

  if (t.status === 'completed') {
    const uploads = t.backblazeB2Uploads || [];
    const activeUpload = uploads.find((u) => u.status === 'uploading');
    if (activeUpload) {
      const uploadRatio = (activeUpload.progress || 0) / 100;
      const uploadBar = renderProgressBar(uploadRatio);
      return (
        `☁️ *Uploading to Backblaze B2...*\n\n` +
        `*Torrent:* ${escapeMarkdown(t.name)}\n` +
        `*File:* ${escapeMarkdown(activeUpload.filename || t.name)}\n` +
        `*Progress:* [${uploadBar}] ${activeUpload.progress || 0}%\n` +
        `*Size:* ${formatBytes(activeUpload.size || t.totalSize)}\n` +
        `*Speed:* ⬆ ${formatSpeed(activeUpload.uploadSpeed || 0)}\n` +
        `*Hash:* \`${t.infoHash}\``
      );
    }

    const completedUpload = uploads.find((u) => u.status === 'completed' && u.url);
    if (completedUpload) {
      const accessKey = t.accessKey || completedUpload.accessKey || ('TF-' + (t.infoHash || 'MOVIE').slice(0, 10).toUpperCase());
      const uploaderName = t.telegramUser?.displayName || 'Telegram User';
      const watchUrl = `${config.frontendOrigin.replace(/\/$/, '')}/cinema?key=${encodeURIComponent(accessKey)}`;
      return (
        `🎉 *Download Completed!*\n\n` +
        `*Movie:* ${escapeMarkdown(t.name)}\n` +
        `*File:* ${escapeMarkdown(completedUpload.filename || t.name)}\n` +
        `*Size:* ${formatBytes(completedUpload.size || t.totalSize)}\n` +
        `*🔑 Movie Access Key:* \`${accessKey}\`\n` +
        `*👤 Added by:* ${escapeMarkdown(uploaderName)}\n\n` +
        `🍿 *Watch on Website (TorrentFlow Cinema):*\n[Open in TorrentFlow Cinema](${watchUrl})\n\n` +
        `☁️ *Direct B2 Link:* [Download from Backblaze B2](${formatMarkdownUrl(completedUpload.url)})\n\n` +
        `⏰ *Retention:* Stored on Backblaze B2 for 2 days. Local copy removed from disk.`
      );
    }

    return (
      `🎉 *Download Completed!*\n\n` +
      `*Name:* ${escapeMarkdown(t.name)}\n` +
      `*Size:* ${formatBytes(t.totalSize)}\n` +
      `*Hash:* \`${t.infoHash}\``
    );
  }

  return '';
}

/**
 * Registers a Telegram message to receive real-time in-place progress updates.
 */
export function startLiveTracking(infoHash, chatId, messageId) {
  if (!infoHash || !chatId || !messageId) return;
  const normalized = infoHash.toLowerCase();
  if (!activeProgressTrackers.has(normalized)) {
    activeProgressTrackers.set(normalized, []);
  }
  activeProgressTrackers.get(normalized).push({
    chatId,
    messageId,
    lastText: '',
    lastEditAt: Date.now(),
    finalized: false
  });

  if (!progressUpdateInterval) {
    progressUpdateInterval = setInterval(updateLiveProgress, 2500);
  }
}

/**
 * Periodic updater that updates all active progress bars in Telegram.
 */
async function updateLiveProgress() {
  if (!botInstance || activeProgressTrackers.size === 0) {
    if (progressUpdateInterval && activeProgressTrackers.size === 0) {
      clearInterval(progressUpdateInterval);
      progressUpdateInterval = null;
    }
    return;
  }

  for (const [infoHash, trackers] of Array.from(activeProgressTrackers.entries())) {
    const t = torrentManager.getTorrent(infoHash);
    if (!t) {
      activeProgressTrackers.delete(infoHash);
      continue;
    }

    const messageText = formatLiveProgressMessage(t);
    if (!messageText) continue;

    const b2Uploads = t.backblazeB2Uploads || [];
    const isFinished =
      t.status === 'completed' &&
      (!config.backblazeB2ApiToken ||
        b2Uploads.length === 0 ||
        b2Uploads.every((u) => u.status === 'completed' || u.status === 'failed'));
    const isFailed = t.status === 'error';

    for (let i = trackers.length - 1; i >= 0; i--) {
      const tracker = trackers[i];
      if (tracker.lastText === messageText) continue;

      // Throttle: edit message at most once every 2 seconds per chat to respect Telegram limits
      const now = Date.now();
      if (now - tracker.lastEditAt < 2000 && !isFinished && !isFailed) continue;

      try {
        await botInstance.editMessageText(messageText, {
          chat_id: tracker.chatId,
          message_id: tracker.messageId,
          parse_mode: 'Markdown'
        });
        tracker.lastText = messageText;
        tracker.lastEditAt = now;
      } catch (err) {
        if (!err.message?.includes('message is not modified')) {
          console.warn('[Telegram Bot] Live progress update notice:', err.code || err.message);
        }
      }

      if (isFinished || isFailed) {
        tracker.finalized = true;
        trackers.splice(i, 1);
      }
    }

    if (trackers.length === 0) {
      activeProgressTrackers.delete(infoHash);
    }
  }
}

/**
 * Initializes the Telegram Bot with polling, security allowlist, and command handlers.
 */
export function initTelegramBot() {
  const token = config.telegramBotToken;
  if (!token) {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided. Telegram bot is disabled.');
    return null;
  }

  if (botInstance) return botInstance;

  try {
    botInstance = new TelegramBot(token, {
      polling: {
        autoStart: true,
        params: {
          timeout: 20
        }
      }
    });

    botInstance.on('polling_error', (error) => {
      console.warn('[Telegram Bot Polling Notice]:', error.code || error.message);
    });

function getTelegramUserInfo(msg) {
  const from = msg.from || {};
  const displayName = from.username
    ? `@${from.username}`
    : [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.id ? `User ${from.id}` : 'Telegram User');
  return {
    id: from.id,
    username: from.username || null,
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    displayName
  };
}

    // Guard middleware
    function checkAuth(msg) {
      const fromId = msg.from?.id;
      if (!isUserAllowed(fromId)) {
        console.warn(`[Telegram Security] Unauthorized access attempt from Telegram ID: ${fromId}`);
        botInstance.sendMessage(
          msg.chat.id,
          `⛔ *Access Denied*\nYour Telegram User ID (\`${fromId}\`) is not authorized to control TorrentFlow.`,
          { parse_mode: 'Markdown' }
        );
        return false;
      }
      return true;
    }

    // /start command
    botInstance.onText(/\/start/, (msg) => {
      if (!checkAuth(msg)) return;
      const text =
        `🚀 *Welcome to TorrentFlow Bot!*\n\n` +
        `Control your WebTorrent downloads remotely with real-time progress bars:\n` +
        `• \`/status\` - View active downloads and server speeds\n` +
        `• \`/list\` - List all downloads\n` +
        `• \`/add <magnet>\` - Add a magnet link\n` +
        `• \`/pause <hash>\` - Pause a download\n` +
        `• \`/resume <hash>\` - Resume a download\n` +
        `• \`/remove <hash>\` - Remove a torrent\n` +
        `• \`/help\` - Detailed help\n\n` +
        `💡 You can send a \`.torrent\` file or paste a magnet link directly for instant real-time progress!`;
      botInstance.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /help command
    botInstance.onText(/\/help/, (msg) => {
      if (!checkAuth(msg)) return;
      const text =
        `📖 *TorrentFlow Help*\n\n` +
        `• \`/status\`\n  Displays active download progress, speeds, and queue counts.\n\n` +
        `• \`/list\`\n  Lists the 15 most recent torrents with statuses.\n\n` +
        `• \`/add <magnetURI>\`\n  Begins downloading from a BitTorrent magnet URI with live progress updates.\n\n` +
        `• \`/pause <infoHash>\`\n  Pauses an active download.\n\n` +
        `• \`/resume <infoHash>\`\n  Resumes a paused download.\n\n` +
        `• \`/remove <infoHash>\`\n  Removes the torrent task.\n\n` +
        `• Attach a \`.torrent\` file or paste a magnet link\n  Automatically queues download with a real-time progress bar (up to ${config.maxTorrentUploadMb}MB).`;
      botInstance.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /status command
    botInstance.onText(/\/status/, (msg) => {
      if (!checkAuth(msg)) return;
      const stats = torrentManager.getSystemStats();
      const torrents = torrentManager.getAllTorrents();
      const active = torrents.filter((t) => t.status === 'downloading' || t.status === 'metadata');

      let reply = `⚡ *TorrentFlow Status*\n`;
      reply += `Total: ${stats.totalTorrents} | Active: ${stats.activeCount}/${config.maxActiveTorrents} | Completed: ${stats.completedCount}\n`;
      reply += `⬇ DL: ${formatSpeed(stats.downloadSpeed)} | ⬆ UL: ${formatSpeed(stats.uploadSpeed)}\n\n`;

      if (stats.system) {
        const sys = stats.system;
        const cpuStr = `CPU: ${sys.cpu?.percent ?? 0}% (${sys.cpu?.cores ?? 0} cores)`;
        const ramStr = `RAM: ${formatBytes(sys.memory?.used)} / ${formatBytes(sys.memory?.total)} (${sys.memory?.percent ?? 0}%)`;
        const diskStr = sys.disk?.total > 0 ? `Disk: ${formatBytes(sys.disk.used)} / ${formatBytes(sys.disk.total)} (${sys.disk.percent}%)` : '';
        reply += `🖥️ *Server Resources:*\n${cpuStr}\n${ramStr}${diskStr ? '\n' + diskStr : ''}\n\n`;
      }

      if (active.length === 0) {
        reply += `_No active downloads running._`;
      } else {
        active.forEach((t, i) => {
          const bar = renderProgressBar(t.progress || 0);
          reply += `*${i + 1}. ${escapeMarkdown(t.name)}*\n`;
          reply += `   [${bar}] ${t.progressPercent || 0}%\n`;
          reply += `   Size: ${formatBytes(t.downloadedSize)} / ${formatBytes(t.totalSize)}\n`;
          reply += `   Speed: ⬇ ${formatSpeed(t.downloadSpeed)} | Peers: ${t.peers}\n`;
          reply += `   Hash: \`${t.infoHash}\`\n\n`;
        });
      }

      botInstance.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
    });

    // /list command
    botInstance.onText(/\/list/, (msg) => {
      if (!checkAuth(msg)) return;
      const torrents = torrentManager.getAllTorrents();

      if (torrents.length === 0) {
        return botInstance.sendMessage(msg.chat.id, '📭 _No torrents registered yet._', { parse_mode: 'Markdown' });
      }

      let text = `📋 *Torrent List (${torrents.length})*\n\n`;
      torrents.slice(0, 15).forEach((t, i) => {
        const statusEmoji = t.status === 'completed' ? '✅' : t.status === 'downloading' ? '⬇️' : t.status === 'paused' ? '⏸️' : '⏳';
        text += `${statusEmoji} *${i + 1}. ${escapeMarkdown(t.name)}*\n`;
        text += `   Status: \`${t.status}\` | ${formatBytes(t.totalSize)} | ${t.progressPercent || 0}%\n`;
        text += `   Hash: \`${t.infoHash}\`\n`;
        if (t.backblazeB2Url) {
          text += `   🔗 [Backblaze B2 Link](${formatMarkdownUrl(t.backblazeB2Url)})\n`;
        }
        text += `\n`;
      });

      safeSendMessage(msg.chat.id, text);
    });

    // /add <magnet> command
    botInstance.onText(/\/add(?:\s+(.+))?/, async (msg, match) => {
      if (!checkAuth(msg)) return;
      const magnetLink = match[1]?.trim();

      if (!magnetLink) {
        return botInstance.sendMessage(
          msg.chat.id,
          '⚠️ *Usage:* `/add magnet:?xt=urn:btih:...`',
          { parse_mode: 'Markdown' }
        );
      }

      try {
        const added = torrentManager.addTorrentFromMagnet(magnetLink, { telegramUser: getTelegramUserInfo(msg) });
        const initialText =
          formatLiveProgressMessage(added) ||
          `⏳ *Torrent Added!*\n*Name:* ${escapeMarkdown(added.name)}\n*Status:* \`${added.status}\`\n*Hash:* \`${added.infoHash}\``;

        const sentMsg = await botInstance.sendMessage(msg.chat.id, initialText, { parse_mode: 'Markdown' });
        startLiveTracking(added.infoHash, msg.chat.id, sentMsg.message_id);
      } catch (err) {
        botInstance.sendMessage(
          msg.chat.id,
          `❌ *Failed to add torrent:*\n${escapeMarkdown(err.message)}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Auto-detect plain magnet links sent directly without /add
    botInstance.on('message', async (msg) => {
      const text = msg.text?.trim();
      if (!text || text.startsWith('/') || !text.startsWith('magnet:?xt=urn:btih:')) return;
      if (!checkAuth(msg)) return;

      try {
        const added = torrentManager.addTorrentFromMagnet(text, { telegramUser: getTelegramUserInfo(msg) });
        const initialText =
          formatLiveProgressMessage(added) ||
          `⏳ *Torrent Added!*\n*Name:* ${escapeMarkdown(added.name)}\n*Hash:* \`${added.infoHash}\``;

        const sentMsg = await botInstance.sendMessage(msg.chat.id, initialText, { parse_mode: 'Markdown' });
        startLiveTracking(added.infoHash, msg.chat.id, sentMsg.message_id);
      } catch (err) {
        botInstance.sendMessage(
          msg.chat.id,
          `❌ Failed to add magnet link: ${escapeMarkdown(err.message)}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // /pause <hash>
    botInstance.onText(/\/pause(?:\s+(.+))?/, async (msg, match) => {
      if (!checkAuth(msg)) return;
      const hash = match[1]?.trim();
      if (!hash) {
        return botInstance.sendMessage(msg.chat.id, '⚠️ *Usage:* `/pause <infoHash>`', { parse_mode: 'Markdown' });
      }

      try {
        const updated = await torrentManager.pauseTorrent(hash);
        botInstance.sendMessage(msg.chat.id, `⏸️ Paused torrent: *${escapeMarkdown(updated.name)}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        botInstance.sendMessage(msg.chat.id, `❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
      }
    });

    // /resume <hash>
    botInstance.onText(/\/resume(?:\s+(.+))?/, async (msg, match) => {
      if (!checkAuth(msg)) return;
      const hash = match[1]?.trim();
      if (!hash) {
        return botInstance.sendMessage(msg.chat.id, '⚠️ *Usage:* `/resume <infoHash>`', { parse_mode: 'Markdown' });
      }

      try {
        const updated = await torrentManager.resumeTorrent(hash);
        botInstance.sendMessage(msg.chat.id, `▶️ Resumed torrent: *${escapeMarkdown(updated.name)}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        botInstance.sendMessage(msg.chat.id, `❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
      }
    });

    // /remove <hash>
    botInstance.onText(/\/remove(?:\s+(.+))?/, async (msg, match) => {
      if (!checkAuth(msg)) return;
      const hash = match[1]?.trim();
      if (!hash) {
        return botInstance.sendMessage(msg.chat.id, '⚠️ *Usage:* `/remove <infoHash>`', { parse_mode: 'Markdown' });
      }

      try {
        await torrentManager.removeTorrent(hash, { deleteFiles: false });
        botInstance.sendMessage(msg.chat.id, `🗑️ Removed torrent: \`${hash}\``, { parse_mode: 'Markdown' });
      } catch (err) {
        botInstance.sendMessage(msg.chat.id, `❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
      }
    });

    // Document attachment (.torrent) handler
    botInstance.on('document', async (msg) => {
      if (!checkAuth(msg)) return;
      const doc = msg.document;
      if (!doc) return;

      const fileName = doc.file_name || '';
      if (!fileName.toLowerCase().endsWith('.torrent')) {
        return botInstance.sendMessage(
          msg.chat.id,
          '⚠️ Please attach a valid file ending with `.torrent`.',
          { parse_mode: 'Markdown' }
        );
      }

      const maxBytes = config.maxTorrentUploadMb * 1024 * 1024;
      if (doc.file_size && doc.file_size > maxBytes) {
        return botInstance.sendMessage(
          msg.chat.id,
          `❌ File too large (${formatBytes(doc.file_size)}). Maximum allowed size is ${config.maxTorrentUploadMb}MB.`,
          { parse_mode: 'Markdown' }
        );
      }

      try {
        const fileStream = botInstance.getFileStream(doc.file_id);
        const chunks = [];
        for await (const chunk of fileStream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        const added = await torrentManager.addTorrentFromFile(buffer, fileName, { telegramUser: getTelegramUserInfo(msg) });
        const initialText =
          formatLiveProgressMessage(added) ||
          `⏳ *Torrent File Queued!*\n*Name:* ${escapeMarkdown(added.name)}\n*Size:* ${formatBytes(added.totalSize)}\n*Hash:* \`${added.infoHash}\``;

        const sentMsg = await botInstance.sendMessage(msg.chat.id, initialText, { parse_mode: 'Markdown' });
        startLiveTracking(added.infoHash, msg.chat.id, sentMsg.message_id);
      } catch (err) {
        botInstance.sendMessage(
          msg.chat.id,
          `❌ Failed to parse .torrent file: ${escapeMarkdown(err.message)}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Register notification hooks once
    if (!completionHookRegistered) {
      torrentManager.onTorrentCompleted((torrent) => {
        notifyCompletion(torrent);
      });
      completionHookRegistered = true;
    }

    if (!backblazeB2UploadHookRegistered) {
      torrentManager.onBackblazeB2UploadCompleted((torrent, upload) => {
        return notifyBackblazeB2Upload(torrent, upload);
      });
      backblazeB2UploadHookRegistered = true;
    }

    console.log('[Telegram Bot] Initialized successfully with live progress bar tracking.');
  } catch (err) {
    console.error('[Telegram Bot Initialization Error]:', err.message);
  }

  return botInstance;
}

/**
 * Sends a notification to allowed Telegram users when a torrent download finishes.
 * If Backblaze B2 auto-upload is configured and active, this is skipped so that
 * "🎉 Download Completed!" is sent only after uploading to Backblaze B2.
 */
export function notifyCompletion(torrent) {
  if (!botInstance || !config.telegramAllowedUserIds || config.telegramAllowedUserIds.length === 0) {
    return;
  }

  const b2Settings = torrentManager.getBackblazeB2Settings?.();
  if (config.backblazeB2ApiToken && b2Settings?.autoUploadEnabled) {
    return;
  }

  const message =
    `🎉 *Download Completed!*\n\n` +
    `*Name:* ${escapeMarkdown(torrent.name)}\n` +
    `*Size:* ${formatBytes(torrent.totalSize)}\n` +
    `*Hash:* \`${torrent.infoHash}\``;

  for (const userId of config.telegramAllowedUserIds) {
    try {
      botInstance.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch((err) => {
        console.warn(`[Telegram Bot] Could not send completion alert to ${userId}:`, err.message);
      });
    } catch (err) {
      // Ignore delivery errors
    }
  }
}

/**
 * Sends "🎉 Download Completed!" with confirmed Backblaze B2 link only after
 * the upload service returned an official file ID and URL.
 */
export async function notifyBackblazeB2Upload(torrent, upload, bot = botInstance) {
  const url = upload?.url;
  const configuredPublicBase = config.b2PublicUrlBase?.replace(/\/$/, '');
  const isTrustedB2Url =
    /^https:\/\/[^/]*\.backblazeb2\.com\/file\/.+/.test(url || '') ||
    Boolean(configuredPublicBase && url?.startsWith(`${configuredPublicBase}/`));
  if (
    !bot ||
    !url ||
    !isTrustedB2Url ||
    !Array.isArray(config.telegramAllowedUserIds) ||
    config.telegramAllowedUserIds.length === 0
  ) {
    return false;
  }

  const safeUrl = formatMarkdownUrl(url);
  const sizeText = upload.size
    ? `\n*Size:* ${formatBytes(upload.size)}`
    : torrent.totalSize
    ? `\n*Size:* ${formatBytes(torrent.totalSize)}`
    : '';
  const hashText = torrent.infoHash ? `\n*Hash:* \`${torrent.infoHash}\`` : '';

  const accessKey = torrent.accessKey || upload.accessKey || ('TF-' + (torrent.infoHash || 'MOVIE').slice(0, 10).toUpperCase());
  const uploaderName = torrent.telegramUser?.displayName || 'Telegram User';
  const watchUrl = `${config.frontendOrigin.replace(/\/$/, '')}/cinema?key=${encodeURIComponent(accessKey)}`;

  const message =
    `🎉 *Download Completed!*\n\n` +
    `*Movie:* ${escapeMarkdown(torrent.name)}\n` +
    `*File:* ${escapeMarkdown(upload.filename || torrent.name)}${sizeText}\n` +
    `*🔑 Movie Access Key:* \`${accessKey}\`\n` +
    `*👤 Added by:* ${escapeMarkdown(uploaderName)}\n\n` +
    `🍿 *Watch on Website (TorrentFlow Cinema):*\n[Open in TorrentFlow Cinema](${watchUrl})\n\n` +
    `☁️ *Direct B2 Link:* [Download from Backblaze B2](${safeUrl})\n\n` +
    `⏰ *Retention:* Stored on Backblaze B2 for 2 days. Local copy removed from disk.`;

  // First, finalize any active live progress trackers for this torrent in-place
  const normalizedHash = torrent.infoHash?.toLowerCase();
  const notifiedChatIds = new Set();

  if (normalizedHash && activeProgressTrackers.has(normalizedHash)) {
    const trackers = activeProgressTrackers.get(normalizedHash) || [];
    for (const tracker of trackers) {
      try {
        await bot.editMessageText(message, {
          chat_id: tracker.chatId,
          message_id: tracker.messageId,
          parse_mode: 'Markdown'
        });
        tracker.finalized = true;
        notifiedChatIds.add(tracker.chatId);
      } catch (err) {
        try {
          const plain = message.replace(/\\([_*`[\]\\])/g, '$1').replace(/[*_`]/g, '');
          await bot.editMessageText(plain, {
            chat_id: tracker.chatId,
            message_id: tracker.messageId
          });
          tracker.finalized = true;
          notifiedChatIds.add(tracker.chatId);
        } catch (_) {}
      }
    }
  }

  // Next, send notifications to allowed user IDs who did not have an active in-chat tracker
  const targetUserIds = config.telegramAllowedUserIds.filter((id) => !notifiedChatIds.has(id));

  let deliveredCount = 0;
  if (targetUserIds.length > 0) {
    const deliveries = await Promise.all(
      targetUserIds.map(async (userId) => {
        try {
          await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
          return true;
        } catch (err) {
          try {
            const plain = message.replace(/\\([_*`[\]\\])/g, '$1').replace(/[*_`]/g, '');
            await bot.sendMessage(userId, plain);
            return true;
          } catch (innerErr) {
            console.warn(`[Telegram Bot] Delivery fallback notice for ${userId}:`, innerErr.message);
          }
          console.warn(`[Telegram Bot] Backblaze B2 link delivery notice for ${userId}:`, err.code || err.message);
          return false;
        }
      })
    );
    deliveredCount = deliveries.filter(Boolean).length;
  }

  if (normalizedHash) {
    activeProgressTrackers.delete(normalizedHash);
  }

  return deliveredCount > 0 || notifiedChatIds.size > 0;
}

export function formatMarkdownUrl(url) {
  if (!url) return '';
  return String(url)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

export function escapeMarkdown(text) {
  if (!text) return '';
  // Only escape Markdown formatting characters; do not escape digits, dashes, or dots
  return String(text).replace(/([_*`[\]\\])/g, '\\$1');
}

/**
 * Safe message delivery with fallback. If Telegram rejects Markdown entities,
 * it retries sending as clean plain text so the notification is never dropped.
 */
async function safeSendMessage(chatId, text, options = { parse_mode: 'Markdown' }) {
  if (!botInstance || !chatId) return null;
  try {
    return await botInstance.sendMessage(chatId, text, options);
  } catch (err) {
    if (err.message?.includes('can\'t parse entities') && options?.parse_mode) {
      console.warn('[Telegram Bot] Markdown formatting notice — falling back to plain text delivery.');
      try {
        const plain = text.replace(/[*_`]/g, '');
        return await botInstance.sendMessage(chatId, plain);
      } catch (fallbackErr) {
        console.error('[Telegram Bot] Message fallback delivery failed:', fallbackErr.message);
      }
    } else {
      console.warn('[Telegram Bot] Send message notice:', err.code || err.message);
    }
    return null;
  }
}

/**
 * Safe message editor with fallback.
 */
async function safeEditMessage(chatId, messageId, text, options = { parse_mode: 'Markdown' }) {
  if (!botInstance || !chatId || !messageId) return null;
  try {
    return await botInstance.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
  } catch (err) {
    if (err.message?.includes('message is not modified')) {
      return null;
    }
    if (err.message?.includes('can\'t parse entities') && options?.parse_mode) {
      try {
        const plain = text.replace(/[*_`]/g, '');
        return await botInstance.editMessageText(plain, {
          chat_id: chatId,
          message_id: messageId
        });
      } catch (_) {}
    } else {
      console.warn('[Telegram Bot] Edit message notice:', err.code || err.message);
    }
    return null;
  }
}

export default {
  initTelegramBot,
  notifyCompletion,
  notifyBackblazeB2Upload,
  isUserAllowed,
  formatLiveProgressMessage,
  startLiveTracking
};
