// One function for every request to the WooCommerce REST API, reads and writes.
// It does NOT import config.ts: the store address and the key pair are arguments,
// so every caller chooses the key explicitly and the tests run without a .env file.
import type { WooKeyPair } from './keys.js';
import { signOAuth1 } from './oauth.js';

// No DELETE on purpose: the gateway never deletes anything in the store.
export type StoreMethod = 'GET' | 'POST' | 'PUT';

export type StoreRequest = {
  baseUrl: string; // e.g. http://localhost:8080
  keys: WooKeyPair; // read key for reads, write key only for actions
  method: StoreMethod;
  path: string; // e.g. /orders/20/refunds
  query?: Record<string, string>;
  body?: unknown; // sent as JSON, only for POST and PUT
};

export type StoreAnswer = {
  status: number;
  code: string | null; // WooCommerce error code, only when it has a safe shape
  data: unknown; // parsed JSON of a 2xx answer, otherwise null
};

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT']);
// One or more segments of lowercase letters, digits, "_" or "-": no "..", "?", "%" or "//".
const SAFE_PATH = /^(\/[a-z0-9_-]+)+$/;
const SAFE_CODE = /^[a-z0-9_]{1,80}$/;

/**
 * Sends one request to the store and returns { status, code, data }.
 * An HTTP error is NOT thrown: the caller decides what a status means.
 * Returns null when no complete answer arrived (network error or timeout):
 * for a read that means "store unavailable", for a write "outcome unknown".
 * Throws only for invalid arguments, which are bugs in our own code.
 */
export async function storeRequest(
  request: StoreRequest,
  fetchImpl: FetchLike = fetch,
): Promise<StoreAnswer | null> {
  const { method, path, query = {}, body } = request;
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error('Store request: this HTTP method is not allowed');
  }
  if (!SAFE_PATH.test(path)) {
    throw new Error('Store request: the path contains characters that are not allowed');
  }
  if (method === 'GET' && body !== undefined) {
    throw new Error('Store request: a GET request cannot have a body');
  }

  const url = new URL(`${request.baseUrl.replace(/\/$/, '')}/wp-json/wc/v3${path}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Store request: the store address must start with http:// or https://');
  }
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('oauth_')) {
      throw new Error('Store request: query parameters cannot start with oauth_');
    }
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // HTTPS: Basic Auth is safe because the connection is encrypted.
  // HTTP: sign the request with OAuth 1.0a so the secret never travels.
  const { key, secret } = request.keys;
  let requestUrl = url;
  if (url.protocol === 'https:') {
    headers.Authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
  } else {
    requestUrl = signOAuth1(method, url, key, secret);
  }

  let status: number;
  let text: string;
  try {
    const res = await fetchImpl(requestUrl, {
      method,
      headers,
      body: payload,
      redirect: 'manual', // never follow a redirect with credentials
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch {
    // No complete answer. The error is not passed on: it may contain the signed URL.
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON (e.g. an HTML error page): the status alone has to be enough.
  }

  return {
    status,
    code: readSafeCode(parsed),
    // Error answers can contain server paths and stack traces: only a 2xx body is passed on.
    data: status >= 200 && status < 300 ? parsed : null,
  };
}

function readSafeCode(parsed: unknown): string | null {
  if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
    const code = parsed.code;
    if (typeof code === 'string' && SAFE_CODE.test(code)) {
      return code;
    }
  }
  return null;
}