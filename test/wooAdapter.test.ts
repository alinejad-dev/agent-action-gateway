import { describe, expect, it } from 'vitest';
import { createWooAdapter, readCalendarDate, type WooAdapterOptions } from '../src/woo/adapter.js';
import { WooError, type WooErrorKind } from '../src/woo/errors.js';
import type { FetchLike } from '../src/woo/request.js';

// Fake credentials used only in tests.
const READ_KEYS = { key: 'ck_read_key', secret: 'cs_read_secret' };
const WRITE_KEYS = { key: 'ck_write_key', secret: 'cs_write_secret' };
const META_KEY = 'lumio_delivered_date';
const REQUEST_ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

// Fields as WooCommerce 11.1.2 returns them (recorded from a real store, customer data shortened).
function wooOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 20,
    status: 'completed',
    currency: 'USD',
    total: '18.00',
    date_paid: '2026-10-07T14:02:59',
    billing: { first_name: 'Emma', email: 'emma@example.com', phone: '555-0100' },
    line_items: [{ name: 'Wireless Earbuds', quantity: 1, total: '18.00' }],
    refunds: [],
    meta_data: [{ id: 101, key: META_KEY, value: '2026-11-13' }],
    ...overrides,
  };
}

type Answer = { status: number; body: unknown } | 'network-error';

function adapterAnswering(answer: Answer, overrides: Partial<WooAdapterOptions> = {}) {
  const urls: URL[] = [];
  const bodies: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
    if (answer === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const adapter = createWooAdapter({
    baseUrl: 'http://localhost:8080',
    readKeys: READ_KEYS,
    writeKeys: WRITE_KEYS,
    deliveredMetaKey: META_KEY,
    refundFlags: { apiRefund: false, apiRestock: false },
    fetchImpl,
    ...overrides,
  });
  return { adapter, urls, bodies };
}

async function errorKind(promise: Promise<unknown>): Promise<WooErrorKind | 'no error' | 'other error'> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    return error instanceof WooError ? error.kind : 'other error';
  }
}

describe('WooCommerce adapter: getOrder', () => {
  it('returns a platform-neutral snapshot with integer cents and no customer data', async () => {
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder() });
    const snapshot = await adapter.getOrder('20');
    expect(snapshot).toEqual({
      orderId: '20',
      status: 'completed',
      paid: true,
      currency: 'USD',
      totalCents: 1800,
      refundedCents: 0,
      deliveredOn: '2026-11-13',
    });
    expect(JSON.stringify(snapshot)).not.toContain('Emma');
    expect(JSON.stringify(snapshot)).not.toContain('example.com');
  });

  it('reads the order with the read-only key, even when a write key is configured', async () => {
    const { adapter, urls } = adapterAnswering({ status: 200, body: wooOrder() });
    await adapter.getOrder('20');
    expect(urls[0]?.pathname).toBe('/wp-json/wc/v3/orders/20');
    expect(urls[0]?.searchParams.get('oauth_consumer_key')).toBe(READ_KEYS.key);
  });

  it('adds up refunds in cents and counts "-" (a refund without amount) as 0', async () => {
    // Recorded on WooCommerce 11.1.2: one refund without amount, one of 25.00.
    const refunds = [{ id: 16, total: '-' }, { id: 15, total: '-25.00' }];
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder({ total: '90.00', refunds }) });
    const snapshot = await adapter.getOrder('20');
    expect(snapshot.totalCents).toBe(9000);
    expect(snapshot.refundedCents).toBe(2500);
  });

  it('marks an order without a payment date as not paid', async () => {
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder({ status: 'pending', date_paid: null }) });
    const snapshot = await adapter.getOrder('20');
    expect(snapshot.paid).toBe(false);
    expect(snapshot.status).toBe('pending');
  });

  it.each([
    ['on-hold', 'on_hold'],
    ['processing', 'processing'],
    ['cancelled', 'cancelled'],
    ['refunded', 'refunded'],
    ['failed', 'failed'],
    ['checkout-draft', 'other'],
    ['some-plugin-status', 'other'],
    ['constructor', 'other'],
    ['toString', 'other'],
  ])('maps the status %j to %j', async (wooStatus, status) => {
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder({ status: wooStatus }) });
    expect((await adapter.getOrder('20')).status).toBe(status);
  });

  it('treats a trashed order as not found', async () => {
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder({ status: 'trash' }) });
    expect(await errorKind(adapter.getOrder('20'))).toBe('NOT_FOUND');
  });

  it.each([
    ['an unreadable refund amount', { refunds: [{ id: 1, total: '-1,50' }] }],
    ['an unreadable total', { total: 'abc' }],
    ['a negative total', { total: '-5.00' }],
    ['a currency that is not ISO 4217', { currency: 'usd' }],
    ['a different order id than asked for', { id: 21 }],
    ['a missing field', { meta_data: undefined }],
  ])('refuses %s (BAD_RESPONSE)', async (_label, overrides) => {
    const { adapter } = adapterAnswering({ status: 200, body: wooOrder(overrides) });
    expect(await errorKind(adapter.getOrder('20'))).toBe('BAD_RESPONSE');
  });

  it.each([
    [404, 'NOT_FOUND'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [500, 'UNAVAILABLE'],
    [301, 'UNAVAILABLE'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { adapter } = adapterAnswering({ status, body: { code: 'x' } });
    expect(await errorKind(adapter.getOrder('20'))).toBe(kind);
  });

  it('reports a store that does not answer as UNAVAILABLE', async () => {
    const { adapter } = adapterAnswering('network-error');
    expect(await errorKind(adapter.getOrder('20'))).toBe('UNAVAILABLE');
  });

  it.each(['abc', '0', '-1', '20/refunds', '', '1234567890123'])(
    'treats the order id %j as not found without asking the store',
    async (orderId) => {
      const { adapter, urls } = adapterAnswering({ status: 200, body: wooOrder() });
      expect(await errorKind(adapter.getOrder(orderId))).toBe('NOT_FOUND');
      expect(urls).toHaveLength(0);
    },
  );

  it('refuses a delivery meta key with characters that are not allowed', () => {
    expect(() => adapterAnswering({ status: 200, body: {} }, { deliveredMetaKey: 'bad key' })).toThrow('meta key');
  });

  it('refuses refund flags that are not true or false', () => {
    const refundFlags = { apiRefund: 'no', apiRestock: false } as unknown as WooAdapterOptions['refundFlags'];
    expect(() => adapterAnswering({ status: 200, body: {} }, { refundFlags })).toThrow('apiRefund');
  });
});

