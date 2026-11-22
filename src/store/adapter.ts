// The platform-neutral view of a store that the policy and the action tools use.
// WooCommerce implements it now; a Shopify adapter (Phase 2.5) will return the same shapes.
// Methods are added only when they are implemented (refund in step 2c, cancel in 2d).

/** Order statuses the gateway understands. Anything else is 'other', which the policy never allows. */
export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'on_hold'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed'
  | 'other';

/** What the policy needs to know about an order. No customer data on purpose. */
export type OrderSnapshot = {
  orderId: string; // text, so Shopify ids fit (same as action_requests.order_id)
  status: OrderStatus;
  paid: boolean;
  currency: string; // ISO 4217, e.g. "USD"
  totalCents: number;
  refundedCents: number;
  // Calendar date "YYYY-MM-DD" with no time and no time zone; the policy decides how to count days.
  // null = not delivered or not known for certain.
  deliveredOn: string | null;
};

export interface StoreAdapter {
  readonly platform: 'woocommerce';
  /** Reads one order fresh from the store (never from a cache). */
  getOrder(orderId: string): Promise<OrderSnapshot>;
}