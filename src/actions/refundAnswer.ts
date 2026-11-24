// What a refund request's database row becomes after each step, and the tool's answer.
// Pure: no database, no store, no network. The answer is built ONLY from the stored row,
// so a replay with the same idempotency key can never answer differently from the first call.
import type { RefundDecision } from '../policy/refund.js';
import type { RefundResult } from '../store/adapter.js';
import type { ErrorCode } from '../tools/envelope.js';
import type { WooErrorKind } from '../woo/errors.js';
import { formatCents } from '../woo/money.js';

/** gateway.action_requests.status */
export type RequestStatus =
  | 'in_progress'
  | 'rejected'
  | 'pending_approval'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/** gateway.action_requests.decision */
export type Decision = RefundDecision['decision'];

/** The columns one step sets on the row (the database layer writes exactly these). */
export type RowChange = Readonly<{
  status: RequestStatus;
  decision: Decision | null;
  reasonCode: string;
  policyVersion: string | null;
  storeRefundId: string | null;
}>;

/** The live re-fetch of the order failed: nothing was sent to the store. */
export function rowAfterReadError(kind: WooErrorKind): RowChange {
  if (kind === 'NOT_FOUND') {
    return {
      status: 'rejected',
      decision: 'REJECT',
      reasonCode: 'ORDER_NOT_FOUND',
      policyVersion: null,
      storeRefundId: null,
    };
  }
  // No usable answer (also AUTH and BAD_RESPONSE): the policy never ran, so there is no decision.
  return {
    status: 'failed',
    decision: null,
    reasonCode: 'STORE_UNAVAILABLE',
    policyVersion: null,
    storeRefundId: null,
  };
}

/** The policy decided. AUTO_APPROVE keeps the row in_progress until the store has answered. */
export function rowAfterDecision(decision: RefundDecision): RowChange {
  const base = {
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    storeRefundId: null,
  };
  switch (decision.decision) {
    case 'REJECT':
      return { ...base, status: 'rejected' };
    case 'NEEDS_APPROVAL':
      return { ...base, status: 'pending_approval' };
    case 'AUTO_APPROVE':
      return { ...base, status: 'in_progress' };
  }
}

type AutoApprove = Extract<RefundDecision, { decision: 'AUTO_APPROVE' }>;

/**
 * The store answered the refund (only after AUTO_APPROVE).
 * A refusal replaces the reason code with the store's code; the policy's reason stays in the audit log.
 */
export function rowAfterExecution(decision: AutoApprove, result: RefundResult): RowChange {
  const base = { decision: decision.decision, policyVersion: decision.policyVersion };
  switch (result.outcome) {
    case 'created':
      return {
        ...base,
        status: 'succeeded',
        reasonCode: decision.reasonCode,
        storeRefundId: result.storeRefundId,
      };
    case 'rejected':
      return { ...base, status: 'failed', reasonCode: result.reason, storeRefundId: null };
    case 'unknown':
      // The refund may exist. Never retried: reconciliation (P2-4b) finds it by the request id.
      return { ...base, status: 'unknown', reasonCode: decision.reasonCode, storeRefundId: null };
  }
}

/** The stored row, as the database layer reads it back. */
export type StoredRefundRequest = Readonly<{
  id: string;
  status: RequestStatus;
  decision: Decision | null;
  reasonCode: string | null;
  amountCents: number;
  currency: string;
  storeRefundId: string | null;
}>;

export type RefundAnswerData = {
  request_id: string;
  status: RequestStatus;
  decision: Decision | null;
  reason_code: string | null;
  amount: string;
  currency: string;
  store_refund_id: string | null;
  replayed: boolean;
  next_step: string;
};

export type RefundAnswer =
  | { ok: true; data: RefundAnswerData }
  | { ok: false; code: ErrorCode; message: string };

// Fixed texts: the agent acts on them, so they say plainly whether to retry.
// "Recorded in the store", never "money returned": a store refund is a record, not a payment.
const NEXT_STEP: Record<RequestStatus, string> = {
  succeeded: 'The refund is recorded in the store. Do not request it again.',
  rejected: 'This refund is not allowed (see reason_code). Do not retry the same request.',
  pending_approval:
    'A person must approve this refund. Nothing is refunded yet. ' +
    'Do not retry: the order is locked until a decision is made.',
  unknown:
    'The store did not confirm the refund. Do not retry: the gateway will check the store and finish this request.',
  failed: 'Nothing was refunded (see reason_code). To try again, use a new idempotency_key.',
  in_progress: 'This request is still being processed or was interrupted. Do not retry: a person must check it.',
  cancelled: 'This request was cancelled. Nothing was refunded. A new request needs a new idempotency_key.',
};

export const STORE_UNAVAILABLE_MESSAGE =
  'The store did not answer while the order was being read. Nothing was sent to the store. ' +
  'To try again later, use a new idempotency_key.';

/** The tool's answer, built only from the stored row (first call and replay alike). */
export function answerFromRow(row: StoredRefundRequest, replayed: boolean): RefundAnswer {
  if (row.status === 'failed' && row.reasonCode === 'STORE_UNAVAILABLE') {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: STORE_UNAVAILABLE_MESSAGE };
  }
  return {
    ok: true,
    data: {
      request_id: row.id,
      status: row.status,
      decision: row.decision,
      reason_code: row.reasonCode,
      amount: formatCents(row.amountCents),
      currency: row.currency,
      store_refund_id: row.storeRefundId,
      replayed,
      next_step: NEXT_STEP[row.status],
    },
  };
}

/** Same key, other values (another order, amount or currency). Nothing is saved. */
export const KEY_REUSED_ANSWER: RefundAnswer = Object.freeze({
  ok: false,
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This idempotency_key was already used for a different request. Use a new key for a new request.',
});

/** Another request for this order is still open. Nothing is saved. */
export const REFUND_PENDING_ANSWER: RefundAnswer = Object.freeze({
  ok: false,
  code: 'REFUND_PENDING',
  message:
    'Another request for this order is still open (in progress, waiting for approval, or not yet confirmed). ' +
    'Do not retry now: wait until it is finished.',
});