describe('WooCommerce adapter: createRefund', () => {
  const refund = { orderId: '20', amountCents: 1800, requestId: REQUEST_ID };
  // Shape of a 201 answer recorded from WooCommerce 11.1.2 (fields shortened).
  const created = { id: 13, amount: '18.00', refunded_payment: false, meta_data: [] };

  it('posts the refund with the write key and returns the refund the store created', async () => {
    const { adapter, urls } = adapterAnswering({ status: 201, body: created });
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'created', storeRefundId: '13', amountCents: 1800 });
    expect(urls[0]?.pathname).toBe('/wp-json/wc/v3/orders/20/refunds');
    expect(urls[0]?.searchParams.get('oauth_consumer_key')).toBe(WRITE_KEYS.key);
  });

  it('sends every field explicitly, the amount built from cents and a fixed reason', async () => {
    const { adapter, bodies } = adapterAnswering({ status: 201, body: created });
    await adapter.createRefund({ ...refund, amountCents: 5 });
    expect(bodies[0]).toEqual({
      amount: '0.05',
      reason: `Action Gateway request ${REQUEST_ID}`,
      api_refund: false,
      api_restock: false,
      meta_data: [{ key: 'gateway_request_id', value: REQUEST_ID }],
    });
  });

  it('sends the configured refund flags, also when they are true', async () => {
    const { adapter, bodies } = adapterAnswering(
      { status: 201, body: created },
      { refundFlags: { apiRefund: true, apiRestock: true } },
    );
    await adapter.createRefund(refund);
    expect(bodies[0]).toMatchObject({ api_refund: true, api_restock: true });
  });

  it('returns the amount the store recorded, even when it differs from the request', async () => {
    const { adapter } = adapterAnswering({ status: 201, body: { ...created, amount: '10.00' } });
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'created', storeRefundId: '13', amountCents: 1000 });
  });

  it.each([
    [401, 'woocommerce_rest_authentication_error', 'AUTH'],
    [403, 'woocommerce_rest_cannot_create', 'AUTH'],
    [500, 'woocommerce_rest_invalid_order_id', 'ORDER_NOT_FOUND'],
    [500, 'woocommerce_rest_cannot_create_order_refund', 'STORE_REFUSED'],
    [500, 'woocommerce_rest_invalid_order_refund', 'INVALID_REQUEST'],
    [400, 'rest_invalid_param', 'INVALID_REQUEST'],
  ])('maps a measured refusal (HTTP %i %s) to rejected %s', async (status, code, reason) => {
    const { adapter } = adapterAnswering({ status, body: { code, message: 'x', data: { status } } });
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'rejected', reason });
  });

  it.each([
    ['a PHP fatal error (seen on WooCommerce)', { status: 500, body: { code: 'internal_server_error' } }],
    ['an unknown error code', { status: 500, body: { code: 'some_plugin_error' } }],
    ['a known code with another status', { status: 400, body: { code: 'woocommerce_rest_cannot_create_order_refund' } }],
    ['a gateway error page', { status: 502, body: 'Bad Gateway' }],
    ['a redirect', { status: 301, body: null }],
    ['a 201 without an id', { status: 201, body: { amount: '18.00' } }],
    ['a 201 with an unreadable amount', { status: 201, body: { id: 13, amount: '1,50' } }],
    ['a 204 without body', { status: 204, body: null }],
  ])('returns unknown for %s', async (_label, answer) => {
    const { adapter } = adapterAnswering(answer);
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown when no answer arrives (the refund may exist)', async () => {
    const { adapter } = adapterAnswering('network-error');
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'unknown' });
  });

  it('refuses without asking the store when no write key is configured', async () => {
    const { adapter, urls } = adapterAnswering({ status: 201, body: created }, { writeKeys: null });
    expect(await adapter.createRefund(refund)).toEqual({ outcome: 'rejected', reason: 'WRITE_KEY_MISSING' });
    expect(urls).toHaveLength(0);
  });

  it('refuses an order id that cannot exist without asking the store', async () => {
    const { adapter, urls } = adapterAnswering({ status: 201, body: created });
    expect(await adapter.createRefund({ ...refund, orderId: '20/refunds' })).toEqual({
      outcome: 'rejected',
      reason: 'ORDER_NOT_FOUND',
    });
    expect(urls).toHaveLength(0);
  });

  it.each([0, -100, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'throws for the amount %d before sending anything',
    async (amountCents) => {
      const { adapter, urls } = adapterAnswering({ status: 201, body: created });
      await expect(adapter.createRefund({ ...refund, amountCents })).rejects.toThrow('amount');
      expect(urls).toHaveLength(0);
    },
  );

  it.each(['', 'not-a-uuid', REQUEST_ID.toUpperCase(), `${REQUEST_ID} `])(
    'throws for the request id %j before sending anything',
    async (requestId) => {
      const { adapter, urls } = adapterAnswering({ status: 201, body: created });
      await expect(adapter.createRefund({ ...refund, requestId })).rejects.toThrow('request id');
      expect(urls).toHaveLength(0);
    },
  );
});

