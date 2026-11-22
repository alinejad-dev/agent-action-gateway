// The platform-neutral view of a store that the policy and the action tools use.
// WooCommerce implements it now; a Shopify adapter (Phase 2.5) will return the same shapes.
// Methods are added only when they are implemented.

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

/** Why the store refused an action. Only used when we know for certain that nothing changed. */
export type ActionRejection =
  | 'WRITE_KEY_MISSING'
  | 'AUTH'
  | 'ORDER_NOT_FOUND'
  | 'STORE_REFUSED'
  | 'INVALID_REQUEST';

export type RefundResult =
  | { outcome: 'created'; storeRefundId: string; amountCents: number }
  | { outcome: 'rejected'; reason: ActionRejection }
  // The refund may or may not exist. Never retry: find it by the request id instead.
  | { outcome: 'unknown' };

export type CancelRequest = {
  orderId: string;
  requestId: string; // action_requests.id (UUID), stored on the order
};

export type CancelResult =
  | { outcome: 'cancelled' }
  | { outcome: 'rejected'; reason: ActionRejection }
  // The order may or may not have changed. Never retry blindly: read the order again instead.
  | { outcome: 'unknown' };

export type FindRefundRequest = {
  orderId: string;
  requestId: string; // action_requests.id (UUID) that createRefund stored on the refund
};

export type FindRefundResult =
  | { outcome: 'found'; storeRefundId: string; amountCents: number }
  // Certainly no refund with this request id on an order that still exists.
  | { outcome: 'absent' }
  // More than one refund carries this request id: an alarm for a person, never pick one silently.
  | { outcome: 'duplicate'; storeRefundIds: string[] }
  // Not certain (no complete answer, or the order is missing or in the trash). Keep the order locked.
  | { outcome: 'unknown' };

export interface StoreAdapter {
  readonly platform: 'woocommerce';
  /** Reads one order fresh from the store (never from a cache). */
  getOrder(orderId: string): Promise<OrderSnapshot>;
  /** Records a refund in the store. Never throws for a store answer: see RefundResult. */
  createRefund(request: RefundRequest): Promise<RefundResult>;
  /**
   * Sets the order to cancelled. Never throws for a store answer: see CancelResult.
   * It does not check the current status: which statuses may be cancelled is the policy's decision.
   */
  cancelOrder(request: CancelRequest): Promise<CancelResult>;
  /**
   * Looks for the refund that createRefund stored with this request id (for an 'unknown' outcome).
   * WARNING: 'absent' is only trustworthy once the original request can no longer be in flight.
   * A refund that is still being processed appears seconds later; calling it failed too early and
   * sending a new request would refund twice. Reconciliation waits a safe delay first.
   * A cancel is reconciled with getOrder (the status), not with this method.
   */
  findRefund(request: FindRefundRequest): Promise<FindRefundResult>;
}