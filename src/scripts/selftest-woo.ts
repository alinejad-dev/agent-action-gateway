// Proves on the live store what each WooCommerce API key may do (manual check, never imported by the server).
//   npm run woo:selftest
// The read key must be valid and read-only; the write key (if configured) must be valid and
// allowed to write. Nothing in the store is changed: the only write request targets an order id
// that does not exist, and it is not sent unless the store confirms that the id is missing.
// Prints PASS/FAIL lines without any secret. Exit code 1 when a check fails.
import { config, wooWriteKeys } from '../config.js';
import {
  judgeMissingOrder,
  judgeRead,
  judgeWrite,
  type Check,
  type ExpectedPermission,
  type ProbeAnswer,
} from '../woo/keyProbe.js';
import type { WooKeyPair } from '../woo/keys.js';
import { signOAuth1 } from '../woo/oauth.js';

const TIMEOUT_MS = 10_000;

// 12 digits: far above any id a store will reach. A second safety: the write probe is only
// sent after the store answered "not found" for this id.
const MISSING_ORDER_PATH = '/orders/999999999999';

let passed = 0;
let failed = 0;

function report(check: Check): boolean {
  if (check.ok) {
    passed++;
  } else {
    failed++;
  }
  console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.text}`);
  return check.ok;
}

// One request to the store. Returns only the status and the error code: never the URL
// (when signed it contains the key) and never the response body.
async function send(method: 'GET' | 'PUT', path: string, keys: WooKeyPair): Promise<ProbeAnswer> {
  const base = config.WOO_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${base}/wp-json/wc/v3${path}`);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const body = method === 'PUT' ? '{}' : undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // Same rule as src/woo/client.ts: Basic Auth over HTTPS, OAuth 1.0a signature over HTTP.
  let requestUrl = url;
  if (url.protocol === 'https:') {
    headers.Authorization = `Basic ${Buffer.from(`${keys.key}:${keys.secret}`).toString('base64')}`;
  } else {
    requestUrl = signOAuth1(method, url, keys.key, keys.secret);
  }

  try {
    const res = await fetch(requestUrl, {
      method,
      headers,
      body,
      redirect: 'manual', // never follow a redirect with credentials
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let code = '';
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null && 'code' in parsed && typeof parsed.code === 'string') {
        code = parsed.code;
      }
    } catch {
      // No JSON body: the status alone is enough.
    }
    return { status: res.status, code };
  } catch {
    // Network error or timeout. The error is not printed: it may include the signed URL.
    return null;
  }
}

async function checkKey(title: string, keys: WooKeyPair, expected: ExpectedPermission): Promise<void> {
  console.log(`${title}, expected: ${expected === 'read' ? 'read only' : 'read and write'}`);
  if (!report(judgeRead(await send('GET', '/orders?per_page=1', keys)))) {
    return;
  }
  if (!report(judgeMissingOrder(await send('GET', MISSING_ORDER_PATH, keys)))) {
    return;
  }
  report(judgeWrite(expected, await send('PUT', MISSING_ORDER_PATH, keys)));
}

async function main(): Promise<void> {
  console.log(`Store: ${config.WOO_BASE_URL}`);
  await checkKey(
    'Read key (WOO_CONSUMER_KEY)',
    { key: config.WOO_CONSUMER_KEY, secret: config.WOO_CONSUMER_SECRET },
    'read',
  );
  if (wooWriteKeys === null) {
    console.log('Write key (WOO_WRITE_CONSUMER_KEY): not configured, skipped.');
  } else {
    await checkKey('Write key (WOO_WRITE_CONSUMER_KEY)', wooWriteKeys, 'read_write');
  }

  console.log(`${passed} passed, ${failed} failed. Nothing in the store was changed.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Only the error type: a message could contain a URL.
  console.error(`Self-test crashed: ${error instanceof Error ? error.name : 'unknown error'}`);
  process.exitCode = 1;
});