describe('WooCommerce adapter: cancelOrder', () => {
  const cancel = { orderId: '20', requestId: REQUEST_ID };
  // Shape of a 200 answer recorded from WooCommerce 11.1.2 (fields shortened).
  const cancelledOrder = wooOrder({ status: 'cancelled' });

  it('sets the status with a PUT and the write key, and stores the request id on the order', async () => {
    const { adapter, urls, bodies } = adapterAnswering({ status: 200, body: cancelledOrder });
    expect(await adapter.cancelOrder(cancel)).toEqual({ outcome: 'cancelled' });
    expect(urls[0]?.pathname).toBe('/wp-json/wc/v3/orders/20');
    expect(urls[0]?.searchParams.get('oauth_consumer_key')).toBe(WRITE_KEYS.key);
    expect(bodies[0]).toEqual({
      status: 'cancelled',
      meta_data: [{ key: 'gateway_request_id', value: REQUEST_ID }],
    });
  });

  it('sends the PUT method', async () => {
    const methods: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      methods.push(init.method);
      return new Response(JSON.stringify(cancelledOrder), { status: 200 });
    };
    const { adapter } = adapterAnswering({ status: 200, body: {} }, { fetchImpl });
    await adapter.cancelOrder(cancel);
    expect(methods).toEqual(['PUT']);
  });

  it.each([
    ['a 200 that kept another status (a plugin)', { status: 200, body: wooOrder({ status: 'processing' }) }],
    ['a 200 for another order', { status: 200, body: wooOrder({ id: 21, status: 'cancelled' }) }],
    ['a 200 without a readable body', { status: 200, body: 'ok' }],
    ['a PHP fatal error', { status: 500, body: { code: 'internal_server_error' } }],
    ['an unknown error code', { status: 400, body: { code: 'some_plugin_error' } }],
    ['a gateway error page', { status: 502, body: 'Bad Gateway' }],
    ['a redirect', { status: 301, body: null }],
  ])('returns unknown for %s', async (_label, answer) => {
    const { adapter } = adapterAnswering(answer);
    expect(await adapter.cancelOrder(cancel)).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown when no answer arrives (the order may have changed)', async () => {
    const { adapter } = adapterAnswering('network-error');
    expect(await adapter.cancelOrder(cancel)).toEqual({ outcome: 'unknown' });
  });

  it.each([
    [401, 'woocommerce_rest_authentication_error', 'AUTH'],
    [403, 'woocommerce_rest_cannot_edit', 'AUTH'],
    [400, 'woocommerce_rest_shop_order_invalid_id', 'ORDER_NOT_FOUND'],
    [400, 'rest_invalid_param', 'INVALID_REQUEST'],
  ])('maps a measured refusal (HTTP %i %s) to rejected %s', async (status, code, reason) => {
    const { adapter } = adapterAnswering({ status, body: { code, message: 'x', data: { status } } });
    expect(await adapter.cancelOrder(cancel)).toEqual({ outcome: 'rejected', reason });
  });

  it('refuses without asking the store when no write key is configured', async () => {
    const { adapter, urls } = adapterAnswering({ status: 200, body: cancelledOrder }, { writeKeys: null });
    expect(await adapter.cancelOrder(cancel)).toEqual({ outcome: 'rejected', reason: 'WRITE_KEY_MISSING' });
    expect(urls).toHaveLength(0);
  });

  it('refuses an order id that cannot exist without asking the store', async () => {
    const { adapter, urls } = adapterAnswering({ status: 200, body: cancelledOrder });
    expect(await adapter.cancelOrder({ ...cancel, orderId: 'abc' })).toEqual({
      outcome: 'rejected',
      reason: 'ORDER_NOT_FOUND',
    });
    expect(urls).toHaveLength(0);
  });

  it('throws for an invalid request id before sending anything', async () => {
    const { adapter, urls } = adapterAnswering({ status: 200, body: cancelledOrder });
    await expect(adapter.cancelOrder({ ...cancel, requestId: 'not-a-uuid' })).rejects.toThrow('request id');
    expect(urls).toHaveLength(0);
  });
});

