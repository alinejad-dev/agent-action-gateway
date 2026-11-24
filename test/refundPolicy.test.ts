import { describe, expect, it } from 'vitest';
import { loadPolicy, type RefundPolicy } from '../src/policy/policyFile.js';
import { calendarDateIn, decideRefund, type RefundAsk } from '../src/policy/refund.js';
import type { OrderSnapshot } from '../src/store/adapter.js';

const VERSION = 'test-1+000000000000';
const NOW = new Date('2026-11-22T12:00:00Z');

function policy(change: Partial<RefundPolicy> = {}): RefundPolicy {
  return {
    currency: 'USD',
    autoApproveMaxCents: 2500,
    returnWindowDays: 30,
    timeZone: 'UTC',
    refundableStatuses: ['completed'],
    allowPartialRefunds: true,
    policyVersion: VERSION,
    ...change,
  };
}

// Like demo order #20: $18.00, completed, paid, delivered 9 days before NOW.
function order(change: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    orderId: '20',
    status: 'completed',
    paid: true,
    currency: 'USD',
    totalCents: 1800,
    refundedCents: 0,
    deliveredOn: '2026-11-13',
    ...change,
  };
}

function ask(amountCents = 1800, currency = 'USD'): RefundAsk {
  return { amountCents, currency };
}

function code(o: OrderSnapshot, r: RefundAsk, p: RefundPolicy = policy(), now: Date = NOW): string {
  return decideRefund(o, r, p, now).reasonCode;
}

describe('decideRefund: one test per reason code', () => {
  it.each<[string, OrderSnapshot, RefundAsk, RefundPolicy]>([
    ['WITHIN_AUTO_LIMIT', order(), ask(), policy()],
    ['ABOVE_AUTO_LIMIT', order({ totalCents: 8900 }), ask(8900), policy()],
    ['CURRENCY_MISMATCH', order(), ask(1800, 'EUR'), policy()],
    ['INVALID_AMOUNT', order(), ask(0), policy()],
    ['ALREADY_REFUNDED', order({ status: 'refunded', refundedCents: 1800 }), ask(), policy()],
    ['NOT_DELIVERED', order({ deliveredOn: null }), ask(), policy()],
    ['STATUS_NOT_ALLOWED', order({ status: 'cancelled' }), ask(), policy()],
    ['NOT_PAID', order({ paid: false }), ask(), policy()],
    ['OUTSIDE_RETURN_WINDOW', order({ deliveredOn: '2026-10-05' }), ask(), policy()],
    ['AMOUNT_EXCEEDS_REMAINING', order(), ask(1801), policy()],
    ['PARTIAL_NOT_ALLOWED', order(), ask(1000), policy({ allowPartialRefunds: false })],
  ])('%s', (expected, o, r, p) => {
    const result = decideRefund(o, r, p, NOW);
    expect(result.reasonCode).toBe(expected);
    expect(result.policyVersion).toBe(VERSION);
    const decision =
      expected === 'WITHIN_AUTO_LIMIT'
        ? 'AUTO_APPROVE'
        : expected === 'ABOVE_AUTO_LIMIT'
          ? 'NEEDS_APPROVAL'
          : 'REJECT';
    expect(result.decision).toBe(decision);
  });
});

