import { config } from '../config.js';
import { readDataOrThrow, storeRequest } from './request.js';

// Re-exported so existing imports from './client.js' keep working.
export { WooError, type WooErrorKind } from './errors.js';

/**
 * GET a WooCommerce REST v3 endpoint with the read-only key, e.g. wooGet('/orders/20').
 * Signing, the timeout, refusing redirects and safe error codes all live in storeRequest.
 * Returns `unknown` on purpose: callers must validate the shape before using it.
 * Throws WooError: NOT_FOUND, AUTH or UNAVAILABLE (see readDataOrThrow).
 */
export async function wooGet(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const answer = await storeRequest({
    baseUrl: config.WOO_BASE_URL,
    keys: { key: config.WOO_CONSUMER_KEY, secret: config.WOO_CONSUMER_SECRET },
    method: 'GET',
    path,
    query,
  });
  return readDataOrThrow(answer);
}