import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUserAllowed, notifyBackblazeB2Upload, formatLiveProgressMessage } from '../src/telegramBot.js';
import config from '../src/config.js';

describe('Telegram Bot Security Tests', () => {
  test('isUserAllowed rejects null, undefined, or empty user IDs', () => {
    assert.equal(isUserAllowed(null), false);
    assert.equal(isUserAllowed(undefined), false);
    assert.equal(isUserAllowed(''), false);
    assert.equal(isUserAllowed('not-a-number'), false);
  });

  test('isUserAllowed rejects arbitrary unapproved user IDs', () => {
    assert.equal(isUserAllowed(9999999999), false);
    assert.equal(isUserAllowed('123456789'), false);
  });

  test('isUserAllowed accepts user ID when included in allowlist', () => {
    const testId = 424242;
    config.telegramAllowedUserIds.push(testId);
    assert.equal(isUserAllowed(testId), true);
    assert.equal(isUserAllowed(String(testId)), true);

    // cleanup
    const idx = config.telegramAllowedUserIds.indexOf(testId);
    if (idx !== -1) config.telegramAllowedUserIds.splice(idx, 1);
  });

  test('delivers only a confirmed Backblaze B2 URL through Telegram', async () => {
    const testId = 424243;
    const calls = [];
    const fakeBot = {
      sendMessage: async (...args) => {
        calls.push(args);
      }
    };
    config.telegramAllowedUserIds.push(testId);

    try {
      const delivered = await notifyBackblazeB2Upload(
        { name: 'Example Torrent' },
        { filename: 'finished-file.mkv', url: 'https://f000.backblazeb2.com/file/example-bucket/finished-file.mkv' },
        fakeBot
      );

      assert.equal(delivered, true);
      const delivery = calls.find(([userId]) => userId === testId);
      assert.ok(delivery, 'Expected the allowed Telegram user to receive the link');
      assert.ok(delivery[1].includes('finished-file.mkv'));
      assert.ok(delivery[1].includes('🎉 *Download Completed!*'), 'Expected "🎉 Download Completed!" header');
      assert.ok(delivery[1].includes('Movie Access Key'), 'Expected Movie Access Key in Telegram delivery');
      assert.ok(delivery[1].includes('Watch on Website'), 'Expected website watch link');
      assert.ok(delivery[1].includes('Stored on Backblaze B2 for 2 days'));
      assert.match(delivery[1], /https:\/\/f000\.backblazeb2\.com\/file\/example-bucket\/finished-file\.mkv/);

      const invalidDelivered = await notifyBackblazeB2Upload(
        { name: 'Example Torrent' },
        { filename: 'unfinished-file.mkv', url: 'https://example.test/not-confirmed' },
        fakeBot
      );
      assert.equal(invalidDelivered, false);
    } finally {
      const idx = config.telegramAllowedUserIds.indexOf(testId);
      if (idx !== -1) config.telegramAllowedUserIds.splice(idx, 1);
    }
  });

  test('formatLiveProgressMessage formats downloading status with progress bar', () => {
    const mockTorrent = {
      name: 'Sample.Movie.2026.mkv',
      infoHash: 'abcdef1234567890abcdef1234567890abcdef12',
      status: 'downloading',
      progress: 0.65,
      progressPercent: 65,
      downloadedSize: 650000000,
      totalSize: 1000000000,
      downloadSpeed: 10485760, // 10 MB/s
      uploadSpeed: 524288,
      peers: 42
    };

    const formatted = formatLiveProgressMessage(mockTorrent);
    assert.match(formatted, /Downloading Torrent/);
    assert.match(formatted, /65%/);
    assert.match(formatted, /█+/); // Visual progress bar
    assert.match(formatted, /\*Peers:\* 42/);
    assert.match(formatted, /\*ETA:\*/);
  });
});