describe('decideRefund: rule order (the first rule that matches decides)', () => {
  type Case = { o: OrderSnapshot; r: RefundAsk; p: RefundPolicy };
  // Each entry breaks one rule of the base case (which is AUTO_APPROVE), in rule order.
  const breakers: Array<[string, (c: Case) => void]> = [
    ['CURRENCY_MISMATCH', (c) => { c.r.currency = 'EUR'; }],
    ['INVALID_AMOUNT', (c) => { c.r.amountCents = 0; }],
    ['ALREADY_REFUNDED', (c) => { c.o.status = 'refunded'; c.o.refundedCents = c.o.totalCents; }],
    ['NOT_DELIVERED', (c) => { c.o.deliveredOn = null; }],
    ['STATUS_NOT_ALLOWED', (c) => { c.o.status = 'cancelled'; }],
    ['NOT_PAID', (c) => { c.o.paid = false; }],
    ['OUTSIDE_RETURN_WINDOW', (c) => { c.o.deliveredOn = '2026-10-01'; }],
    ['AMOUNT_EXCEEDS_REMAINING', (c) => { c.r.amountCents = c.o.totalCents + 1; }],
    ['PARTIAL_NOT_ALLOWED', (c) => { c.p = { ...c.p, allowPartialRefunds: false }; c.r.amountCents = 1000; }],
    ['ABOVE_AUTO_LIMIT', (c) => { c.p = { ...c.p, autoApproveMaxCents: 1000 }; }],
  ];

  const pairs: Array<[string, string, number, number]> = [];
  breakers.forEach(([first], i) => {
    breakers.forEach(([later], j) => {
      if (j > i) pairs.push([first, later, i, j]);
    });
  });

  it('has 45 pairs', () => {
    expect(pairs).toHaveLength(45);
  });

  it.each(pairs)('%s wins over %s', (first, _later, i, j) => {
    const c: Case = { o: order(), r: ask(), p: policy() };
    // Apply the later rule first, then the earlier one, so the earlier rule's change is kept.
    breakers[j]![1](c);
    breakers[i]![1](c);
    expect(code(c.o, c.r, c.p)).toBe(first);
  });
});

describe('decideRefund: auto-approve cap (counts everything refunded on the order)', () => {
  const big = order({ totalCents: 9000 });
  it.each<[string, number, number, string]>([
    ['exactly the cap', 0, 2500, 'WITHIN_AUTO_LIMIT'],
    ['one cent above the cap', 0, 2501, 'ABOVE_AUTO_LIMIT'],
    ['earlier refunds + this one = the cap', 2000, 500, 'WITHIN_AUTO_LIMIT'],
    ['earlier refunds + this one = cap + 1', 2000, 501, 'ABOVE_AUTO_LIMIT'],
    ['earlier refunds already above the cap', 3000, 100, 'ABOVE_AUTO_LIMIT'],
    ['split attempt: 4th of 4 x 2225', 6675, 2225, 'ABOVE_AUTO_LIMIT'],
    ['split attempt: 2nd of 4 x 2225', 2225, 2225, 'ABOVE_AUTO_LIMIT'],
  ])('%s', (_name, refundedCents, amount, expected) => {
    expect(code({ ...big, refundedCents }, ask(amount))).toBe(expected);
  });

  it('a cap of 0 sends every refund to a person', () => {
    expect(code(order(), ask(1), policy({ autoApproveMaxCents: 0 }))).toBe('ABOVE_AUTO_LIMIT');
  });
});

describe('decideRefund: return window and delivery date', () => {
  it.each<[string, string, string]>([
    ['delivered today', '2026-11-22', 'WITHIN_AUTO_LIMIT'],
    ['delivered 30 days ago (last allowed day)', '2026-10-23', 'WITHIN_AUTO_LIMIT'],
    ['delivered 31 days ago', '2026-10-22', 'OUTSIDE_RETURN_WINDOW'],
    ['delivered tomorrow (date in the future)', '2026-11-23', 'NOT_DELIVERED'],
    ['across a year boundary: 2025-12-31 is 326 days ago', '2025-12-31', 'OUTSIDE_RETURN_WINDOW'],
    ['not a real date', '2026-02-30', 'NOT_DELIVERED'],
    ['date with a time', '2026-11-13T00:00', 'NOT_DELIVERED'],
    ['free text', 'soon', 'NOT_DELIVERED'],
    ['empty text', '', 'NOT_DELIVERED'],
  ])('%s', (_name, deliveredOn, expected) => {
    expect(code(order({ deliveredOn }), ask())).toBe(expected);
  });

  it('a window of 0 days allows only delivery today', () => {
    const p = policy({ returnWindowDays: 0 });
    expect(code(order({ deliveredOn: '2026-11-22' }), ask(), p)).toBe('WITHIN_AUTO_LIMIT');
    expect(code(order({ deliveredOn: '2026-11-21' }), ask(), p)).toBe('OUTSIDE_RETURN_WINDOW');
  });

  it('counts across a leap day', () => {
    // 2028-02-29 exists; from 2028-02-01 to 2028-03-02 is 30 days.
    const now = new Date('2028-03-02T12:00:00Z');
    expect(code(order({ deliveredOn: '2028-02-01' }), ask(), policy(), now)).toBe('WITHIN_AUTO_LIMIT');
    expect(code(order({ deliveredOn: '2028-01-31' }), ask(), policy(), now)).toBe('OUTSIDE_RETURN_WINDOW');
  });
});

