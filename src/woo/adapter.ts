// WooCommerce implementation of the StoreAdapter.
// It does NOT import config.ts: store address, keys and the delivery meta key are arguments,
// so the tests run without a .env file.
import * as z from 'zod/v4';
import type {
  ActionRejection,
  CancelRequest,
  CancelResult,
  OrderSnapshot,
  OrderStatus,
  RefundRequest,
  RefundResult,
  StoreAdapter,
} from '../store/adapter.js';
import { WooError } from './errors.js';
import type { WooKeyPair } from './keys.js';
import { formatCents, parseMoneyToCents, refundTotalToCents } from './money.js';
import { storeRequest, type FetchLike, type StoreAnswer } from './request.js';

export type WooAdapterOptions = {
  baseUrl: string;
  readKeys: WooKeyPair; // reading an order, also right before an action, uses the read-only key
  writeKeys: WooKeyPair | null; // only for actions; null = read-only setup, every action is refused
  deliveredMetaKey: string; // order meta that holds the delivery date, e.g. lumio_delivered_date
  // Always sent explicitly: WooCommerce's own default for both is true.
  refundFlags: { apiRefund: boolean; apiRestock: boolean };
  fetchImpl?: FetchLike;
};

/** Meta key on every refund we create and every order we cancel, holding our request id. */
export const REQUEST_ID_META_KEY = 'gateway_request_id';

const ORDER_ID = /^[1-9][0-9]{0,11}$/;
const META_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Only the fields the snapshot needs. Zod drops everything else, including all customer data.
const WooSnapshotSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  date_paid: z.string().nullable(),
  refunds: z.array(z.object({ total: z.string() })),
  meta_data: z.array(z.object({ key: z.string(), value: z.unknown() })),
});

type WooSnapshotData = z.infer<typeof WooSnapshotSchema>;

const WooRefundSchema = z.object({ id: z.number().int().positive(), amount: z.string() });
const WooCancelSchema = z.object({ id: z.number().int(), status: z.string() });

// A Map, not an object: a status like "constructor" must not find Object.prototype members.
const STATUS: ReadonlyMap<string, OrderStatus> = new Map([
  ['pending', 'pending'],
  ['processing', 'processing'],
  ['on-hold', 'on_hold'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled'],
  ['refunded', 'refunded'],
  ['failed', 'failed'],
]);

// Answers to a refund request that, measured on WooCommerce 11.1.2, created nothing.
// Every other answer is 'unknown': when in doubt we never assume that nothing happened.
const REFUND_REJECTIONS: ReadonlyMap<string, ActionRejection> = new Map([
  ['500 woocommerce_rest_invalid_order_id', 'ORDER_NOT_FOUND'],
  ['500 woocommerce_rest_cannot_create_order_refund', 'STORE_REFUSED'], // amount too high or gateway problem
  ['500 woocommerce_rest_invalid_order_refund', 'INVALID_REQUEST'],
  ['400 rest_invalid_param', 'INVALID_REQUEST'],
]);

// The same for a cancel (PUT /orders/<id>), measured on WooCommerce 11.1.2.
const CANCEL_REJECTIONS: ReadonlyMap<string, ActionRejection> = new Map([
  ['400 woocommerce_rest_shop_order_invalid_id', 'ORDER_NOT_FOUND'],
  ['400 rest_invalid_param', 'INVALID_REQUEST'],
]);

const UNKNOWN = { outcome: 'unknown' } as const;

export function createWooAdapter(options: WooAdapterOptions): StoreAdapter {
  if (!META_KEY.test(options.deliveredMetaKey)) {
    throw new Error('WooCommerce adapter: the delivery meta key has characters that are not allowed');
  }
  const { apiRefund, apiRestock } = options.refundFlags;
  if (typeof apiRefund !== 'boolean' || typeof apiRestock !== 'boolean') {
    throw new Error('WooCommerce adapter: apiRefund and apiRestock must be true or false');
  }
  const { baseUrl, readKeys, writeKeys, deliveredMetaKey, fetchImpl } = options;

  return {
    platform: 'woocommerce',

    async getOrder(orderId: string): Promise<OrderSnapshot> {
      // A WooCommerce order id is a positive number; anything else cannot exist.
      if (!ORDER_ID.test(orderId)) {
        throw new WooError('NOT_FOUND', 'Resource not found');
      }
      const answer = await storeRequest(
        { baseUrl, keys: readKeys, method: 'GET', path: `/orders/${orderId}` },
        fetchImpl,
      );
      if (answer === null) {
        throw new WooError('UNAVAILABLE', 'Store did not respond');
      }
      if (answer.status === 404) {
        throw new WooError('NOT_FOUND', 'Resource not found', 404);
      }
      if (answer.status === 401 || answer.status === 403) {
        throw new WooError('AUTH', 'Store rejected our credentials', answer.status);
      }
      if (answer.status !== 200) {
        throw new WooError('UNAVAILABLE', `Store returned HTTP ${answer.status}`, answer.status);
      }
      const parsed = WooSnapshotSchema.safeParse(answer.data);
      if (!parsed.success || String(parsed.data.id) !== orderId) {
        throw new WooError('BAD_RESPONSE', 'Unexpected order shape from store');
      }
      return toSnapshot(parsed.data, deliveredMetaKey);
    },

    async createRefund({ orderId, amountCents, requestId }: RefundRequest): Promise<RefundResult> {
      // Bugs in our own code, caught before anything is sent.
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new Error('WooCommerce adapter: the refund amount must be a whole, positive number of cents');
      }
      assertRequestId(requestId);
      if (writeKeys === null) {
        return { outcome: 'rejected', reason: 'WRITE_KEY_MISSING' }; // fail closed, nothing sent
      }
      if (!ORDER_ID.test(orderId)) {
        return { outcome: 'rejected', reason: 'ORDER_NOT_FOUND' };
      }
      const answer = await storeRequest(
        {
          baseUrl,
          keys: writeKeys,
          method: 'POST',
          path: `/orders/${orderId}/refunds`,
          body: {
            amount: formatCents(amountCents), // built from cents, never from text we were given
            reason: `Action Gateway request ${requestId}`, // fixed text: no model or customer input
            api_refund: apiRefund,
            api_restock: apiRestock,
            meta_data: [{ key: REQUEST_ID_META_KEY, value: requestId }],
          },
        },
        fetchImpl,
      );
      return readRefundAnswer(answer);
    },

    // Side effects of a cancel in WooCommerce (measured): stock goes back up and the shop is
    // emailed. WooCommerce accepts it from ANY status, even completed or refunded.
    async cancelOrder({ orderId, requestId }: CancelRequest): Promise<CancelResult> {
      assertRequestId(requestId);
      if (writeKeys === null) {
        return { outcome: 'rejected', reason: 'WRITE_KEY_MISSING' }; // fail closed, nothing sent
      }
      if (!ORDER_ID.test(orderId)) {
        return { outcome: 'rejected', reason: 'ORDER_NOT_FOUND' };
      }
      // WooCommerce has no cancel endpoint: a cancel is a status change. Status and meta are
      // saved in one request.
      const answer = await storeRequest(
        {
          baseUrl,
          keys: writeKeys,
          method: 'PUT',
          path: `/orders/${orderId}`,
          body: { status: 'cancelled', meta_data: [{ key: REQUEST_ID_META_KEY, value: requestId }] },
        },
        fetchImpl,
      );
      return readCancelAnswer(answer, orderId);
    },
  };
}

