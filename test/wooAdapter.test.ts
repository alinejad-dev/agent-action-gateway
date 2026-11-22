import { describe, expect, it } from 'vitest';
import { createWooAdapter, readCalendarDate } from '../src/woo/adapter.js';
import { WooError, type WooErrorKind } from '../src/woo/errors.js';
import type { FetchLike } from '../src/woo/request.js';

// Fake credentials used only in tests.
const READ_KEYS = { key: 'ck_read_key', secret: 'cs_read_secret' };
const META_KEY = 'lumio_delivered_date';

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

function adapterAnswering(answer: Answer) {
  const urls: URL[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (answer === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const adapter = createWooAdapter({
    baseUrl: 'http://localhost:8080',
    readKeys: READ_KEYS,
    deliveredMetaKey: META_KEY,
    fetchImpl,
  });
  return { adapter, urls };
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

  it('reads the order with the read-only key', async () => {
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
    const options = { baseUrl: 'http://localhost:8080', readKeys: READ_KEYS, deliveredMetaKey: 'bad key' };
    expect(() => createWooAdapter(options)).toThrow('meta key');
  });
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