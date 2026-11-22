// WooCommerce implementation of the StoreAdapter.
// It does NOT import config.ts: store address, keys and the delivery meta key are arguments,
// so the tests run without a .env file.
import * as z from 'zod/v4';
import type { OrderSnapshot, OrderStatus, StoreAdapter } from '../store/adapter.js';
import { WooError } from './errors.js';
import type { WooKeyPair } from './keys.js';
import { parseMoneyToCents, refundTotalToCents } from './money.js';
import { storeRequest, type FetchLike } from './request.js';

export type WooAdapterOptions = {
  baseUrl: string;
  readKeys: WooKeyPair; // reading an order, also right before an action, uses the read-only key
  deliveredMetaKey: string; // order meta that holds the delivery date, e.g. lumio_delivered_date
  fetchImpl?: FetchLike;
};

const ORDER_ID = /^[1-9][0-9]{0,11}$/;
const META_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

export function createWooAdapter(options: WooAdapterOptions): StoreAdapter {
  if (!META_KEY.test(options.deliveredMetaKey)) {
    throw new Error('WooCommerce adapter: the delivery meta key has characters that are not allowed');
  }
  const { baseUrl, readKeys, deliveredMetaKey, fetchImpl } = options;

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
  };
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