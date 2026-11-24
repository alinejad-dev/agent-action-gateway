import { describe, expect, it } from 'vitest';
import {
  answerFromRow,
  KEY_REUSED_ANSWER,
  REFUND_PENDING_ANSWER,
  rowAfterDecision,
  rowAfterExecution,
  rowAfterReadError,
  STORE_UNAVAILABLE_MESSAGE,
  type RequestStatus,
  type RowChange,
  type StoredRefundRequest,
} from '../src/actions/refundAnswer.js';
import type { RefundRejectCode } from '../src/policy/refund.js';
import type { ActionRejection } from '../src/store/adapter.js';

const VERSION = '2026-11-24.2+2bbc3f6d69fc';
const AUTO = { decision: 'AUTO_APPROVE', reasonCode: 'WITHIN_AUTO_LIMIT', policyVersion: VERSION } as const;

// The rules of migrations/001_init.sql that a row change must keep (written out once more in JS),
// starting from a row that is still in_progress.
function keepsDatabaseRules(change: RowChange): void {
  const fromInProgress: RequestStatus[] = [
    'in_progress',
    'rejected',
    'pending_approval',
    'succeeded',
    'failed',
    'unknown',
  ];
  expect(fromInProgress).toContain(change.status);
  expect(change.reasonCode).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
  if (change.status === 'rejected') {
    expect(change.decision).toBe('REJECT');
  }
  if (change.status === 'pending_approval') {
    expect(change.decision).toBe('NEEDS_APPROVAL');
  }
  if (change.status === 'succeeded' || change.status === 'unknown') {
    expect(['AUTO_APPROVE', 'NEEDS_APPROVAL']).toContain(change.decision);
  }
  expect((change.policyVersion ?? '').length).toBeLessThanOrEqual(64);
}

