// The platform-neutral view of a store that the policy and the action tools use.
// WooCommerce implements it now; a Shopify adapter (Phase 2.5) will return the same shapes.
// Methods are added only when they are implemented (cancel comes in step 2d).

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

export type RefundRequest = {
  orderId: string;
  amountCents: number; // whole, positive number of cents
  requestId: string; // action_requests.id (UUID), stored on the refund so it can be found again
};

/** Why the store refused. Only used when we know for certain that nothing was created. */
export type RefundRejection =
  | 'WRITE_KEY_MISSING'
  | 'AUTH'
  | 'ORDER_NOT_FOUND'
  | 'STORE_REFUSED'
  | 'INVALID_REQUEST';

export type RefundResult =
  | { outcome: 'created'; storeRefundId: string; amountCents: number }
  | { outcome: 'rejected'; reason: RefundRejection }
  // The refund may or may not exist. Never retry: find it by the request id instead.
  | { outcome: 'unknown' };

export interface StoreAdapter {
  readonly platform: 'woocommerce';
  /** Reads one order fresh from the store (never from a cache). */
  getOrder(orderId: string): Promise<OrderSnapshot>;
  /** Records a refund in the store. Never throws for a store answer: see RefundResult. */
  createRefund(request: RefundRequest): Promise<RefundResult>;
}