function assertRequestId(requestId: string): void {
  if (!UUID.test(requestId)) {
    throw new Error('WooCommerce adapter: the request id must be a lowercase UUID');
  }
}

function readRefundAnswer(answer: StoreAnswer | null): RefundResult {
  if (answer === null) {
    return UNKNOWN; // no answer: the refund may have been created
  }
  if (answer.status === 200 || answer.status === 201) {
    const parsed = WooRefundSchema.safeParse(answer.data);
    const cents = parsed.success ? parseMoneyToCents(parsed.data.amount) : null;
    if (!parsed.success || cents === null || cents < 0) {
      return UNKNOWN; // created, but we can't read it: find it by the request id
    }
    // The amount the store recorded, which the caller compares with the amount it asked for.
    return { outcome: 'created', storeRefundId: String(parsed.data.id), amountCents: cents };
  }
  if (answer.status === 401 || answer.status === 403) {
    // The key is checked before the route runs, so nothing was created.
    return { outcome: 'rejected', reason: 'AUTH' };
  }
  const reason = REFUND_REJECTIONS.get(`${answer.status} ${answer.code}`);
  return reason === undefined ? UNKNOWN : { outcome: 'rejected', reason };
}

function readCancelAnswer(answer: StoreAnswer | null, orderId: string): CancelResult {
  if (answer === null) {
    return UNKNOWN; // no answer: the order may have been cancelled
  }
  if (answer.status === 200) {
    const parsed = WooCancelSchema.safeParse(answer.data);
    // A 200 alone is not enough: a plugin can keep the old status. Only the saved status counts.
    const cancelled =
      parsed.success && String(parsed.data.id) === orderId && parsed.data.status === 'cancelled';
    return cancelled ? { outcome: 'cancelled' } : UNKNOWN; // our meta may have been saved anyway
  }
  if (answer.status === 401 || answer.status === 403) {
    // The key is checked before the route runs, so nothing changed.
    return { outcome: 'rejected', reason: 'AUTH' };
  }
  const reason = CANCEL_REJECTIONS.get(`${answer.status} ${answer.code}`);
  return reason === undefined ? UNKNOWN : { outcome: 'rejected', reason };
}

function toSnapshot(order: WooSnapshotData, deliveredMetaKey: string): OrderSnapshot {
  // A trashed order still answers 200 (measured), but for the gateway it does not exist.
  if (order.status === 'trash') {
    throw new WooError('NOT_FOUND', 'Resource not found');
  }
  const totalCents = parseMoneyToCents(order.total);
  if (totalCents === null || totalCents < 0 || !CURRENCY.test(order.currency)) {
    throw new WooError('BAD_RESPONSE', 'Unexpected order amount or currency from store');
  }
  let refundedCents = 0;
  for (const refund of order.refunds) {
    const cents = refundTotalToCents(refund.total);
    if (cents === null) {
      throw new WooError('BAD_RESPONSE', 'Unexpected refund amount from store');
    }
    refundedCents += cents;
  }
  return {
    orderId: String(order.id),
    status: STATUS.get(order.status) ?? 'other',
    paid: order.date_paid !== null && order.date_paid !== '',
    currency: order.currency,
    totalCents,
    refundedCents,
    deliveredOn: readCalendarDate(order.meta_data, deliveredMetaKey),
  };
}

/**
 * The value of exactly one meta entry with this key, when it is a real calendar date "YYYY-MM-DD".
 * Anything uncertain (missing, twice, not text, "soon", 2026-02-30, a time attached) -> null.
 */
export function readCalendarDate(meta: { key: string; value: unknown }[], key: string): string | null {
  const entries = meta.filter((entry) => entry.key === key);
  const value = entries.length === 1 ? entries[0]?.value : undefined;
  if (typeof value !== 'string') {
    return null;
  }
  const match = CALENDAR_DATE.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? value : null;
}