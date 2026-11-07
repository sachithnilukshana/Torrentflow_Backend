import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import app from '../src/app.js';
import config from '../src/config.js';
import { shutdownTorrentManager } from '../src/torrentManager.js';
import { registerUploadedMovie, removeMovieByB2FileId } from '../src/movieCatalogue.js';

describe('HTTP API End-to-End Integration Tests', () => {
  let server;
  let baseUrl;
  let validToken;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Force-exit guard: if DHT/UDP sockets linger on Windows, exit after 4 s.
    const forceExit = setTimeout(() => process.exit(0), 4000).unref();
    try {
      await shutdownTorrentManager();
    } catch (_) {}
    if (server && server.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    clearTimeout(forceExit);
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('GET /api/health returns 200 and system stats', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'ok');
    assert.ok(data.stats);
  });

  test('POST /api/auth/login with wrong password returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.adminUsername, password: 'wrong-password' })
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /Invalid administrator credentials/i);
  });

  test('POST /api/auth/login with correct password returns 200 and JWT', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.token);
    validToken = data.token;
  });

  test('GET /api/torrents without token returns 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/torrents`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  test('GET /api/torrents with valid token returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/torrents`, {
      headers: { Authorization: `Bearer ${validToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.torrents));
  });

  test('movie catalogue and playback endpoints require authentication', async () => {
    const movies = await fetch(`${baseUrl}/api/movies`);
    assert.equal(movies.status, 401);
    const playback = await fetch(`${baseUrl}/api/movies/not-a-real-movie/playback`);
    assert.equal(playback.status, 401);
  });

  test('movie catalogue lists only registered completed uploads and rejects missing movies', async () => {
    const list = await fetch(`${baseUrl}/api/movies`, { headers: { Authorization: `Bearer ${validToken}` } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).success, true);
    const missing = await fetch(`${baseUrl}/api/movies/not-a-real-movie`, { headers: { Authorization: `Bearer ${validToken}` } });
    assert.equal(missing.status, 404);
  });

  test('registerUploadedMovie and removeMovieByB2FileId manage catalogue lifecycle', () => {
    const registered = registerUploadedMovie({
      filename: 'sample-lifecycle-movie.mkv',
      size: 1024,
      b2FileId: 'mock-file-id-12345',
      objectKey: 'torrentflow/sample-lifecycle-movie.mkv'
    });
    assert.equal(registered.filename, 'sample-lifecycle-movie.mkv');
    const removed = removeMovieByB2FileId('mock-file-id-12345');
    assert.equal(removed, true);
    assert.equal(removeMovieByB2FileId('mock-file-id-12345'), false);
  });

  test('GET /api/public/watch/:accessKey returns 404 on invalid key and 200 with movie + uploader on valid key', async () => {
    const invalid = await fetch(`${baseUrl}/api/public/watch/INVALID-KEY-9999`);
    assert.equal(invalid.status, 404);
    const invalidData = await invalid.json();
    assert.equal(invalidData.success, false);

    // Register a test movie with an access key and Telegram uploader
    const testKey = 'TF-TEST9999ABCD';
    registerUploadedMovie({
      filename: 'public-watch-movie.mkv',
      size: 5242880,
      b2FileId: 'mock-public-watch-b2-id',
      objectKey: 'torrentflow/public-watch-movie.mkv',
      accessKey: testKey,
      telegramUser: {
        id: 12345678,
        username: 'cinephile_test',
        displayName: '@cinephile_test'
      }
    });

    const res = await fetch(`${baseUrl}/api/public/watch/${testKey}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.movie.accessKey, testKey);
    assert.equal(data.movie.uploadedBy.displayName, '@cinephile_test');
    assert.ok(data.movie.source.src.includes('/stream?token='));

    // Cleanup
    removeMovieByB2FileId('mock-public-watch-b2-id');
  });

  test('hash lookup validates v1 info hashes and returns not-found safely', async () => {
    const headers = { Authorization: `Bearer ${validToken}` };
    const invalid = await fetch(`${baseUrl}/api/movies/by-hash/not-a-hash`, { headers });
    assert.equal(invalid.status, 400);
    const missing = await fetch(`${baseUrl}/api/movies/by-hash/${'a'.repeat(40)}`, { headers });
    assert.equal(missing.status, 404);
  });

  test('POST /api/torrents/magnet with invalid magnet returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/torrents/magnet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`
      },
      body: JSON.stringify({ magnet: 'invalid-non-magnet' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /magnet:\?/);
  });

  test('POST /api/backblazeB2/upload with nonexistent file returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/backblazeB2/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`
      },
      body: JSON.stringify({ filePath: 'missing-nonexistent-file.bin' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /File not found/i);
  });

  test('POST /api/backblazeB2/upload with path traversal returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/backblazeB2/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validToken}`
      },
      body: JSON.stringify({ filePath: '../../../../windows/win.ini' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.error, /escapes the configured temporary directory/i);
  });

  test('POST /api/backblazeB2/cleanup requires auth and returns 200 with result', async () => {
    const unauth = await fetch(`${baseUrl}/api/backblazeB2/cleanup`, { method: 'POST' });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${baseUrl}/api/backblazeB2/cleanup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${validToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(typeof data.result?.deletedCount === 'number');
  });
});

