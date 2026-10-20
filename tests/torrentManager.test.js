/**
 * TorrentManager Core Logic Tests
 *
 * Pure-logic tests (no live engine) run first.
 * Registry tests start a real WebTorrent engine and tear it down in after().
 * After all suites complete, process.exit(0) ensures the event loop closes
 * even if WebTorrent's DHT sockets linger briefly.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInfoHash,
  formatTorrentOutput,
  addTorrentFromMagnet,
  getTorrent,
  removeTorrent,
  shutdownTorrentManager
} from '../src/torrentManager.js';

const TEST_INFO_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
const TEST_MAGNET    = `magnet:?xt=urn:btih:${TEST_INFO_HASH}&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969`;

// ── Pure-logic helpers (no engine) ──────────────────────────────────────────

describe('normalizeInfoHash', () => {
  test('lowercases and trims hex string', () => {
    assert.equal(
      normalizeInfoHash('  08ADA5A7A6183AAE1E09D831DF6748D566095A10  '),
      TEST_INFO_HASH
    );
  });

  test('returns empty string for falsy input', () => {
    assert.equal(normalizeInfoHash(''), '');
    assert.equal(normalizeInfoHash(null), '');
    assert.equal(normalizeInfoHash(undefined), '');
  });
});

// ── formatTorrentOutput guard ───────────────────────────────────────────────

describe('formatTorrentOutput', () => {
  test('never reports 1.0 progress for an in-progress downloading torrent', () => {
    const dummyTask = {
      infoHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      name: 'Sample Torrent',
      totalSize: 1000,
      downloadedSize: 999,
      status: 'downloading',
      progress: 0.999,
      _engine: null
    };
    const out = formatTorrentOutput(dummyTask);
    assert.ok(out.progress < 1, 'In-progress torrent must not reach 1.0');
    assert.notEqual(out.status, 'completed');
  });

  test('reports 1.0 progress for a completed torrent', () => {
    const dummyTask = {
      infoHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      name: 'Completed',
      totalSize: 1000,
      downloadedSize: 1000,
      status: 'completed',
      progress: 1,
      _engine: null
    };
    const out = formatTorrentOutput(dummyTask);
    assert.equal(out.progress, 1);
    assert.equal(out.status, 'completed');
  });
});

// ── Magnet-URI validation (no engine started yet) ───────────────────────────

describe('addTorrentFromMagnet – validation', () => {
  test('rejects a plain non-magnet string', () => {
    assert.throws(
      () => addTorrentFromMagnet('not-a-magnet'),
      /must begin with "magnet:\?"/
    );
  });

  test('rejects a magnet URI missing the info-hash (xt=urn:btih:…)', () => {
    assert.throws(
      () => addTorrentFromMagnet('magnet:?dn=MissingXtParam'),
      /missing exact topic/
    );
  });
});

// ── Registry tests (engine is started; must be torn down afterwards) ────────

describe('TorrentManager registry', () => {
  after(async () => {
    // Destroy the WebTorrent engine. If it takes more than 4 s (DHT sockets
    // lingering on Windows), force-exit so CI/tests don't hang.
    const forceExit = setTimeout(() => process.exit(0), 4000).unref();
    try {
      await shutdownTorrentManager();
    } catch (_) {
      // ignore
    }
    clearTimeout(forceExit);
    // Give the test runner a moment to print the summary, then exit.
    setTimeout(() => process.exit(0), 200).unref();
  });

  test('addTorrentFromMagnet registers torrent and sets initial state', () => {
    const result = addTorrentFromMagnet(TEST_MAGNET);
    assert.equal(result.infoHash, TEST_INFO_HASH);
    assert.equal(result.name, 'Sintel');
    assert.ok(
      ['queued', 'metadata', 'downloading'].includes(result.status),
      `Unexpected status: ${result.status}`
    );
  });

  test('addTorrentFromMagnet rejects a duplicate info-hash', () => {
    assert.throws(
      () => addTorrentFromMagnet(TEST_MAGNET),
      /already added/
    );
  });

  test('getTorrent returns the registered torrent', () => {
    const t = getTorrent(TEST_INFO_HASH);
    assert.ok(t, 'Expected torrent to be found');
    assert.equal(t.infoHash, TEST_INFO_HASH);
  });

  test('removeTorrent removes the entry and returns success', async () => {
    const res = await removeTorrent(TEST_INFO_HASH, { deleteFiles: false });
    assert.equal(res.success, true);
    assert.equal(getTorrent(TEST_INFO_HASH), null);
  });
});
