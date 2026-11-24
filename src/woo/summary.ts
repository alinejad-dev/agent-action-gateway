// Turns a raw WooCommerce order into what the model is allowed to see (OrderSummary).
// Pure: no network and no config import, so the rules are tested without a store or a .env.

import * as z from 'zod/v4';
import { WooError } from './errors.js';
import { formatCents, refundTotalToCents } from './money.js';

// Only the fields we need. Zod drops everything else -
// including emails, phone numbers and addresses - so they never reach the model.
const WooOrderSchema = z.object({
  id: z.number().int(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  date_created: z.string(),
  billing: z.object({ first_name: z.string() }),
  line_items: z.array(
    z.object({ name: z.string(), quantity: z.number(), total: z.string() }),
  ),
  refunds: z.array(z.object({ id: z.number(), total: z.string() })),
});

type WooOrder = z.infer<typeof WooOrderSchema>;

export type OrderSummary = {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  createdAt: string;
  customerFirstName: string;
  items: { name: string; quantity: number; total: string }[];
  refundedTotal: string;
};

/**
 * Sum of all refunds in cents (integers, no floating-point money bugs).
 * An amount we cannot read is an error, not a guess: the refunded total must be exact.
 */
function refundedCents(order: WooOrder): number {
  let sum = 0;
  for (const refund of order.refunds) {
    const cents = refundTotalToCents(refund.total);
    if (cents === null) {
      throw new WooError('BAD_RESPONSE', 'Unexpected refund amount from store');
    }
    sum += cents;
  }
  return sum;
}

/** The single place that decides what order data the model is allowed to see. */
function summarize(order: WooOrder): OrderSummary {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    currency: order.currency,
    total: order.total,
    createdAt: order.date_created,
    customerFirstName: order.billing.first_name,
    items: order.line_items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      total: item.total,
    })),
    refundedTotal: formatCents(refundedCents(order)),
  };
}

/**
 * One order from GET /orders/<id>.
 * A trashed order still answers 200 (measured), but for the gateway it does not exist:
 * same rule as the adapter, so a read tool and an action never disagree about an order.
 */
export function readOrder(raw: unknown): OrderSummary {
  const parsed = WooOrderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WooError('BAD_RESPONSE', 'Unexpected order shape from store');
  }
  if (parsed.data.status === 'trash') {
    throw new WooError('NOT_FOUND', 'Order is in the trash');
  }
  return summarize(parsed.data);
}

/** A list from GET /orders. The list leaves trashed orders out (measured); we check it anyway. */
export function readOrderList(raw: unknown): OrderSummary[] {
  const parsed = z.array(WooOrderSchema).safeParse(raw);
  if (!parsed.success) {
    throw new WooError('BAD_RESPONSE', 'Unexpected orders list shape from store');
  }
  return parsed.data.filter((order) => order.status !== 'trash').map(summarize);
}