describe('WooCommerce adapter: findRefund', () => {
  const find = { orderId: '20', requestId: REQUEST_ID };
  const OTHER_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

  // Shape of GET /orders/<id>/refunds recorded from WooCommerce 11.1.2 (fields shortened).
  // requestId null = a refund without our meta (made by someone else, e.g. in the admin).
  function wooRefund(id: number, amount: string, requestId: unknown = REQUEST_ID): Record<string, unknown> {
    const meta: Record<string, unknown>[] = [{ id: id * 10, key: '_refund_type', value: 'partial' }];
    if (requestId !== null) {
      meta.push({ id: id * 10 + 1, key: 'gateway_request_id', value: requestId });
    }
    return { id, amount, reason: `Action Gateway request ${REQUEST_ID}`, refunded_payment: false, meta_data: meta };
  }

  // One answer per request, in order: first the refund list, then (only if needed) the order.
  function adapterAnsweringInOrder(answers: Answer[], overrides: Partial<WooAdapterOptions> = {}) {
    const urls: URL[] = [];
    const methods: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      methods.push(init.method);
      const answer = answers[urls.length - 1];
      if (answer === undefined) {
        throw new Error('test: more requests than expected');
      }
      if (answer === 'network-error') {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    };
    const { adapter } = adapterAnswering({ status: 200, body: {} }, { fetchImpl, ...overrides });
    return { adapter, urls, methods };
  }

  it('finds our refund with one GET and the read-only key, among refunds made by others', async () => {
    const list = [wooRefund(31, '5.00', null), wooRefund(30, '18.00')];
    const { adapter, urls, methods } = adapterAnsweringInOrder([{ status: 200, body: list }]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'found', storeRefundId: '30', amountCents: 1800 });
    expect(urls).toHaveLength(1);
    expect(methods).toEqual(['GET']);
    expect(urls[0]?.pathname).toBe('/wp-json/wc/v3/orders/20/refunds');
    expect(urls[0]?.searchParams.get('per_page')).toBe('100');
    expect(urls[0]?.searchParams.get('oauth_consumer_key')).toBe(READ_KEYS.key);
  });

  it('works without a write key (reading only)', async () => {
    const { adapter } = adapterAnsweringInOrder([{ status: 200, body: [wooRefund(30, '18.00')] }], {
      writeKeys: null,
    });
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'found', storeRefundId: '30', amountCents: 1800 });
  });

  it('counts a refund that carries our meta twice as one refund', async () => {
    const refund = wooRefund(30, '18.00');
    const meta = refund.meta_data as Record<string, unknown>[];
    refund.meta_data = [...meta, { id: 999, key: 'gateway_request_id', value: REQUEST_ID }];
    const { adapter } = adapterAnsweringInOrder([{ status: 200, body: [refund] }]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'found', storeRefundId: '30', amountCents: 1800 });
  });

  it('reports more than one refund with our request id as duplicate, never picking one', async () => {
    const list = [wooRefund(32, '18.00'), wooRefund(31, '1.00', OTHER_ID), wooRefund(30, '18.00')];
    const { adapter } = adapterAnsweringInOrder([{ status: 200, body: list }]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'duplicate', storeRefundIds: ['32', '30'] });
  });

  it('returns absent when no refund carries our request id and the order is still there', async () => {
    const list = [wooRefund(31, '1.00', OTHER_ID), wooRefund(30, '5.00', null)];
    const { adapter, urls } = adapterAnsweringInOrder([
      { status: 200, body: list },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
    expect(urls).toHaveLength(2);
    expect(urls[1]?.pathname).toBe('/wp-json/wc/v3/orders/20');
    expect(urls[1]?.searchParams.get('oauth_consumer_key')).toBe(READ_KEYS.key);
  });

  it('returns absent for an order without refunds that is still there', async () => {
    const { adapter } = adapterAnsweringInOrder([
      { status: 200, body: [] },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
  });

  it.each([
    ['our id in upper case', REQUEST_ID.toUpperCase()],
    ['our id with a space', ` ${REQUEST_ID}`],
    ['our id inside an object', { id: REQUEST_ID }],
    ['our id inside a list', [REQUEST_ID]],
  ])('does not match %s', async (_label, value) => {
    const { adapter } = adapterAnsweringInOrder([
      { status: 200, body: [wooRefund(30, '18.00', value)] },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
  });

  it('does not match our request id stored under another meta key', async () => {
    const refund = wooRefund(30, '18.00', null);
    refund.meta_data = [{ id: 300, key: 'note', value: REQUEST_ID }];
    const { adapter } = adapterAnsweringInOrder([
      { status: 200, body: [refund] },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
  });

  it('does not match by the reason text, only by the meta', async () => {
    // wooRefund always has our request id in the reason; here the meta is missing.
    const { adapter } = adapterAnsweringInOrder([
      { status: 200, body: [wooRefund(30, '18.00', null)] },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
  });

  // Measured: the list is empty for a missing order and, without HPOS, for a trashed one
  // (its refunds go to the trash with it). An empty list alone proves nothing.
  it.each([
    ['the order is missing (404)', { status: 404, body: { code: 'woocommerce_rest_shop_order_invalid_id' } }],
    ['the order is in the trash', { status: 200, body: wooOrder({ status: 'trash' }) }],
    ['the order read fails (500)', { status: 500, body: { code: 'internal_server_error' } }],
    ['the order read has no answer', 'network-error'],
    ['the order is unreadable', { status: 200, body: wooOrder({ total: 'abc' }) }],
    ['the answer is another order', { status: 200, body: wooOrder({ id: 21 }) }],
  ] as [string, Answer][])('returns unknown for an empty list when %s', async (_label, orderAnswer) => {
    const { adapter } = adapterAnsweringInOrder([{ status: 200, body: [] }, orderAnswer]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown for a full page of 100 refunds without our id (more may follow)', async () => {
    const list = Array.from({ length: 100 }, (_, i) => wooRefund(i + 1, '1.00', OTHER_ID));
    const { adapter, urls } = adapterAnsweringInOrder([{ status: 200, body: list }]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'unknown' });
    expect(urls).toHaveLength(1);
  });

  it('reads a page of 99 refunds to the end', async () => {
    const list = Array.from({ length: 99 }, (_, i) => wooRefund(i + 1, '1.00', OTHER_ID));
    const { adapter } = adapterAnsweringInOrder([
      { status: 200, body: list },
      { status: 200, body: wooOrder() },
    ]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'absent' });
  });

  it.each([
    ['an unreadable amount', '1,50'],
    ['a negative amount', '-5.00'],
    ['an empty amount', ''],
  ])('returns unknown when our refund has %s', async (_label, amount) => {
    const { adapter } = adapterAnsweringInOrder([{ status: 200, body: [wooRefund(30, amount)] }]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'unknown' });
  });

  it.each([
    ['404 rest_no_route (plugin disabled or wrong address)', { status: 404, body: { code: 'rest_no_route' } }],
    ['401 (wrong key)', { status: 401, body: { code: 'woocommerce_rest_authentication_error' } }],
    ['400 rest_invalid_param', { status: 400, body: { code: 'rest_invalid_param' } }],
    ['a PHP fatal error', { status: 500, body: { code: 'internal_server_error' } }],
    ['a redirect', { status: 301, body: null }],
    ['a 2xx other than 200, even with a list', { status: 206, body: [wooRefund(30, '18.00')] }],
    ['a 200 that is not a list', { status: 200, body: { id: 30 } }],
    ['a 200 with text', { status: 200, body: 'ok' }],
    ['a refund without an id', { status: 200, body: [{ amount: '18.00', meta_data: [] }] }],
    ['a refund without meta_data', { status: 200, body: [{ id: 30, amount: '18.00' }] }],
  ] as [string, Answer][])('returns unknown without reading the order for %s', async (_label, answer) => {
    const { adapter, urls } = adapterAnsweringInOrder([answer]);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'unknown' });
    expect(urls).toHaveLength(1);
  });

  it('returns unknown when no answer arrives', async () => {
    const { adapter } = adapterAnsweringInOrder(['network-error']);
    expect(await adapter.findRefund(find)).toEqual({ outcome: 'unknown' });
  });

  it.each(['abc', '0', '20/refunds', ''])(
    'returns absent for the order id %j without asking the store (createRefund never sends one)',
    async (orderId) => {
      const { adapter, urls } = adapterAnsweringInOrder([]);
      expect(await adapter.findRefund({ ...find, orderId })).toEqual({ outcome: 'absent' });
      expect(urls).toHaveLength(0);
    },
  );

  it.each(['', 'not-a-uuid', REQUEST_ID.toUpperCase()])(
    'throws for the request id %j before sending anything',
    async (requestId) => {
      const { adapter, urls } = adapterAnsweringInOrder([]);
      await expect(adapter.findRefund({ ...find, requestId })).rejects.toThrow('request id');
      expect(urls).toHaveLength(0);
    },
  );
});

describe('readCalendarDate', () => {
  const meta = (...entries: [string, unknown][]) => entries.map(([key, value]) => ({ key, value }));

  it('returns a real calendar date', () => {
    expect(readCalendarDate(meta([META_KEY, '2026-11-07']), META_KEY)).toBe('2026-11-07');
    expect(readCalendarDate(meta([META_KEY, '2028-02-29']), META_KEY)).toBe('2028-02-29');
  });

  it.each([
    ['missing', meta(['other_key', '2026-11-07'])],
    ['twice, different values (seen on WooCommerce)', meta([META_KEY, '2026-11-07'], [META_KEY, '2026-11-09'])],
    ['twice, same value', meta([META_KEY, '2026-11-07'], [META_KEY, '2026-11-07'])],
    ['an object (array meta)', meta([META_KEY, { date: '2026-11-07' }])],
    ['text (seen on WooCommerce)', meta([META_KEY, 'soon'])],
    ['a date that does not exist', meta([META_KEY, '2026-02-30'])],
    ['a 29 February outside a leap year', meta([META_KEY, '2027-02-29'])],
    ['a date with a time', meta([META_KEY, '2026-11-07T10:00:00'])],
    ['another date format', meta([META_KEY, '07/11/2026'])],
    ['a year below 100', meta([META_KEY, '0050-01-01'])],
  ])('returns null when the value is %s', (_label, entries) => {
    expect(readCalendarDate(entries, META_KEY)).toBeNull();
  });
});