import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOAuth1 } from '../src/woo/oauth.js';

// Fake credentials used only in tests.
const KEY = 'ck_test';
const SECRET = 'cs_test_secret';
const FIXED = { nonce: 'abc123', timestamp: 1700000000 };

function orderSearchUrl(perPage = '10'): URL {
  const url = new URL('http://localhost:8080/wp-json/wc/v3/orders');
  // ' ( ) ! are characters encodeURIComponent does NOT encode, so they test our RFC 3986 fix.
  url.searchParams.set('search', "O'Brien (VIP)!");
  url.searchParams.set('per_page', perPage);
  return url;
}

// Base string written BY HAND from the OAuth 1.0a spec (RFC 5849, section 3.4.1),
// not produced by our code: params sorted by key, RFC 3986-encoded, then encoded again.
const EXPECTED_BASE_STRING =
  'GET&http%3A%2F%2Flocalhost%3A8080%2Fwp-json%2Fwc%2Fv3%2Forders&' +
  'oauth_consumer_key%3Dck_test%26oauth_nonce%3Dabc123%26oauth_signature_method%3DHMAC-SHA256' +
  '%26oauth_timestamp%3D1700000000%26per_page%3D10%26search%3DO%2527Brien%2520%2528VIP%2529%2521';

describe('signOAuth1', () => {
  it('produces the RFC 5849 signature for a known request', () => {
    const signed = signOAuth1('get', orderSearchUrl(), KEY, SECRET, FIXED);
    const expected = createHmac('sha256', `${SECRET}&`).update(EXPECTED_BASE_STRING).digest('base64');
    expect(signed.searchParams.get('oauth_signature')).toBe(expected);
  });

  it('adds the required OAuth parameters', () => {
    const params = signOAuth1('GET', orderSearchUrl(), KEY, SECRET, FIXED).searchParams;
    expect(params.get('oauth_consumer_key')).toBe(KEY);
    expect(params.get('oauth_nonce')).toBe('abc123');
    expect(params.get('oauth_signature_method')).toBe('HMAC-SHA256');
    expect(params.get('oauth_timestamp')).toBe('1700000000');
  });

  it('never puts the consumer secret in the URL', () => {
    const signed = signOAuth1('GET', orderSearchUrl(), KEY, SECRET);
    expect(signed.toString()).not.toContain(SECRET);
  });

  it('does not modify the URL passed in', () => {
    const url = orderSearchUrl();
    const before = url.toString();
    signOAuth1('GET', url, KEY, SECRET);
    expect(url.toString()).toBe(before);
  });

  it('uses a fresh random nonce on every call (replay protection)', () => {
    const a = signOAuth1('GET', orderSearchUrl(), KEY, SECRET).searchParams.get('oauth_nonce');
    const b = signOAuth1('GET', orderSearchUrl(), KEY, SECRET).searchParams.get('oauth_nonce');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('changes the signature when any query value changes (tamper detection)', () => {
    const sigA = signOAuth1('GET', orderSearchUrl('10'), KEY, SECRET, FIXED).searchParams.get('oauth_signature');
    const sigB = signOAuth1('GET', orderSearchUrl('100'), KEY, SECRET, FIXED).searchParams.get('oauth_signature');
    expect(sigA).not.toBe(sigB);
  });
});