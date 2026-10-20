import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import app from '../src/app.js';
import config from '../src/config.js';
import { shutdownTorrentManager } from '../src/torrentManager.js';

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
});

