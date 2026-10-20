import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

describe('Config Validation Tests', () => {
  test('validateConfig does not throw when valid environment is loaded', () => {
    const original = { jwt: process.env.JWT_SECRET, user: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD };
    process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-validation';
    process.env.ADMIN_USERNAME = 'test-admin';
    process.env.ADMIN_PASSWORD = 'test-password';
    try { assert.doesNotThrow(() => validateConfig()); } finally {
      process.env.JWT_SECRET = original.jwt;
      process.env.ADMIN_USERNAME = original.user;
      process.env.ADMIN_PASSWORD = original.password;
    }
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

