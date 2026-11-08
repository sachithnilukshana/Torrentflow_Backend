import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import jwt from 'jsonwebtoken';
import config from './config.js';
import { verifyAdminCredentials, generateToken } from './auth.js';
import requireAuth from './middleware/requireAuth.js';
import errorHandler, { notFoundHandler } from './middleware/errorHandler.js';
import torrentManager from './torrentManager.js';
import { uploadFileToBackblazeB2, downloadBackblazeB2File, authorize, getAuthorizedDownloadUrl } from './backblazeB2.js';
import { findMovieByInfoHash, findMovieByAccessKey, getMovie, getPlaybackMovie, listMovies, registerUploadedMovie, updateMovieMetadata } from './movieCatalogue.js';
import { notifyBackblazeB2Upload } from './telegramBot.js';
import { broadcast } from './socket.js';

const app = express();
// Render terminates TLS before forwarding to this Node process.
app.set('trust proxy', 1);

// CORS setup
const envOrigins = (config.frontendOrigin || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...envOrigins,
  'https://torrentflowfronteend.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      try {
        const parsed = new URL(origin);
        if (
          config.frontendOrigin === '*' ||
          allowedOrigins.includes(origin) ||
          parsed.hostname === 'torrentflowfronteend.vercel.app' ||
          parsed.hostname.endsWith('.vercel.app')
        ) {
          return callback(null, true);
        }
      } catch {
        /* invalid origin URL */
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
    credentials: true
  })
);

app.use(express.json());

// Global API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' }
});
app.use('/api/', apiLimiter);

// Specific brute-force protection for login
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // max 20 login attempts per 15 minutes per IP
  message: { success: false, error: 'Too many login attempts. Please wait 15 minutes before retrying.' }
});

// Configure Multer for .torrent file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxTorrentUploadMb * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.torrent') || file.mimetype.includes('bittorrent')) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type: Only .torrent files are accepted.'));
    }
  }
});

/* =========================================================================
   PUBLIC ROUTES
   ========================================================================= */

// Health Check
app.get('/api/health', (req, res) => {
  const stats = torrentManager.getSystemStats();
  const backblazeB2 = torrentManager.getBackblazeB2Settings();
  res.json({
    success: true,
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    stats,
    // No credential is returned to the browser.
    autoUpload: backblazeB2.autoUploadEnabled,
    backblazeB2
  });
});

// Admin Login
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required.'
      });
    }

    const isValid = await verifyAdminCredentials(username, password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid administrator credentials.'
      });
    }

    const token = generateToken({ username });
    return res.json({
      success: true,
      message: 'Authentication successful.',
      token,
      user: {
        username
      }
    });
  } catch (err) {
    next(err);
  }
});

