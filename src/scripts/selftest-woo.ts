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
import { storeRequest } from '../woo/request.js';

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

// One request to the store through the shared storeRequest (signing, no redirects, timeout).
// Returns only the status and the safe error code: never the URL (when signed it contains
// the key) and never the response body.
async function send(
  method: 'GET' | 'PUT',
  path: string,
  keys: WooKeyPair,
  query?: Record<string, string>,
): Promise<ProbeAnswer> {
  const answer = await storeRequest({
    baseUrl: config.WOO_BASE_URL,
    keys,
    method,
    path,
    query,
    body: method === 'PUT' ? {} : undefined,
  });
  return answer === null ? null : { status: answer.status, code: answer.code ?? '' };
}

async function checkKey(title: string, keys: WooKeyPair, expected: ExpectedPermission): Promise<void> {
  console.log(`${title}, expected: ${expected === 'read' ? 'read only' : 'read and write'}`);
  if (!report(judgeRead(await send('GET', '/orders', keys, { per_page: '1' })))) {
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