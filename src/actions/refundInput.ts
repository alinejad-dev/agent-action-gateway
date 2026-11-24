// The input of the request_refund tool and the request hash. Pure: no database, no store, no network.
// The schema is strict: an extra field (for example a free-text "reason") is refused by the MCP SDK
// before any of our code runs, so nothing the model writes can reach the store or the database.
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { parseMoneyToCents } from '../woo/money.js';

/** The largest amount the database column (integer) can hold: 2^31 - 1 cents. */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/** "18.00" -> 1800. null for anything that is not a positive amount the database can store. */
function toAmountCents(value: string): number | null {
  const cents = parseMoneyToCents(value);
  return cents !== null && cents > 0 && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

export const RefundInputSchema = z.strictObject({
  order_id: z
    .number()
    .int()
    .positive()
    .max(1_000_000_000)
    .describe('The numeric WooCommerce order ID, e.g. 20'),
  amount: z
    .string()
    .max(16)
    .refine((value) => toAmountCents(value) !== null, 'must be a positive amount like "18.00"')
    .describe('Amount to refund as a string with a dot and at most 2 decimals, e.g. "18.00"'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code like "USD"')
    .describe('Currency of the order, e.g. "USD". Must match the order.'),
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/, 'must be 8-100 letters, digits, "_" or "-"')
    .describe(
      'A unique key you choose for this refund request (8-100 letters, digits, "_" or "-"). ' +
        'Sending the same key with the same values again returns the first answer. ' +
        'Never reuse a key for a different request.',
    ),
});

export type RefundInput = z.infer<typeof RefundInputSchema>;

/** The checked input in the form the gateway works with: order id as text, amount in cents. */
export type RefundRequestInput = Readonly<{
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}>;

/** Converts input that already passed RefundInputSchema. Throws only on a bug (unchecked input). */
export function readRefundInput(input: RefundInput): RefundRequestInput {
  const amountCents = toAmountCents(input.amount);
  if (amountCents === null) {
    throw new Error('readRefundInput: the amount was not checked by RefundInputSchema');
  }
  return Object.freeze({
    orderId: String(input.order_id),
    amountCents,
    currency: input.currency,
    idempotencyKey: input.idempotency_key,
  });
}

/**
 * sha256 (64 hex) of the request's values, saved as action_requests.request_hash.
 * Same key + same hash = a replay of the first answer; same key + another hash = the key was reused.
 * The idempotency key itself is not part of the hash, and the amount is in cents,
 * so "18" and "18.00" are the same request. The key order is fixed by the object literal.
 */
export function refundRequestHash(
  storeId: string,
  request: Pick<RefundRequestInput, 'orderId' | 'amountCents' | 'currency'>,
): string {
  const canonical = JSON.stringify({
    v: 1,
    store_id: storeId,
    action: 'refund',
    order_id: request.orderId,
    amount_cents: request.amountCents,
    currency: request.currency,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}