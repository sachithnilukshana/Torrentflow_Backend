import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load .env explicitly relative to backend root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const envPath = path.join(backendRoot, '.env');
let temporaryDirectoryError = null;

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Also fallback to default dotenv lookup
  dotenv.config();
}

/**
 * Validates the loaded environment configuration.
 * Throws a descriptive error if critical configuration is missing or invalid.
 */
export function validateConfig(isStrict = false) {
  const errors = [];
  const warnings = [];

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    errors.push('JWT_SECRET is missing. Please set a strong secret in backend/.env');
  } else if (jwtSecret.includes('replace-with-a-random-secret') || jwtSecret.length < 16) {
    warnings.push('JWT_SECRET is using a default placeholder or is shorter than 16 characters. Use a secure random string.');
  }

  const adminUsername = process.env.ADMIN_USERNAME;
  if (!adminUsername || adminUsername.trim() === '') {
    errors.push('ADMIN_USERNAME is missing. Please configure an administrator username.');
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminPassword && !adminPasswordHash) {
    errors.push('ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) is missing. Set a password in backend/.env');
  } else if (adminPassword === 'change-this-password') {
    warnings.push('ADMIN_PASSWORD is set to the default "change-this-password". Change it for security.');
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(`PORT "${process.env.PORT}" is not a valid port number (1-65535).`);
  }

  const maxActive = parseInt(process.env.MAX_ACTIVE_TORRENTS || '3', 10);
  if (isNaN(maxActive) || maxActive < 1) {
    errors.push(`MAX_ACTIVE_TORRENTS must be a positive integer.`);
  }

  const maxUploadMb = parseInt(process.env.MAX_TORRENT_UPLOAD_MB || '5', 10);
  if (isNaN(maxUploadMb) || maxUploadMb < 1) {
    errors.push(`MAX_TORRENT_UPLOAD_MB must be a positive integer.`);
  }

  const b2MaxAttempts = parseInt(process.env.B2_UPLOAD_MAX_ATTEMPTS || '3', 10);
  if (isNaN(b2MaxAttempts) || b2MaxAttempts < 1 || b2MaxAttempts > 10) {
    errors.push('B2_UPLOAD_MAX_ATTEMPTS must be an integer between 1 and 10.');
  }

  const b2RetryDelaySeconds = parseInt(process.env.B2_RETRY_DELAY_SECONDS || '15', 10);
  if (isNaN(b2RetryDelaySeconds) || b2RetryDelaySeconds < 1 || b2RetryDelaySeconds > 3600) {
    errors.push('B2_RETRY_DELAY_SECONDS must be an integer between 1 and 3600.');
  }

  if (temporaryDirectoryError) {
    errors.push(`TEMP_DOWNLOAD_PATH is not writable: ${temporaryDirectoryError}`);
  }

  if (errors.length > 0) {
    const errorMsg = [
      '=================================================================',
      'Configuration Error: Failed to start TorrentFlow backend!',
      'Please verify your backend/.env configuration:',
      ...errors.map((err) => `  - [ERROR] ${err}`),
      ...warnings.map((w) => `  - [WARN]  ${w}`),
      '================================================================='
    ].join('\n');
    throw new Error(errorMsg);
  }

  if (warnings.length > 0 && process.env.NODE_ENV !== 'test') {
    console.warn('\n[TorrentFlow Config Warnings]:');
    warnings.forEach((w) => console.warn(`  - ${w}`));
    console.warn('');
  }
}

// Compute safe resolved paths
const rawDownloadPath = process.env.DOWNLOAD_PATH || './downloads';
export const resolvedDownloadPath = path.isAbsolute(rawDownloadPath)
  ? path.resolve(rawDownloadPath)
  : path.resolve(backendRoot, rawDownloadPath);

const rawTemporaryDownloadPath = process.env.TEMP_DOWNLOAD_PATH || './temp-downloads';
export const resolvedTemporaryDownloadPath = path.isAbsolute(rawTemporaryDownloadPath)
  ? path.resolve(rawTemporaryDownloadPath)
  : path.resolve(backendRoot, rawTemporaryDownloadPath);
