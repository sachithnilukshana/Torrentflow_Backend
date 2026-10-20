import { Server } from 'socket.io';
import { socketAuthMiddleware } from './middleware/requireAuth.js';
import config from './config.js';

let ioInstance = null;

/**
 * Initializes Socket.IO with CORS, JWT authentication, and event channels.
 * @param {import('http').Server} server 
 * @returns {Server}
 */
export function initSocketIO(server, getSnapshotCallback) {
  ioInstance = new Server(server, {
    cors: {
      origin: config.frontendOrigin === '*' ? true : [config.frontendOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Enforce JWT authentication on connection
  ioInstance.use(socketAuthMiddleware);

  ioInstance.on('connection', (socket) => {
    // console.log(`[Socket.IO] Client connected: ${socket.id} (User: ${socket.user?.username})`);

    // Send initial snapshot of all torrents and system status
    if (typeof getSnapshotCallback === 'function') {
      try {
        const snapshot = getSnapshotCallback();
        socket.emit('torrent:snapshot', snapshot);
      } catch (err) {
        console.error('[Socket.IO] Error preparing snapshot:', err.message);
      }
    }

    socket.on('disconnect', (reason) => {
      // console.log(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  return ioInstance;
}

/**
 * Returns the active Socket.IO server instance.
 */
export function getIO() {
  return ioInstance;
}

/**
 * Broadcasts an event with data to all authenticated connected clients.
 * @param {string} event 
 * @param {*} data 
 */
export function broadcast(event, data) {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }
}

export default {
  initSocketIO,
  getIO,
  broadcast
};