// Public Movie Access via Hash / Unique Access Key (No login required)
app.get('/api/public/watch/:accessKey', async (req, res) => {
  const { accessKey } = req.params;
  const movie = findMovieByAccessKey(accessKey);
  if (!movie) {
    return res.status(404).json({
      success: false,
      error: 'Invalid or expired Movie Access Key. Please check the key provided in Telegram.'
    });
  }

  // Generate 12-hour signed playback token
  const token = jwt.sign(
    { purpose: 'movie-playback', movieId: movie.id, accessKey: movie.accessKey },
    config.jwtSecret,
    { expiresIn: '12h' }
  );

  let directUrl = null;
  if (movie.objectKey) {
    try {
      const auth = await authorize();
      directUrl = await getAuthorizedDownloadUrl(auth, movie.objectKey);
    } catch (_) {}
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  return res.json({
    success: true,
    movie: {
      id: movie.id,
      title: movie.title,
      filename: movie.filename,
      size: movie.size,
      accessKey: movie.accessKey,
      uploadedBy: movie.uploadedBy || { displayName: 'Telegram User' },
      uploadedAt: movie.createdAt || movie.updatedAt,
      directUrl,
      source: {
        src: `${baseUrl}/api/movies/${encodeURIComponent(movie.id)}/stream?token=${encodeURIComponent(token)}`,
        type: 'auto'
      },
      subtitles: Array.isArray(movie.subtitles) ? movie.subtitles : []
    }
  });
});

/* =========================================================================
   PROTECTED ROUTES (Require Valid JWT)
   ========================================================================= */

// Verify current session
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

// List all torrents and system statistics
app.get('/api/torrents', requireAuth, (req, res) => {
  const torrents = torrentManager.getAllTorrents();
  const stats = torrentManager.getSystemStats();
  res.json({
    success: true,
    torrents,
    stats
  });
});

// Movie catalogue and playback. B2 credentials never leave this process.
app.get('/api/movies', requireAuth, (_req, res) => res.json({ success: true, movies: listMovies() }));
app.get('/api/movies/by-hash/:hash', requireAuth, (req, res) => {
  const hash = torrentManager.normalizeInfoHash(req.params.hash);
  if (!hash) return res.status(400).json({ success: false, error: 'Torrent info hash must be a 40-character hexadecimal v1 hash.' });
  const movie = findMovieByInfoHash(hash);
  if (movie) return res.json({ success: true, state: 'playable', movie });
  const torrent = torrentManager.getTorrent(hash);
  if (torrent) {
    const upload = (torrent.backblazeB2Uploads || []).find((item) => item.status !== 'completed') || torrent.backblazeB2Uploads?.[0];
    return res.json({ success: true, state: upload?.status === 'failed' ? 'failed' : 'uploading', torrent: { infoHash: hash, name: torrent.name }, upload: upload ? { status: upload.status, error: upload.error || null, progress: upload.progress || 0 } : null });
  }
  return res.status(404).json({ success: false, error: 'No movie or torrent was found for this info hash.' });
});
app.get('/api/movies/:id', requireAuth, (req, res) => {
  const movie = getMovie(req.params.id);
  if (!movie) return res.status(404).json({ success: false, error: 'Movie not found.' });
  return res.json({ success: true, movie });
});
app.put('/api/movies/:id', requireAuth, (req, res) => {
  const movie = updateMovieMetadata(req.params.id, req.body || {});
  if (!movie) return res.status(404).json({ success: false, error: 'Movie not found.' });
  return res.json({ success: true, movie });
});
app.get('/api/movies/:id/playback', requireAuth, (req, res) => {
  const movie = getPlaybackMovie(req.params.id);
  if (!movie) return res.status(404).json({ success: false, error: 'Movie not found or not ready for playback.' });
  const token = jwt.sign({ purpose: 'movie-playback', movieId: movie.id }, config.jwtSecret, { expiresIn: '5m' });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return res.json({ success: true, id: movie.id, title: movie.title, year: movie.year, rating: movie.rating, runtime: movie.runtime, source: { src: `${baseUrl}/api/movies/${encodeURIComponent(movie.id)}/stream?token=${encodeURIComponent(token)}`, type: 'auto' }, subtitles: Array.isArray(movie.subtitles) ? movie.subtitles : [] });
});
app.get('/api/movies/:id/stream', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const claims = jwt.verify(token, config.jwtSecret);
    if (claims.purpose !== 'movie-playback' || claims.movieId !== req.params.id) return res.status(403).json({ success: false, error: 'Playback token is not valid for this movie.' });
    const movie = getPlaybackMovie(req.params.id);
    if (!movie) return res.status(404).json({ success: false, error: 'Movie not found or not ready for playback.' });
    await downloadBackblazeB2File(movie.b2FileId, req.headers.range, res);
  } catch (error) {
    if (!res.headersSent) res.status(error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 401 : error.statusCode === 404 ? 404 : 502).json({ success: false, error: error.message === 'jwt expired' ? 'Playback link expired. Reload the movie.' : error.message });
  }
});

