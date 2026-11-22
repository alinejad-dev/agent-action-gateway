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