describe('rowAfterReadError (the live re-fetch failed, nothing was sent)', () => {
  it('a missing order is rejected with ORDER_NOT_FOUND', () => {
    const change = rowAfterReadError('NOT_FOUND');
    expect(change).toEqual({
      status: 'rejected',
      decision: 'REJECT',
      reasonCode: 'ORDER_NOT_FOUND',
      policyVersion: null,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });

  it.each(['UNAVAILABLE', 'AUTH', 'BAD_RESPONSE'] as const)('%s fails with STORE_UNAVAILABLE and no decision', (kind) => {
    const change = rowAfterReadError(kind);
    expect(change).toEqual({
      status: 'failed',
      decision: null,
      reasonCode: 'STORE_UNAVAILABLE',
      policyVersion: null,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });
});

describe('rowAfterDecision', () => {
  const rejectCodes: RefundRejectCode[] = [
    'CURRENCY_MISMATCH',
    'INVALID_AMOUNT',
    'ALREADY_REFUNDED',
    'NOT_DELIVERED',
    'STATUS_NOT_ALLOWED',
    'NOT_PAID',
    'OUTSIDE_RETURN_WINDOW',
    'AMOUNT_EXCEEDS_REMAINING',
    'PARTIAL_NOT_ALLOWED',
  ];

  it.each(rejectCodes)('REJECT %s -> rejected, with the policy reason and version', (reasonCode) => {
    const change = rowAfterDecision({ decision: 'REJECT', reasonCode, policyVersion: VERSION });
    expect(change).toEqual({
      status: 'rejected',
      decision: 'REJECT',
      reasonCode,
      policyVersion: VERSION,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });

  it('NEEDS_APPROVAL -> pending_approval', () => {
    const change = rowAfterDecision({
      decision: 'NEEDS_APPROVAL',
      reasonCode: 'ABOVE_AUTO_LIMIT',
      policyVersion: VERSION,
    });
    expect(change).toEqual({
      status: 'pending_approval',
      decision: 'NEEDS_APPROVAL',
      reasonCode: 'ABOVE_AUTO_LIMIT',
      policyVersion: VERSION,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });

  it('AUTO_APPROVE stays in_progress until the store has answered', () => {
    const change = rowAfterDecision(AUTO);
    expect(change).toEqual({
      status: 'in_progress',
      decision: 'AUTO_APPROVE',
      reasonCode: 'WITHIN_AUTO_LIMIT',
      policyVersion: VERSION,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });
});

describe('rowAfterExecution (after AUTO_APPROVE)', () => {
  it('created -> succeeded with the store refund id', () => {
    const change = rowAfterExecution(AUTO, { outcome: 'created', storeRefundId: '41', amountCents: 1800 });
    expect(change).toEqual({
      status: 'succeeded',
      decision: 'AUTO_APPROVE',
      reasonCode: 'WITHIN_AUTO_LIMIT',
      policyVersion: VERSION,
      storeRefundId: '41',
    });
    keepsDatabaseRules(change);
  });

  const rejections: ActionRejection[] = [
    'WRITE_KEY_MISSING',
    'AUTH',
    'ORDER_NOT_FOUND',
    'STORE_REFUSED',
    'INVALID_REQUEST',
  ];

  it.each(rejections)('store refused (%s) -> failed, with the store code as the reason', (reason) => {
    const change = rowAfterExecution(AUTO, { outcome: 'rejected', reason });
    expect(change).toEqual({
      status: 'failed',
      decision: 'AUTO_APPROVE',
      reasonCode: reason,
      policyVersion: VERSION,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });

  it('unknown -> unknown (locked, never retried)', () => {
    const change = rowAfterExecution(AUTO, { outcome: 'unknown' });
    expect(change).toEqual({
      status: 'unknown',
      decision: 'AUTO_APPROVE',
      reasonCode: 'WITHIN_AUTO_LIMIT',
      policyVersion: VERSION,
      storeRefundId: null,
    });
    keepsDatabaseRules(change);
  });
});

function storedRow(change: Partial<StoredRefundRequest>): StoredRefundRequest {
  return {
    id: '7b0f3c52-1d2e-4f6a-9b8c-0d1e2f3a4b5c',
    status: 'succeeded',
    decision: 'AUTO_APPROVE',
    reasonCode: 'WITHIN_AUTO_LIMIT',
    amountCents: 1800,
    currency: 'USD',
    storeRefundId: '41',
    ...change,
  };
}

describe('answerFromRow', () => {
  it('builds the whole answer from the row', () => {
    expect(answerFromRow(storedRow({}), false)).toEqual({
      ok: true,
      data: {
        request_id: '7b0f3c52-1d2e-4f6a-9b8c-0d1e2f3a4b5c',
        status: 'succeeded',
        decision: 'AUTO_APPROVE',
        reason_code: 'WITHIN_AUTO_LIMIT',
        amount: '18.00',
        currency: 'USD',
        store_refund_id: '41',
        replayed: false,
        next_step: 'The refund is recorded in the store. Do not request it again.',
      },
    });
  });

  it('a replay gives the same answer, only marked as replayed', () => {
    const first = answerFromRow(storedRow({}), false);
    const replay = answerFromRow(storedRow({}), true);
    expect(replay).toEqual({ ...first, data: { ...(first.ok ? first.data : {}), replayed: true } });
  });

  it('formats the amount from cents', () => {
    const answer = answerFromRow(storedRow({ amountCents: 5 }), false);
    expect(answer.ok && answer.data.amount).toBe('0.05');
  });

  it.each([
    ['rejected', 'REJECT', 'NOT_DELIVERED', /not allowed.*Do not retry/],
    ['pending_approval', 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT', /person must approve.*Do not retry/],
    ['unknown', 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT', /did not confirm.*Do not retry/],
    ['failed', 'AUTO_APPROVE', 'STORE_REFUSED', /Nothing was refunded.*new idempotency_key/],
    ['in_progress', 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT', /still being processed.*Do not retry/],
    ['cancelled', 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT', /cancelled.*new idempotency_key/],
  ] as const)('%s is an ok answer with a fixed next step', (status, decision, reasonCode, nextStep) => {
    const answer = answerFromRow(storedRow({ status, decision, reasonCode, storeRefundId: null }), false);
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.data).toMatchObject({ status, decision, reason_code: reasonCode, store_refund_id: null });
      expect(answer.data.next_step).toMatch(nextStep);
    }
  });

  it('a failed re-fetch is an error answer that says nothing was sent', () => {
    const row = storedRow({ status: 'failed', decision: null, reasonCode: 'STORE_UNAVAILABLE', storeRefundId: null });
    expect(answerFromRow(row, false)).toEqual({
      ok: false,
      code: 'STORE_UNAVAILABLE',
      message: STORE_UNAVAILABLE_MESSAGE,
    });
    expect(answerFromRow(row, true)).toEqual(answerFromRow(row, false));
    expect(STORE_UNAVAILABLE_MESSAGE).toMatch(/Nothing was sent.*new idempotency_key/);
  });

  it('never says that money was returned', () => {
    const statuses: RequestStatus[] = [
      'in_progress',
      'rejected',
      'pending_approval',
      'succeeded',
      'failed',
      'unknown',
      'cancelled',
    ];
    const texts = statuses.map((status) => {
      const answer = answerFromRow(storedRow({ status }), false);
      return answer.ok ? answer.data.next_step : answer.message;
    });
    for (const text of [...texts, STORE_UNAVAILABLE_MESSAGE]) {
      expect(text).not.toMatch(/money|returned|paid back/i);
    }
  });
});

describe('fixed error answers', () => {
  it('a reused key asks for a new key', () => {
    expect(KEY_REUSED_ANSWER).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(!KEY_REUSED_ANSWER.ok && KEY_REUSED_ANSWER.message).toMatch(/new key/);
  });

  it('an open request for the order says not to retry now', () => {
    expect(REFUND_PENDING_ANSWER).toMatchObject({ ok: false, code: 'REFUND_PENDING' });
    expect(!REFUND_PENDING_ANSWER.ok && REFUND_PENDING_ANSWER.message).toMatch(/Do not retry now/);
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(KEY_REUSED_ANSWER)).toBe(true);
    expect(Object.isFrozen(REFUND_PENDING_ANSWER)).toBe(true);
  });
});