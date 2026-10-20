import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUserAllowed, notifyBackblazeB2Upload } from '../src/telegramBot.js';
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
      assert.ok(delivery[1].includes('finished\\-file\\.mkv'));
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
});

