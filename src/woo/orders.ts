import * as z from 'zod/v4';
import { wooGet, WooError } from './client.js';

// Only the fields we need. Zod drops everything else —
// including emails, phone numbers and addresses — so they never reach the model.
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

const MAX_SEARCH_RESULTS = 10;

/** Converts "-18.00" or "18.00" to 1800 cents — avoids floating-point money bugs. */
function toCents(amount: string): number {
  return Math.round(Math.abs(Number(amount)) * 100);
}

/** The single place that decides what order data the model is allowed to see. */
function summarize(order: WooOrder): OrderSummary {
  const refundedCents = order.refunds.reduce((sum, refund) => sum + toCents(refund.total), 0);
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
    refundedTotal: (refundedCents / 100).toFixed(2),
  };
}

export async function getOrder(orderId: number): Promise<OrderSummary> {
  const raw = await wooGet(`/orders/${orderId}`);
  const parsed = WooOrderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WooError('BAD_RESPONSE', 'Unexpected order shape from store');
  }
  return summarize(parsed.data);
}

/** Finds orders by customer name or email. Returns at most MAX_SEARCH_RESULTS, newest first. */
export async function searchOrders(query: string): Promise<OrderSummary[]> {
  const raw = await wooGet('/orders', { search: query, per_page: String(MAX_SEARCH_RESULTS) });
  const parsed = z.array(WooOrderSchema).safeParse(raw);
  if (!parsed.success) {
    throw new WooError('BAD_RESPONSE', 'Unexpected orders list shape from store');
  }
  return parsed.data.map(summarize);
}