import { createHmac, randomBytes } from 'node:crypto';

// RFC 3986 percent-encoding, as OAuth 1.0a requires.
// encodeURIComponent leaves ! ' ( ) * as-is, so we encode those by hand.
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Returns a copy of `url` with OAuth 1.0a "one-legged" params added.
 * Used for WooCommerce over plain HTTP. The secret signs the request — it is never sent.
 */
export function signOAuth1(method: string, url: URL, consumerKey: string, consumerSecret: string): URL {
  const signed = new URL(url);
  signed.searchParams.set('oauth_consumer_key', consumerKey);
  signed.searchParams.set('oauth_nonce', randomBytes(16).toString('hex'));
  signed.searchParams.set('oauth_signature_method', 'HMAC-SHA256');
  signed.searchParams.set('oauth_timestamp', Math.floor(Date.now() / 1000).toString());

  // 1) Encode every key and value, sort by key, join as key=value&key=value
  const paramString = [...signed.searchParams.entries()]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // 2) Base string: METHOD & encoded URL (without query) & encoded params
  const baseUrl = `${signed.origin}${signed.pathname}`;
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');

  // 3) Sign with "consumerSecret&" (one-legged OAuth has no token secret)
  const signature = createHmac('sha256', `${consumerSecret}&`).update(baseString).digest('base64');
  signed.searchParams.set('oauth_signature', signature);
  return signed;
}