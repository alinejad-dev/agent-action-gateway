import { wooGet } from './client.js';
import { readOrder, readOrderList, type OrderSummary } from './summary.js';

export type { OrderSummary } from './summary.js';

const MAX_SEARCH_RESULTS = 10;

/** One order for the model. A trashed order is NOT_FOUND (see readOrder). */
export async function getOrder(orderId: number): Promise<OrderSummary> {
  return readOrder(await wooGet(`/orders/${orderId}`));
}

/** Finds orders by customer name or email. Returns at most MAX_SEARCH_RESULTS, newest first. */
export async function searchOrders(query: string): Promise<OrderSummary[]> {
  return readOrderList(await wooGet('/orders', { search: query, per_page: String(MAX_SEARCH_RESULTS) }));
}