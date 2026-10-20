import http from 'http';
import app from './app.js';
import config, { validateConfig } from './config.js';
import { initTorrentManager, shutdownTorrentManager, getAllTorrents, getSystemStats } from './torrentManager.js';
import { initSocketIO } from './socket.js';
import { initTelegramBot } from './telegramBot.js';

// Validate environment configuration immediately
try {
  validateConfig();
} catch (cfgErr) {
  console.error(cfgErr.message);
  process.exit(1);
}

// Create HTTP server wrapping Express
const server = http.createServer(app);

// Initialize Socket.IO with snapshot callback
initSocketIO(server, () => {
  return {
    torrents: getAllTorrents(),
    stats: getSystemStats()
  };
});

// Initialize Torrent Manager
initTorrentManager();

// Initialize Telegram Bot (if token provided)
initTelegramBot();

const PORT = config.port;

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(` TorrentFlow Backend Server running on port ${PORT}`);
  console.log(` Downloads directory: ${config.downloadPath}`);
  console.log(` Max concurrent downloads: ${config.maxActiveTorrents}`);
  console.log(` Frontend origin: ${config.frontendOrigin}`);
  console.log('====================================================');
});

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Gracefully stopping TorrentFlow...`);

  try {
    await shutdownTorrentManager();
  } catch (err) {
    console.error('[Server] Error during torrent manager shutdown:', err.message);
  }

  server.close(() => {
    console.log('[Server] HTTP and WebSocket server closed.');
    process.exit(0);
  });

  // Force exit after 5 seconds if still hanging
  setTimeout(() => {
    console.warn('[Server] Forcing process exit after timeout.');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection at Promise]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
});

