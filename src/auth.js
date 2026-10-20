import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

let cachedHashedPassword = null;

/**
 * Initializes or resolves the bcrypt hash for the configured admin password.
 */
export async function getAdminPasswordHash() {
  if (config.adminPasswordHash) {
    return config.adminPasswordHash;
  }
  if (!cachedHashedPassword && config.adminPassword) {
    // Generate bcrypt hash with 10 salt rounds
    cachedHashedPassword = await bcrypt.hash(config.adminPassword, 10);
  }
  return cachedHashedPassword;
}

/**
 * Verifies admin login credentials securely using bcrypt.
 * @param {string} username 
 * @param {string} password 
 * @returns {Promise<boolean>}
 */
export async function verifyAdminCredentials(username, password) {
  if (!username || !password) {
    return false;
  }

  // Constant-time-like check for username match
  const expectedUsername = config.adminUsername;
  if (username !== expectedUsername) {
    // Still run a dummy hash check to mitigate timing attacks
    await bcrypt.compare(password, '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012');
    return false;
  }

  const hash = await getAdminPasswordHash();
  if (!hash) {
    return false;
  }

  return await bcrypt.compare(password, hash);
}

/**
 * Generates a signed JWT for the authenticated admin user.
 * @param {object} payload 
 * @returns {string} JWT token
 */
export function generateToken(payload = {}) {
  const tokenPayload = {
    username: config.adminUsername,
    role: 'admin',
    ...payload
  };
  return jwt.sign(tokenPayload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn
  });
}

/**
 * Verifies a JWT token.
 * @param {string} token 
 * @returns {object} Decoded token payload
 */
export function verifyToken(token) {
  if (!token) {
    throw new Error('Token is missing');
  }
  return jwt.verify(token, config.jwtSecret);
}

export default {
  verifyAdminCredentials,
  generateToken,
  verifyToken,
  getAdminPasswordHash
};

