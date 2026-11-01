import { config } from '../config.js';
import { signOAuth1 } from './oauth.js';

const TIMEOUT_MS = 10_000;

export type WooErrorKind = 'NOT_FOUND' | 'AUTH' | 'UNAVAILABLE' | 'BAD_RESPONSE';

/** The only error type this client throws. Messages never contain secrets. */
export class WooError extends Error {
  readonly kind: WooErrorKind;
  readonly status: number | undefined;

  constructor(kind: WooErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'WooError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * GET a WooCommerce REST v3 endpoint, e.g. wooGet('/orders/20').
 * Returns `unknown` on purpose: callers must validate the shape before using it.
 */
export async function wooGet(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const base = config.WOO_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${base}/wp-json/wc/v3${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  // HTTPS: Basic Auth is safe because the connection is encrypted.
  // HTTP: sign the request with OAuth 1.0a so the secret never travels.
  const headers: Record<string, string> = { Accept: 'application/json' };
  let requestUrl = url;
  if (url.protocol === 'https:') {
    const token = Buffer.from(`${config.WOO_CONSUMER_KEY}:${config.WOO_CONSUMER_SECRET}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  } else {
    requestUrl = signOAuth1('GET', url, config.WOO_CONSUMER_KEY, config.WOO_CONSUMER_SECRET);
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // Network error or timeout. We don't echo the error: it may include the signed URL.
    throw new WooError('UNAVAILABLE', 'Store did not respond');
  }

  if (res.status === 404) throw new WooError('NOT_FOUND', 'Resource not found', 404);
  if (res.status === 401 || res.status === 403) {
    throw new WooError('AUTH', 'Store rejected our credentials', res.status);
  }
  if (!res.ok) throw new WooError('UNAVAILABLE', `Store returned HTTP ${res.status}`, res.status);

  try {
    return await res.json();
  } catch {
    throw new WooError('BAD_RESPONSE', 'Store returned invalid JSON');
  }
}