describe('decideRefund: "today" is the calendar date in the policy time zone', () => {
  const lateEvening = new Date('2026-11-22T21:30:00Z'); // Istanbul: already 2026-11-23 00:30

  it('a delivery dated tomorrow in UTC is today in Istanbul', () => {
    const o = order({ deliveredOn: '2026-11-23' });
    expect(code(o, ask(), policy({ timeZone: 'UTC' }), lateEvening)).toBe('NOT_DELIVERED');
    expect(code(o, ask(), policy({ timeZone: 'Europe/Istanbul' }), lateEvening)).toBe('WITHIN_AUTO_LIMIT');
  });

  it('day 30 in UTC is day 31 in Istanbul', () => {
    const o = order({ deliveredOn: '2026-10-23' });
    expect(code(o, ask(), policy({ timeZone: 'UTC' }), lateEvening)).toBe('WITHIN_AUTO_LIMIT');
    expect(code(o, ask(), policy({ timeZone: 'Europe/Istanbul' }), lateEvening)).toBe('OUTSIDE_RETURN_WINDOW');
  });

  it('a time zone behind UTC is still on the previous day', () => {
    const earlyUtc = new Date('2026-11-23T03:00:00Z'); // Los Angeles: 2026-11-22 19:00
    const o = order({ deliveredOn: '2026-11-23' });
    expect(code(o, ask(), policy({ timeZone: 'UTC' }), earlyUtc)).toBe('WITHIN_AUTO_LIMIT');
    expect(code(o, ask(), policy({ timeZone: 'America/Los_Angeles' }), earlyUtc)).toBe('NOT_DELIVERED');
  });

  it.each<[string, string, string]>([
    ['2026-11-24T20:59:59Z', 'Europe/Istanbul', '2026-11-24'],
    ['2026-11-24T21:00:00Z', 'Europe/Istanbul', '2026-11-25'],
    ['2026-11-24T23:59:59Z', 'UTC', '2026-11-24'],
    ['2026-11-25T00:00:00Z', 'UTC', '2026-11-25'],
    ['2026-01-01T02:00:00Z', 'America/Los_Angeles', '2025-12-31'],
  ])('calendarDateIn(%s, %s) = %s', (iso, timeZone, expected) => {
    expect(calendarDateIn(new Date(iso), timeZone)).toBe(expected);
  });
});

