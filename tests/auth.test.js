import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAdminCredentials, generateToken, verifyToken } from '../src/auth.js';
import config from '../src/config.js';

describe('Authentication & JWT Tests', () => {
  test('verifyAdminCredentials accepts configured admin password', async () => {
    const isValid = await verifyAdminCredentials(config.adminUsername, config.adminPassword);
    assert.equal(isValid, true, 'Configured admin password should match');
  });

  test('verifyAdminCredentials rejects wrong password', async () => {
    const isValid = await verifyAdminCredentials(config.adminUsername, 'definitely-wrong-password-999');
    assert.equal(isValid, false, 'Invalid password must be rejected');
  });

  test('verifyAdminCredentials rejects wrong username', async () => {
    const isValid = await verifyAdminCredentials('randomUser', config.adminPassword);
    assert.equal(isValid, false, 'Invalid username must be rejected');
  });

  test('verifyAdminCredentials rejects empty inputs', async () => {
    assert.equal(await verifyAdminCredentials('', ''), false);
    assert.equal(await verifyAdminCredentials(null, null), false);
  });

  test('generateToken produces a valid JWT and verifyToken decodes it', () => {
    const token = generateToken({ testUser: true });
    assert.ok(typeof token === 'string' && token.length > 20);

    const decoded = verifyToken(token);
    assert.equal(decoded.username, config.adminUsername);
    assert.equal(decoded.role, 'admin');
    assert.equal(decoded.testUser, true);
  });

  test('verifyToken throws on malformed or expired token', () => {
    assert.throws(() => {
      verifyToken('invalid.jwt.token');
    });
  });
});

