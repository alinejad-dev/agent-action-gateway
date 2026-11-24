// The request_refund flow, in a fixed order:
// claim -> live re-fetch of the order (read key) -> policy -> decision step -> store refund -> execution step.
// Each database step is one short statement or one short transaction; no transaction is open
// while the store is called, and the store refund is only sent after the decision step is committed.
// Once a request is claimed it always runs to the end (no abort): stopping halfway would leave it locked.
import { claimRefund, recordReplay, recordStep, type RequestsDb } from '../db/refundRequests.js';
import type { RefundPolicy } from '../policy/policyFile.js';
import { calendarDateIn, decideRefund } from '../policy/refund.js';
import type { OrderSnapshot, RefundResult, StoreAdapter } from '../store/adapter.js';
import { WooError } from '../woo/errors.js';
import {
  answerFromRow,
  KEY_REUSED_ANSWER,
  REFUND_PENDING_ANSWER,
  rowAfterDecision,
  rowAfterExecution,
  rowAfterReadError,
  type RefundAnswer,
  type StoredRefundRequest,
} from './refundAnswer.js';
import { readRefundInput, refundRequestHash, type RefundInput } from './refundInput.js';

/** Who called: the transport, not something the caller says about itself. */
export type Actor = 'stdio' | 'http';

/** Created once per process by the server. The clock and the adapter are injectable for tests. */
export type RefundFlowDeps = Readonly<{
  db: RequestsDb;
  adapter: StoreAdapter;
  policy: RefundPolicy;
  storeId: string;
  now: () => Date;
}>;

const LOG = '[request_refund]';

/**
 * Runs one request_refund call. The input already passed RefundInputSchema (checked by the MCP SDK).
 * Every answer is built from the stored row. Unexpected errors (database, bugs) are thrown:
 * the tool turns them into INTERNAL_ERROR, and the claimed row stays in_progress (order locked).
 */
export async function runRefund(deps: RefundFlowDeps, input: RefundInput, actor: Actor): Promise<RefundAnswer> {
  const request = readRefundInput(input);
  const claim = await claimRefund(deps.db, {
    storeId: deps.storeId,
    orderId: request.orderId,
    amountCents: request.amountCents,
    currency: request.currency,
    idempotencyKey: request.idempotencyKey,
    requestHash: refundRequestHash(deps.storeId, request),
    actor,
  });
  switch (claim.outcome) {
    case 'replay':
      await recordReplay(deps.db, claim.row, actor);
      return answerFromRow(claim.row, true);
    case 'key_reused':
      // No row of its own, so no audit entry (migration 002). Neither the key nor the amount is logged.
      console.error(`${LOG} IDEMPOTENCY_KEY_REUSED order ${request.orderId} (actor ${actor})`);
      return KEY_REUSED_ANSWER;
    case 'pending':
      return REFUND_PENDING_ANSWER;
    case 'claimed':
      return runClaimed(deps, claim.row, request.orderId);
  }
}

async function runClaimed(deps: RefundFlowDeps, row: StoredRefundRequest, orderId: string): Promise<RefundAnswer> {
  let order: OrderSnapshot;
  try {
    order = await deps.adapter.getOrder(orderId);
  } catch (error) {
    if (!(error instanceof WooError)) {
      throw error;
    }
    if (error.kind !== 'NOT_FOUND') {
      console.error(`[woo] ${error.kind}: ${error.message}`);
    }
    const failed = await recordStep(deps.db, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterReadError(error.kind),
      audit: { eventType: 'decision', outcome: null, detail: { step: 'read', error: error.kind } },
    });
    return answerFromRow(failed, false);
  }

  // One clock reading per request: the same moment for the policy and for "today" in the audit.
  const now = deps.now();
  const decision = decideRefund(order, { amountCents: row.amountCents, currency: row.currency }, deps.policy, now);
  const decided = await recordStep(deps.db, {
    id: row.id,
    expectedStatus: 'in_progress',
    change: rowAfterDecision(decision),
    audit: {
      eventType: 'decision',
      outcome: null,
      detail: decisionDetail(order, calendarDateIn(now, deps.policy.timeZone)),
    },
  });
  if (decision.decision !== 'AUTO_APPROVE') {
    return answerFromRow(decided, false);
  }

  // Only reached after the decision step was committed.
  const result = await deps.adapter.createRefund({
    orderId,
    amountCents: decided.amountCents,
    requestId: decided.id,
  });
  const outcome = executionOutcome(result);
  if (result.outcome === 'unknown') {
    console.error(`${LOG} the store did not confirm the refund for request ${decided.id} (order ${orderId}). ` +
      'It is never retried: reconciliation must check the store.');
  }
  if (result.outcome === 'created' && result.amountCents !== decided.amountCents) {
    console.error(`${LOG} WARNING: the store recorded ${result.amountCents} cents for request ${decided.id}, ` +
      `${decided.amountCents} cents were requested.`);
  }
  try {
    const finished = await recordStep(deps.db, {
      id: decided.id,
      expectedStatus: 'in_progress',
      change: rowAfterExecution(decision, result),
      audit: { eventType: 'execution', outcome, detail: executionDetail(result) },
    });
    return answerFromRow(finished, false);
  } catch (error) {
    const refund = result.outcome === 'created' ? `, store refund ${result.storeRefundId}` : '';
    console.error(`${LOG} CRITICAL: the store answered "${outcome}"${refund} for request ${decided.id} ` +
      `(order ${orderId}), but saving it failed. The order stays locked until a person checks it.`);
    throw error;
  }
}

/** The audit detail of a decision: the order as the policy saw it (no customer data) and the day used. */
function decisionDetail(order: OrderSnapshot, today: string): Record<string, unknown> {
  // Field by field on purpose: a new snapshot field must not reach the audit log unnoticed.
  return {
    today,
    order: {
      orderId: order.orderId,
      status: order.status,
      paid: order.paid,
      currency: order.currency,
      totalCents: order.totalCents,
      refundedCents: order.refundedCents,
      deliveredOn: order.deliveredOn,
    },
  };
}

/** audit_log.outcome of an execution: "created", "rejected:<CODE>" or "unknown". */
function executionOutcome(result: RefundResult): string {
  return result.outcome === 'rejected' ? `rejected:${result.reason}` : result.outcome;
}

/** What the store recorded, kept as evidence. */
function executionDetail(result: RefundResult): Record<string, unknown> {
  return result.outcome === 'created' ? { storeAmountCents: result.amountCents } : {};
}