describe('decideRefund: amounts', () => {
  it.each<[string, number]>([
    ['zero', 0],
    ['negative', -100],
    ['a fraction of a cent', 10.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above the safe integer range', 2 ** 53],
  ])('refuses %s', (_name, amount) => {
    expect(code(order(), ask(amount))).toBe('INVALID_AMOUNT');
  });

  it('allows a partial refund up to what is left, and not one cent more', () => {
    const o = order({ refundedCents: 500 }); // 1300 left
    expect(code(o, ask(1300))).toBe('WITHIN_AUTO_LIMIT');
    expect(code(o, ask(1301))).toBe('AMOUNT_EXCEEDS_REMAINING');
    expect(code(o, ask(1))).toBe('WITHIN_AUTO_LIMIT');
  });

  it('without partial refunds, only exactly what is left is allowed', () => {
    const p = policy({ allowPartialRefunds: false });
    const o = order({ refundedCents: 500 }); // 1300 left (refunded manually in the admin before)
    expect(code(o, ask(1300), p)).toBe('WITHIN_AUTO_LIMIT');
    expect(code(o, ask(1299), p)).toBe('PARTIAL_NOT_ALLOWED');
  });

  it('an order whose refunds already reach the total is ALREADY_REFUNDED, whatever the status', () => {
    expect(code(order({ refundedCents: 1800 }), ask(1))).toBe('ALREADY_REFUNDED');
    expect(code(order({ refundedCents: 1900 }), ask(1))).toBe('ALREADY_REFUNDED');
  });
});

describe('decideRefund: currency', () => {
  it.each<[string, string, string, string]>([
    ['request in another currency', 'USD', 'EUR', 'USD'],
    ['order in another currency than the policy', 'EUR', 'EUR', 'USD'],
    ['lowercase currency in the request', 'USD', 'usd', 'USD'],
  ])('%s', (_name, orderCurrency, requestCurrency, policyCurrency) => {
    expect(
      code(order({ currency: orderCurrency }), ask(1800, requestCurrency), policy({ currency: policyCurrency })),
    ).toBe('CURRENCY_MISMATCH');
  });
});

describe('decideRefund: statuses', () => {
  it.each(['pending', 'processing', 'on_hold', 'cancelled', 'failed', 'other'] as const)(
    'refuses %s when only completed is allowed',
    (status) => {
      expect(code(order({ status }), ask())).toBe('STATUS_NOT_ALLOWED');
    },
  );

  it('status refunded wins even when no refund amount is recorded (status set by hand)', () => {
    expect(code(order({ status: 'refunded', refundedCents: 0 }), ask())).toBe('ALREADY_REFUNDED');
  });

  it('allows a status the policy lists', () => {
    const p = policy({ refundableStatuses: ['completed', 'processing'] });
    expect(code(order({ status: 'processing' }), ask(), p)).toBe('WITHIN_AUTO_LIMIT');
  });
});

describe('decideRefund: a pure function', () => {
  it('gives the same answer for the same input and changes nothing', () => {
    const o = Object.freeze(order({ totalCents: 8900 }));
    const r = Object.freeze(ask(8900));
    const p = Object.freeze(policy());
    const now = new Date(NOW.getTime());
    const first = decideRefund(o, r, p, now);
    const second = decideRefund(o, r, p, now);
    expect(second).toEqual(first);
    expect(now.getTime()).toBe(NOW.getTime());
    expect(o).toEqual(order({ totalCents: 8900 }));
  });

  it('copies the policy version into every answer', () => {
    const p = policy({ policyVersion: 'v9+abcdefabcdef' });
    expect(decideRefund(order(), ask(), p, NOW).policyVersion).toBe('v9+abcdefabcdef');
    expect(decideRefund(order(), ask(0), p, NOW).policyVersion).toBe('v9+abcdefabcdef');
    expect(decideRefund(order({ totalCents: 9000 }), ask(9000), p, NOW).policyVersion).toBe('v9+abcdefabcdef');
  });

  it('stops on an invalid clock (our bug, not a business answer)', () => {
    expect(() => decideRefund(order(), ask(), policy(), new Date('nope'))).toThrow(/invalid clock/);
  });

  it.each<[string, Partial<OrderSnapshot>]>([
    ['fractional total', { totalCents: 18.5 }],
    ['negative refunded amount', { refundedCents: -1 }],
    ['NaN total', { totalCents: Number.NaN }],
  ])('stops on broken order amounts: %s', (_name, change) => {
    expect(() => decideRefund(order(change), ask(), policy(), NOW)).toThrow(/whole, non-negative cents/);
  });
});

describe('the committed policy with the 7 demo orders (snapshot of Nov 22, full refund each)', () => {
  const committed = loadPolicy().refund;
  const demo: Array<[string, Partial<OrderSnapshot>, string, string]> = [
    ['20', { status: 'completed', totalCents: 1800, deliveredOn: '2026-11-13' }, 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT'],
    ['21', { status: 'processing', totalCents: 12900, deliveredOn: null }, 'REJECT', 'NOT_DELIVERED'],
    ['22', { status: 'completed', totalCents: 8900, deliveredOn: '2026-11-15' }, 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT'],
    ['23', { status: 'completed', totalCents: 6400, deliveredOn: '2026-10-05' }, 'REJECT', 'OUTSIDE_RETURN_WINDOW'],
    ['24', { status: 'refunded', paid: false, totalCents: 7500, refundedCents: 7500, deliveredOn: '2026-11-10' }, 'REJECT', 'ALREADY_REFUNDED'],
    ['25', { status: 'completed', totalCents: 3500, deliveredOn: '2026-11-17' }, 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT'],
    ['26', { status: 'processing', totalCents: 2200, deliveredOn: null }, 'REJECT', 'NOT_DELIVERED'],
  ];

  it.each(demo)('order #%s', (orderId, change, decision, reasonCode) => {
    const o = order({ orderId, ...change });
    expect(decideRefund(o, ask(o.totalCents), committed, NOW)).toEqual({
      decision,
      reasonCode,
      policyVersion: committed.policyVersion,
    });
  });
});