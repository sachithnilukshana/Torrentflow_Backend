import { verifyToken } from '../auth.js';

/**
 * Express middleware to protect API routes with JWT verification.
 */
export function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header is required (Format: Bearer <token>)'
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format. Expected "Bearer <token>"'
      });
    }

    const token = parts[1];
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: `Authentication failed: ${err.message}`
    });
  }
}

/**
 * Socket.IO authentication middleware.
 * Verifies JWT from socket.handshake.auth.token or socket.handshake.headers.authorization
 */
export function socketAuthMiddleware(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.split(' ')[1]
        : null) ||
      socket.handshake.query?.token;

    if (!token) {
      return next(new Error('Authentication required for WebSocket connection'));
    }

    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error(`WebSocket authentication error: ${err.message}`));
  }
}

export default requireAuth;

