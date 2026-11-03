import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBearerCheck } from '../src/http/auth.js';

// Fake token used only in tests. Never put a real secret in test files.
const TOKEN = 'a'.repeat(64);
const isAuthorized = createBearerCheck(TOKEN);

// Minimal fake request: the check only reads req.headers.authorization.
function req(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

describe('createBearerCheck', () => {
  it('accepts the correct token', () => {
    expect(isAuthorized(req(`Bearer ${TOKEN}`))).toBe(true);
  });

  it('accepts a lowercase scheme name (RFC 7235)', () => {
    expect(isAuthorized(req(`bearer ${TOKEN}`))).toBe(true);
  });

  it('rejects a request without an Authorization header', () => {
    expect(isAuthorized(req())).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    expect(isAuthorized(req(`Bearer ${'b'.repeat(64)}`))).toBe(false);
  });

  it('rejects a token that is only a prefix of the real one', () => {
    expect(isAuthorized(req(`Bearer ${TOKEN.slice(0, 32)}`))).toBe(false);
  });

  it('rejects the real token with extra characters', () => {
    expect(isAuthorized(req(`Bearer ${TOKEN}x`))).toBe(false);
  });

  it('rejects other schemes such as Basic', () => {
    expect(isAuthorized(req(`Basic ${TOKEN}`))).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(isAuthorized(req('Bearer '))).toBe(false);
  });
});