// Add torrent via Magnet URI
app.post('/api/torrents/magnet', requireAuth, (req, res, next) => {
  try {
    const { magnet } = req.body || {};
    if (!magnet) {
      return res.status(400).json({
        success: false,
        error: 'Magnet URI is required.'
      });
    }

    const created = torrentManager.addTorrentFromMagnet(magnet);
    res.status(201).json({
      success: true,
      message: 'Magnet torrent added to queue.',
      torrent: created
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Add torrent via .torrent file upload
app.post('/api/torrents/file', requireAuth, upload.single('torrent'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        error: 'A .torrent file attachment is required in "torrent" field.'
      });
    }

    const created = await torrentManager.addTorrentFromFile(req.file.buffer, req.file.originalname);
    res.status(201).json({
      success: true,
      message: 'Torrent file parsed and queued.',
      torrent: created
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Pause Torrent
app.post('/api/torrents/:infoHash/pause', requireAuth, (req, res, next) => {
  try {
    const { infoHash } = req.params;
    const updated = torrentManager.pauseTorrent(infoHash);
    res.json({
      success: true,
      message: 'Torrent paused.',
      torrent: updated
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Resume Torrent
app.post('/api/torrents/:infoHash/resume', requireAuth, (req, res, next) => {
  try {
    const { infoHash } = req.params;
    const updated = torrentManager.resumeTorrent(infoHash);
    res.json({
      success: true,
      message: 'Torrent resumed.',
      torrent: updated
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Boost Torrent Speed (re-announces to trackers, unchokes wires, maximizes connections)
app.post('/api/torrents/:infoHash/boost', requireAuth, (req, res, next) => {
  try {
    const { infoHash } = req.params;
    const updated = torrentManager.boostTorrent(infoHash);
    res.json({
      success: true,
      message: 'Torrent swarm discovery and download boosted.',
      torrent: updated
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Remove Torrent
app.delete('/api/torrents/:infoHash', requireAuth, async (req, res, next) => {
  try {
    const { infoHash } = req.params;
    const deleteFiles = req.query.deleteFiles === 'true';
    const result = await torrentManager.removeTorrent(infoHash, { deleteFiles });
    res.json({
      success: true,
      message: deleteFiles ? 'Torrent and downloaded files removed.' : 'Torrent removed.',
      result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// List completed downloads in download directory
app.get('/api/downloads', requireAuth, (req, res) => {
  const files = torrentManager.getCompletedDownloadsList();
  res.json({
    success: true,
    files
  });
});

// Read or change the persisted automatic Backblaze B2-upload preference.
app.get('/api/backblazeB2/settings', requireAuth, (req, res) => {
  res.json({
    success: true,
    settings: torrentManager.getBackblazeB2Settings()
  });
});

app.put('/api/backblazeB2/settings', requireAuth, (req, res) => {
  try {
    const { autoUploadEnabled } = req.body || {};
    const settings = torrentManager.setAutoUploadEnabled(autoUploadEnabled);
    res.json({
      success: true,
      settings,
      message: settings.backblazeB2Configured || !settings.autoUploadEnabled
        ? 'Backblaze B2 automatic-upload setting saved.'
        : 'Automatic upload is enabled, but B2_API_TOKEN must be configured before uploads can start.'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Manual retry is only available for a previously failed, fully-completed file.
app.post('/api/torrents/:infoHash/backblazeB2/retry', requireAuth, (req, res) => {
  try {
    const updated = torrentManager.retryBackblazeB2Upload(req.params.infoHash, req.body?.filePath || null);
    res.status(202).json({
      success: true,
      message: 'Backblaze B2 upload retry queued.',
      torrent: updated
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Upload a standalone completed file to Backblaze B2. Tracked torrent files must use
// their queue so duplicates cannot bypass persisted upload state.
app.get('/api/backblazeB2/upload', requireAuth, (_req, res) => {
  res.set('Allow', 'POST').status(405).json({
    success: false,
    error: 'Upload requires POST with a completed filePath. Use the dashboard Upload button; do not open this API URL directly.'
  });
});

app.post('/api/backblazeB2/upload', requireAuth, async (req, res, next) => {
  try {
    const { filePath, infoHash } = req.body || {};

    let targetFilePath = filePath;

    if (!targetFilePath && infoHash) {
      const task = torrentManager.getTorrent(infoHash);
      if (!task || !task.files || task.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: `No files found for torrent hash: ${infoHash}`
        });
      }
      targetFilePath = task.files[0].path || task.files[0].name;
    }

    if (!targetFilePath) {
      return res.status(400).json({
        success: false,
        error: 'Either "filePath" or "infoHash" must be provided.'
      });
    }

    if (infoHash) {
      const task = torrentManager.getTorrent(infoHash);
      if (!task || task.status !== 'completed') {
        return res.status(400).json({
          success: false,
          error: 'Only fully completed torrents can be uploaded to Backblaze B2.'
        });
      }

      const existingUpload = (task.backblazeB2Uploads || []).find((upload) => upload.filePath === targetFilePath);
      if (existingUpload) {
        return res.status(409).json({
          success: false,
          error: existingUpload.status === 'failed'
            ? 'This Backblaze B2 upload failed. Use the Retry action so its state remains tracked.'
            : 'This completed torrent file is already waiting, uploading, or uploaded. Duplicate uploads are blocked.'
        });
      }
    }

    console.log(`[Backblaze B2] Initiating manual upload for: ${targetFilePath}`);

    const result = await uploadFileToBackblazeB2(targetFilePath, {
      onProgress: (p) => {
        broadcast('upload:progress', {
          filePath: targetFilePath,
          infoHash: infoHash || null,
          ...p
        });
      }
    });

    // Standalone uploads do not pass through TorrentManager's completion hook.
    // Register only after B2 has confirmed the file and its remote size.
    registerUploadedMovie({ filename: result.filename, size: result.size, b2FileId: result.id, objectKey: result.objectKey, torrentName: infoHash ? `Torrent ${infoHash}` : null, infoHash: infoHash ? torrentManager.normalizeInfoHash(infoHash) : null });

    broadcast('upload:completed', {
      filePath: targetFilePath,
      infoHash: infoHash || null,
      url: result.url,
      id: result.id
    });

    // Standalone/manual uploads do not pass through TorrentManager's
    // completion queue, so notify Telegram here after Backblaze B2 has confirmed
    // the share URL. Failure to deliver a notification must not turn a
    // successful, confirmed upload into an API failure.
    const telegramDelivered = await notifyBackblazeB2Upload(
      { name: infoHash ? `Torrent ${infoHash}` : result.filename },
      { filename: result.filename, url: result.url }
    );

    // Clean up local disk file after confirmed B2 upload
    if (config.deleteTemporaryFilesAfterUpload) {
      try {
        const fullPath = path.resolve(config.temporaryDownloadPath, targetFilePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          fs.unlinkSync(fullPath);
          console.log(`[Backblaze B2] Cleaned up temporary local file after manual upload: ${targetFilePath}`);
        }
      } catch (cleanupErr) {
        console.warn(`[Backblaze B2] Notice on post-upload cleanup: ${cleanupErr.message}`);
      }
    }

    res.json({
      success: true,
      message: 'File successfully uploaded to Backblaze B2.',
      upload: result,
      telegramDelivered
    });
  } catch (err) {
    broadcast('upload:error', {
      filePath: req.body?.filePath,
      error: err.message
    });
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Trigger Backblaze B2 expiration cleanup on demand (removes files older than 2 days)
app.post('/api/backblazeB2/cleanup', requireAuth, async (req, res, next) => {
  try {
    const result = await torrentManager.runBackblazeB2Cleanup();
    res.json({
      success: true,
      message: `Backblaze B2 cleanup complete. Removed ${result.deletedCount || 0} expired file(s).`,
      result
    });
  } catch (err) {
    next(err);
  }
});

// 404 and Error handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;

