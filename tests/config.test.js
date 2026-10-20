import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

describe('Config Validation Tests', () => {
  test('validateConfig does not throw when valid environment is loaded', () => {
    assert.doesNotThrow(() => {
      validateConfig();
    });
  });

  test('validateConfig throws clear error when JWT_SECRET is missing', () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    assert.throws(() => {
      validateConfig();
    }, /JWT_SECRET is missing/);

    process.env.JWT_SECRET = original;
  });

  test('validateConfig throws clear error when ADMIN_USERNAME is empty', () => {
    const original = process.env.ADMIN_USERNAME;
    process.env.ADMIN_USERNAME = '';

    assert.throws(() => {
      validateConfig();
    }, /ADMIN_USERNAME is missing/);

    process.env.ADMIN_USERNAME = original;
  });
});

