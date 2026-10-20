import TelegramBot from 'node-telegram-bot-api';
import https from 'https';
import config from './config.js';
import torrentManager from './torrentManager.js';

let botInstance = null;
let completionHookRegistered = false;
let backblazeB2UploadHookRegistered = false;

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
 * Initializes the Telegram Bot with polling, security allowlist, and command handlers.
 */
export function initTelegramBot() {
  const token = config.telegramBotToken;
  if (!token) {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided. Telegram bot is disabled.');
    return null;
  }

  // Avoid duplicate polling clients and duplicate notification listeners when
  // initialization is triggered more than once by a hot reload or test host.
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
      // Suppress token leakage and log clean message
      console.warn('[Telegram Bot Polling Notice]:', error.code || error.message);
    });

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
        `Control your WebTorrent downloads remotely:\n` +
        `• \`/status\` - View active downloads and server speeds\n` +
        `• \`/list\` - List all downloads\n` +
        `• \`/add <magnet>\` - Add a magnet link\n` +
        `• \`/pause <hash>\` - Pause a download\n` +
        `• \`/resume <hash>\` - Resume a download\n` +
        `• \`/remove <hash>\` - Remove a torrent\n` +
        `• \`/help\` - Detailed help\n\n` +
        `You can also send a \`.torrent\` file directly as an attachment!`;
      botInstance.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    });

    // /help command
    botInstance.onText(/\/help/, (msg) => {
      if (!checkAuth(msg)) return;
      const text =
        `📖 *TorrentFlow Command Reference*\n\n` +
        `• \`/add <magnet-uri>\`\n  Starts downloading a magnet link.\n\n` +
        `• \`/status\`\n  Displays currently active torrents with live speed & progress.\n\n` +
        `• \`/list\`\n  Displays all active and completed tasks.\n\n` +
        `• \`/pause <infoHash>\`\n  Pauses the specified torrent.\n\n` +
        `• \`/resume <infoHash>\`\n  Resumes a paused torrent.\n\n` +
        `• \`/remove <infoHash>\`\n  Removes the torrent task.\n\n` +
        `• Attach a \`.torrent\` file\n  Automatically queues the torrent for download (up to ${config.maxTorrentUploadMb}MB).`;
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

      if (active.length === 0) {
        reply += `_No active downloads running._`;
      } else {
        active.forEach((t, i) => {
          const bar = renderProgressBar(t.progress);
          reply += `*${i + 1}. ${escapeMarkdown(t.name)}*\n`;
          reply += `   [${bar}] ${t.progressPercent}%\n`;
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
        text += `   Status: \`${t.status}\` | ${formatBytes(t.totalSize)} | ${t.progressPercent}%\n`;
        text += `   Hash: \`${t.infoHash}\`\n`;
        if (t.backblazeB2Url) {
          text += `   🔗 [Backblaze B2 Link](${t.backblazeB2Url})\n`;
        }
        text += `\n`;
      });

      botInstance.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
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
        const added = torrentManager.addTorrentFromMagnet(magnetLink);
        botInstance.sendMessage(
          msg.chat.id,
          `✅ *Torrent Added!*\n*Name:* ${escapeMarkdown(added.name)}\n*Status:* \`${added.status}\`\n*Hash:* \`${added.infoHash}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        botInstance.sendMessage(
          msg.chat.id,
          `❌ *Failed to add torrent:*\n${escapeMarkdown(err.message)}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // /pause <hash>
    botInstance.onText(/\/pause(?:\s+(.+))?/, (msg, match) => {
      if (!checkAuth(msg)) return;
      const hash = match[1]?.trim();
      if (!hash) {
        return botInstance.sendMessage(msg.chat.id, '⚠️ *Usage:* `/pause <infoHash>`', { parse_mode: 'Markdown' });
      }

      try {
        const updated = torrentManager.pauseTorrent(hash);
        botInstance.sendMessage(msg.chat.id, `⏸️ Paused torrent: *${escapeMarkdown(updated.name)}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        botInstance.sendMessage(msg.chat.id, `❌ Error: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
      }
    });

    // /resume <hash>
    botInstance.onText(/\/resume(?:\s+(.+))?/, (msg, match) => {
      if (!checkAuth(msg)) return;
      const hash = match[1]?.trim();
      if (!hash) {
        return botInstance.sendMessage(msg.chat.id, '⚠️ *Usage:* `/resume <infoHash>`', { parse_mode: 'Markdown' });
      }

      try {
        const updated = torrentManager.resumeTorrent(hash);
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

      // Check configured max upload limit
      const maxBytes = config.maxTorrentUploadMb * 1024 * 1024;
      if (doc.file_size && doc.file_size > maxBytes) {
        return botInstance.sendMessage(
          msg.chat.id,
          `❌ File too large (${formatBytes(doc.file_size)}). Maximum allowed size is ${config.maxTorrentUploadMb}MB.`,
          { parse_mode: 'Markdown' }
        );
      }

      try {
        // Download document buffer via Telegram Bot API
        const fileStream = botInstance.getFileStream(doc.file_id);
        const chunks = [];
        for await (const chunk of fileStream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        const added = await torrentManager.addTorrentFromFile(buffer, fileName);
        botInstance.sendMessage(
          msg.chat.id,
          `✅ *Torrent File Queued!*\n*Name:* ${escapeMarkdown(added.name)}\n*Size:* ${formatBytes(added.totalSize)}\n*Hash:* \`${added.infoHash}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        botInstance.sendMessage(
          msg.chat.id,
          `❌ Failed to parse .torrent file: ${escapeMarkdown(err.message)}`,
          { parse_mode: 'Markdown' }
        );
      }
    });

    // Register notification hooks once. Completion still announces the local
    // download; the confirmed Backblaze B2 link is sent separately below.
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

    console.log('[Telegram Bot] Initialized successfully and polling for commands.');
  } catch (err) {
    console.error('[Telegram Bot Initialization Error]:', err.message);
  }

  return botInstance;
}

/**
 * Sends a notification to all allowed Telegram users when a torrent download finishes.
 */
export function notifyCompletion(torrent) {
  if (!botInstance || !config.telegramAllowedUserIds || config.telegramAllowedUserIds.length === 0) {
    return;
  }

  const message =
    `🎉 *Download Completed!*\n\n` +
    `*Name:* ${escapeMarkdown(torrent.name)}\n` +
    `*Size:* ${formatBytes(torrent.totalSize)}\n` +
    `*Hash:* \`${torrent.infoHash}\`\n` +
    `Preparing Backblaze B2 upload.`;

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
 * Sends a confirmed Backblaze B2 link only after the upload service returned an
 * official file ID. The optional bot parameter keeps this delivery logic
 * testable without a Telegram connection.
 */
export async function notifyBackblazeB2Upload(torrent, upload, bot = botInstance) {
  const url = upload?.url;
  const configuredPublicBase = config.b2PublicUrlBase?.replace(/\/$/, '');
  const isTrustedB2Url = /^https:\/\/[^/]*\.backblazeb2\.com\/file\/.+/.test(url || '') ||
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

  const message =
    `*Backblaze B2 upload complete!*\n\n` +
    `*File:* ${escapeMarkdown(upload.filename || torrent.name)}\n` +
    `*Torrent:* ${escapeMarkdown(torrent.name)}\n` +
    `*Download link:* [Open in Backblaze B2](${url})`;

  const deliveries = await Promise.all(config.telegramAllowedUserIds.map(async (userId) => {
    try {
      await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
      return true;
    } catch (err) {
      // Do not include the bot token or link in diagnostic output.
      console.warn(`[Telegram Bot] Backblaze B2 link delivery failed for ${userId}:`, err.code || 'request failed');
      return false;
    }
  }));

  return deliveries.some(Boolean);
}

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}

export default {
  initTelegramBot,
  notifyCompletion,
  notifyBackblazeB2Upload,
  isUserAllowed
};

