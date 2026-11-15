// Decides what a store's answers say about an API key's permissions.
// Pure functions (no network, no .env), unit-tested. Used by src/scripts/selftest-woo.ts.
//
// How the probe works (verified against WooCommerce 11.1.2):
//   GET  orders            -> 200 proves the key and secret are valid and may read
//   PUT  orders/<missing>  -> a Read-only key is stopped first: 401 woocommerce_rest_authentication_error
//                             a Read/Write key gets further and fails on the order id (400 or 404)
// The PUT never reaches a real order, so nothing in the store changes.
// Wrong credentials give the same 401 code, so the PUT only means something after the GET passed.
// Decisions use the HTTP status and the error code, never the message (it is translated).

// What the store answered. null = no answer at all (network error, timeout).
export type ProbeAnswer = { status: number; code: string } | null;

export type Check = { ok: boolean; text: string };

export type ExpectedPermission = 'read' | 'read_write';

const AUTH_ERROR = 'woocommerce_rest_authentication_error';

// Error codes come from the store. Only print them when they look like a normal code.
function show(answer: { status: number; code: string }): string {
  const code = /^[a-z0-9_]{1,80}$/.test(answer.code) ? ` ${answer.code}` : '';
  return `HTTP ${answer.status}${code}`;
}

// GET orders with the key.
export function judgeRead(answer: ProbeAnswer): Check {
  if (answer === null) {
    return { ok: false, text: 'the store did not respond' };
  }
  if (answer.status === 200) {
    return { ok: true, text: 'key and secret are valid, reading works (HTTP 200)' };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, text: `the store rejected the key or secret (${show(answer)})` };
  }
  return { ok: false, text: `unexpected answer to a read (${show(answer)})` };
}

// GET the order id used by the write probe. It must not exist.
export function judgeMissingOrder(answer: ProbeAnswer): Check {
  if (answer === null) {
    return { ok: false, text: 'the store did not respond' };
  }
  if (answer.status === 404) {
    return { ok: true, text: 'the probe order id does not exist (HTTP 404)' };
  }
  return { ok: false, text: `the probe order id did not answer "not found" (${show(answer)}); write probe not sent` };
}

// PUT to the missing order id with the key.
export function judgeWrite(expected: ExpectedPermission, answer: ProbeAnswer): Check {
  if (answer === null) {
    return { ok: false, text: 'the store did not respond' };
  }
  const refusedByKey = answer.status === 401 && answer.code === AUTH_ERROR;
  // The key was allowed to write; the request then failed on the missing order.
  const stoppedAtOrder = answer.status === 400 || answer.status === 404;

  if (expected === 'read') {
    if (refusedByKey) {
      return { ok: true, text: `writes are refused for this key (${show(answer)})` };
    }
    if (stoppedAtOrder) {
      return { ok: false, text: `this key may WRITE (${show(answer)}); the read key must be "Read" only` };
    }
    return { ok: false, text: `unexpected answer to a write (${show(answer)})` };
  }

  if (stoppedAtOrder) {
    return { ok: true, text: `writes are allowed for this key; the request stopped at the missing order (${show(answer)})` };
  }
  if (refusedByKey) {
    return { ok: false, text: `this key may not write (${show(answer)}); it must be "Read/Write"` };
  }
  if (answer.status === 403) {
    return { ok: false, text: `the key may write, but its WordPress user may not edit orders (${show(answer)})` };
  }
  return { ok: false, text: `unexpected answer to a write (${show(answer)})` };
}