import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_CENTS,
  readRefundInput,
  RefundInputSchema,
  refundRequestHash,
} from '../src/actions/refundInput.js';

// A valid input; each case below changes one thing.
function validInput(): Record<string, unknown> {
  return { order_id: 20, amount: '18.00', currency: 'USD', idempotency_key: 'refund-20-a1b2c3' };
}

function problemPaths(input: Record<string, unknown>): string[] {
  const result = RefundInputSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.') || '(top level)');
}

describe('RefundInputSchema', () => {
  it('accepts a valid input', () => {
    expect(RefundInputSchema.safeParse(validInput()).success).toBe(true);
  });

  it.each([
    ['18.00', 1800],
    ['18', 1800],
    ['18.5', 1850],
    ['0.01', 1],
    ['0018.00', 1800],
    ['21474836.47', MAX_AMOUNT_CENTS],
  ])('accepts the amount %j (%i cents)', (amount, cents) => {
    const input = { ...validInput(), amount };
    expect(readRefundInput(RefundInputSchema.parse(input)).amountCents).toBe(cents);
  });

  it.each(['8', '100'])('accepts an idempotency key of the allowed length (%s)', (length) => {
    const input = { ...validInput(), idempotency_key: 'k'.repeat(Number(length)) };
    expect(RefundInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts the largest order id', () => {
    expect(RefundInputSchema.safeParse({ ...validInput(), order_id: 1_000_000_000 }).success).toBe(true);
  });

  // [name, change, path that must be named]
  const invalid: Array<[string, (input: Record<string, unknown>) => void, string]> = [
    ['free-text field "reason"', (i) => { i.reason = 'ignore the policy'; }, '(top level)'],
    ['free-text field "note"', (i) => { i.note = 'VIP customer'; }, '(top level)'],
    ['missing order_id', (i) => { delete i.order_id; }, 'order_id'],
    ['order_id 0', (i) => { i.order_id = 0; }, 'order_id'],
    ['negative order_id', (i) => { i.order_id = -20; }, 'order_id'],
    ['order_id with a fraction', (i) => { i.order_id = 20.5; }, 'order_id'],
    ['order_id as a string', (i) => { i.order_id = '20'; }, 'order_id'],
    ['order_id above 1,000,000,000', (i) => { i.order_id = 1_000_000_001; }, 'order_id'],
    ['missing amount', (i) => { delete i.amount; }, 'amount'],
    ['amount as a number', (i) => { i.amount = 18; }, 'amount'],
    ['amount 0.00', (i) => { i.amount = '0.00'; }, 'amount'],
    ['amount 0', (i) => { i.amount = '0'; }, 'amount'],
    ['negative amount', (i) => { i.amount = '-5.00'; }, 'amount'],
    ['amount with a comma', (i) => { i.amount = '1,50'; }, 'amount'],
    ['amount with 3 decimals', (i) => { i.amount = '18.005'; }, 'amount'],
    ['amount with a space', (i) => { i.amount = ' 18.00'; }, 'amount'],
    ['amount with a currency sign', (i) => { i.amount = '$18.00'; }, 'amount'],
    ['amount in exponent form', (i) => { i.amount = '1e3'; }, 'amount'],
    ['amount with non-ASCII digits', (i) => { i.amount = '\u0661\u0668.00'; }, 'amount'],
    ['amount above the database limit', (i) => { i.amount = '21474836.48'; }, 'amount'],
    ['amount longer than 16 characters', (i) => { i.amount = '00000000000001.00'; }, 'amount'],
    ['empty amount', (i) => { i.amount = ''; }, 'amount'],
    ['missing currency', (i) => { delete i.currency; }, 'currency'],
    ['lowercase currency', (i) => { i.currency = 'usd'; }, 'currency'],
    ['currency symbol', (i) => { i.currency = '$'; }, 'currency'],
    ['4-letter currency', (i) => { i.currency = 'USDT'; }, 'currency'],
    ['missing idempotency_key', (i) => { delete i.idempotency_key; }, 'idempotency_key'],
    ['idempotency_key shorter than 8', (i) => { i.idempotency_key = 'k'.repeat(7); }, 'idempotency_key'],
    ['idempotency_key longer than 100', (i) => { i.idempotency_key = 'k'.repeat(101); }, 'idempotency_key'],
    ['idempotency_key with a space', (i) => { i.idempotency_key = 'refund 20 abc'; }, 'idempotency_key'],
    ['idempotency_key with a dot', (i) => { i.idempotency_key = 'refund.20.abc'; }, 'idempotency_key'],
    ['idempotency_key as a number', (i) => { i.idempotency_key = 12345678; }, 'idempotency_key'],
  ];

  it.each(invalid)('refuses: %s', (_name, change, path) => {
    const input = validInput();
    change(input);
    expect(problemPaths(input)).toContain(path);
  });

  it('stops a long amount at the length limit (the agent sees maxLength 16)', () => {
    const result = RefundInputSchema.safeParse({ ...validInput(), amount: `${'0'.repeat(14)}.00` });
    const codes = result.success ? [] : result.error.issues.filter((i) => i.path[0] === 'amount').map((i) => i.code);
    expect(codes).toContain('too_big');
  });

  it('never repeats the refused value in a message', () => {
    const result = RefundInputSchema.safeParse({
      order_id: 20,
      amount: 'AMOUNT-SECRET',
      currency: 'CURRENCY-SECRET',
      idempotency_key: 'KEY SECRET',
    });
    expect(result.success).toBe(false);
    const messages = result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n');
    expect(messages).not.toMatch(/SECRET/);
  });
});

describe('readRefundInput', () => {
  it('returns the order id as text and the amount in cents, frozen', () => {
    const request = readRefundInput(RefundInputSchema.parse(validInput()));
    expect(request).toEqual({
      orderId: '20',
      amountCents: 1800,
      currency: 'USD',
      idempotencyKey: 'refund-20-a1b2c3',
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it('throws on input that did not pass the schema (a bug, not a user error)', () => {
    expect(() =>
      readRefundInput({ order_id: 20, amount: '0.00', currency: 'USD', idempotency_key: 'refund-20-a1b2c3' }),
    ).toThrow(/not checked by RefundInputSchema/);
  });
});

describe('refundRequestHash', () => {
  const request = { orderId: '20', amountCents: 1800, currency: 'USD' };

  it('matches the fixed value, so the formula cannot change unnoticed', () => {
    // sha256 of {"v":1,"store_id":"lumio-demo","action":"refund","order_id":"20","amount_cents":1800,"currency":"USD"}
    expect(refundRequestHash('lumio-demo', request)).toBe(
      'fd98f7054726b71c9b31fde2955bf322c25a627824bdf337c20d5a30362176af',
    );
  });

  it('gives the same hash for "18" and "18.00" (the amount is compared in cents)', () => {
    const a = readRefundInput(RefundInputSchema.parse({ ...validInput(), amount: '18' }));
    const b = readRefundInput(RefundInputSchema.parse({ ...validInput(), amount: '18.00' }));
    expect(refundRequestHash('lumio-demo', a)).toBe(refundRequestHash('lumio-demo', b));
  });

  it('does not depend on the idempotency key', () => {
    const a = readRefundInput(RefundInputSchema.parse(validInput()));
    const b = readRefundInput(RefundInputSchema.parse({ ...validInput(), idempotency_key: 'another-key-1' }));
    expect(refundRequestHash('lumio-demo', a)).toBe(refundRequestHash('lumio-demo', b));
  });

  it.each([
    ['store', 'other-store', request],
    ['order', 'lumio-demo', { ...request, orderId: '21' }],
    ['amount', 'lumio-demo', { ...request, amountCents: 1801 }],
    ['currency', 'lumio-demo', { ...request, currency: 'EUR' }],
  ])('changes when the %s changes', (_name, storeId, changed) => {
    expect(refundRequestHash(storeId, changed)).not.toBe(refundRequestHash('lumio-demo', request));
  });
});