const rawMovieCataloguePath = process.env.MOVIE_CATALOGUE_PATH || './movie-catalogue.json';
export const resolvedMovieCataloguePath = path.isAbsolute(rawMovieCataloguePath) ? path.resolve(rawMovieCataloguePath) : path.resolve(backendRoot, rawMovieCataloguePath);

// Ensure WebTorrent's temporary working directory exists.
try {
  if (!fs.existsSync(resolvedTemporaryDownloadPath)) {
    fs.mkdirSync(resolvedTemporaryDownloadPath, { recursive: true });
  }
} catch (err) {
  temporaryDirectoryError = err.message;
  console.error(`Failed to create temporary download directory "${resolvedTemporaryDownloadPath}":`, err.message);
}

// Parse Telegram allowed user IDs
const rawTelegramUsers = process.env.TELEGRAM_ALLOWED_USER_IDS || '';
const parsedTelegramAllowedIds = rawTelegramUsers
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s))
  .map((s) => Number(s));

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-at-least-32-chars-long-torrentflow',
  jwtExpiresIn: '7d',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : 'change-this-password',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ? process.env.ADMIN_PASSWORD_HASH.trim() : null,
  downloadPath: resolvedDownloadPath,
  temporaryDownloadPath: resolvedTemporaryDownloadPath,
  movieCataloguePath: resolvedMovieCataloguePath,
  maxActiveTorrents: parseInt(process.env.MAX_ACTIVE_TORRENTS || '3', 10),
  maxConnections: parseInt(process.env.MAX_CONNECTIONS || '1000', 10),
  torrentPort: parseInt(process.env.TORRENT_PORT || '6881', 10),
  dhtPort: parseInt(process.env.DHT_PORT || '6881', 10),
  torrentStrategy: process.env.TORRENT_STRATEGY || 'rarest',
  storeCacheSlots: parseInt(process.env.STORE_CACHE_SLOTS || '128', 10),
  maxTorrentUploadMb: parseInt(process.env.MAX_TORRENT_UPLOAD_MB || '5', 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : '',
  telegramAllowedUserIds: parsedTelegramAllowedIds,
  b2ApplicationKeyId: process.env.B2_APPLICATION_KEY_ID ? process.env.B2_APPLICATION_KEY_ID.trim() : '',
  b2ApplicationKey: process.env.B2_APPLICATION_KEY ? process.env.B2_APPLICATION_KEY.trim() : '',
  b2BucketId: process.env.B2_BUCKET_ID ? process.env.B2_BUCKET_ID.trim() : '',
  b2BucketName: process.env.B2_BUCKET_NAME ? process.env.B2_BUCKET_NAME.trim() : '',
  b2PublicUrlBase: process.env.B2_PUBLIC_URL_BASE ? process.env.B2_PUBLIC_URL_BASE.trim() : '',
  backblazeB2ApiToken: process.env.B2_APPLICATION_KEY ? process.env.B2_APPLICATION_KEY.trim() : '',
  autoUploadToBackblazeB2: String(process.env.AUTO_UPLOAD_TO_BACKBLAZE_B2).toLowerCase() === 'true',
  backblazeB2UploadMaxAttempts: parseInt(process.env.B2_UPLOAD_MAX_ATTEMPTS || '5', 10),
  backblazeB2RetryDelayMs: parseInt(process.env.B2_RETRY_DELAY_SECONDS || '10', 10) * 1000,
  backblazeB2PartSizeBytes: Math.max(5 * 1024 * 1024, parseInt(process.env.B2_PART_SIZE_MIB || '64', 10) * 1024 * 1024),
  backblazeB2ParallelParts: Math.min(16, Math.max(1, parseInt(process.env.B2_PARALLEL_PARTS || '6', 10))),
  deleteTemporaryFilesAfterUpload: String(process.env.DELETE_TEMP_AFTER_B2_UPLOAD || 'true').toLowerCase() !== 'false',
  b2RetentionDays: parseInt(process.env.B2_RETENTION_DAYS || '2', 10),
  nodeEnv: process.env.NODE_ENV || 'development'
};

export default config;

