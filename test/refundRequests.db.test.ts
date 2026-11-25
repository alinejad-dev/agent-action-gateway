// Integration test against a real, LOCAL Postgres with migrations/001_init.sql applied,
// connected as the app role from .env. Skipped unless GATEWAY_DB_TEST=1 (CI has no database yet: P4-1).
// Never against Supabase: the app role cannot delete rows and the audit log is append-only,
// so test rows would stay forever. Every run uses its own random store_id, so runs never collide.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refundRequestHash } from '../src/actions/refundInput.js';
import { rowAfterDecision, rowAfterExecution, rowAfterReadError } from '../src/actions/refundAnswer.js';
import { createPool, resolveDbSettings } from '../src/db/dbSettings.js';
import {
  CANCEL_PENDING_ACTOR,
  cancelPendingRefund,
  claimRefund,
  listPendingRefunds,
  readByKey,
  recordReplay,
  recordStep,
  type RefundClaim,
  type StepAudit,
} from '../src/db/refundRequests.js';

const ENABLED = process.env.GATEWAY_DB_TEST === '1';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const VERSION = '2026-11-24.2+2bbc3f6d69fc';
const AUTO = { decision: 'AUTO_APPROVE', reasonCode: 'WITHIN_AUTO_LIMIT', policyVersion: VERSION } as const;
const NEEDS = { decision: 'NEEDS_APPROVAL', reasonCode: 'ABOVE_AUTO_LIMIT', policyVersion: VERSION } as const;
const REJECT = { decision: 'REJECT', reasonCode: 'NOT_PAID', policyVersion: VERSION } as const;
const DETAIL = { today: '2026-11-24', order: { status: 'completed', paid: true, totalCents: 1800 } };
const DECISION_AUDIT: StepAudit = { eventType: 'decision', outcome: null, detail: DETAIL };

describe.skipIf(!ENABLED)('refund requests on a real Postgres (GATEWAY_DB_TEST=1)', () => {
  let pool: Pool;
  const storeId = `itest-${randomBytes(4).toString('hex')}`;
  let counter = 0;

  function claimFor(orderId: string, amountCents = 1800, key?: string): RefundClaim {
    counter += 1;
    return {
      storeId,
      orderId,
      amountCents,
      currency: 'USD',
      idempotencyKey: key ?? `itest-key-${counter}`,
      requestHash: refundRequestHash(storeId, { orderId, amountCents, currency: 'USD' }),
      actor: 'stdio',
    };
  }

  async function claimNew(orderId: string, amountCents = 1800) {
    const result = await claimRefund(pool, claimFor(orderId, amountCents));
    if (result.outcome !== 'claimed') {
      throw new Error(`expected claimed, got ${result.outcome}`);
    }
    return result.row;
  }

  async function auditRows(requestId: string) {
    const result = await pool.query(
      `select event_type, tool, store_id, order_id, amount_cents, decision, reason_code, policy_version,
              outcome, store_refund_id, actor, detail
       from gateway.audit_log where request_id = $1 order by id`,
      [requestId],
    );
    return result.rows;
  }

  beforeAll(() => {
    const env = parseEnv(readFileSync(resolve(import.meta.dirname, '../.env'), 'utf8'));
    const resolved = resolveDbSettings(env);
    if (!resolved.ok || resolved.settings === null) {
      throw new Error('GATEWAY_DB_TEST=1 needs complete DB_* settings in .env');
    }
    if (!LOCAL_HOSTS.includes(resolved.settings.host)) {
      throw new Error('GATEWAY_DB_TEST refuses to run against a database that is not on this machine');
    }
    pool = createPool(resolved.settings);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('runs as the app role, not as an admin', async () => {
    const result = await pool.query('select current_user');
    expect(result.rows[0].current_user).toBe('gateway_app');
  });

  it('claims a new request: in_progress, no decision, actor and hash stored', async () => {
    const claim = claimFor('1001');
    const result = await claimRefund(pool, claim);
    expect(result.outcome).toBe('claimed');
    if (result.outcome !== 'claimed') return;
    expect(result.row).toMatchObject({
      status: 'in_progress',
      decision: null,
      reasonCode: null,
      amountCents: 1800,
      currency: 'USD',
      storeRefundId: null,
    });
    const stored = await pool.query(
      'select store_id, order_id, idempotency_key, request_hash, actor from gateway.action_requests where id = $1',
      [result.row.id],
    );
    expect(stored.rows).toEqual([
      {
        store_id: storeId,
        order_id: '1001',
        idempotency_key: claim.idempotencyKey,
        request_hash: claim.requestHash,
        actor: 'stdio',
      },
    ]);
  });

  it('same key + same values -> replay of the same row, nothing new saved', async () => {
    const claim = claimFor('1002');
    const first = await claimRefund(pool, claim);
    const second = await claimRefund(pool, claim);
    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('replay');
    if (first.outcome !== 'claimed' || second.outcome !== 'replay') return;
    expect(second.row).toEqual(first.row);
    const count = await pool.query(
      'select count(*)::int as n from gateway.action_requests where store_id = $1 and order_id = $2',
      [storeId, '1002'],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('same key + other values -> key_reused (other amount, other order)', async () => {
    const claim = claimFor('1003');
    await claimRefund(pool, claim);
    const otherAmount = { ...claimFor('1003', 900, claim.idempotencyKey) };
    expect(await claimRefund(pool, otherAmount)).toEqual({ outcome: 'key_reused' });
    const otherOrder = { ...claimFor('1004', 1800, claim.idempotencyKey) };
    expect(await claimRefund(pool, otherOrder)).toEqual({ outcome: 'key_reused' });
  });

  it('a second key for an order with an open request -> pending, nothing saved', async () => {
    await claimNew('1005');
    expect(await claimRefund(pool, claimFor('1005'))).toEqual({ outcome: 'pending' });
    const count = await pool.query(
      'select count(*)::int as n from gateway.action_requests where store_id = $1 and order_id = $2',
      [storeId, '1005'],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('REJECT: row rejected + one decision audit entry copied from the row; the order is free again', async () => {
    const row = await claimNew('1006');
    const done = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(REJECT),
      audit: DECISION_AUDIT,
    });
    expect(done).toMatchObject({ id: row.id, status: 'rejected', decision: 'REJECT', reasonCode: 'NOT_PAID' });
    expect(await auditRows(row.id)).toEqual([
      {
        event_type: 'decision',
        tool: 'request_refund',
        store_id: storeId,
        order_id: '1006',
        amount_cents: 1800,
        decision: 'REJECT',
        reason_code: 'NOT_PAID',
        policy_version: VERSION,
        outcome: null,
        store_refund_id: null,
        actor: 'stdio',
        detail: DETAIL,
      },
    ]);
    expect((await claimRefund(pool, claimFor('1006'))).outcome).toBe('claimed');
  });

  it('a finished row cannot be changed: throws, and no audit entry is left behind', async () => {
    const row = await claimNew('1007');
    await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(REJECT),
      audit: DECISION_AUDIT,
    });
    // Even with the right expected status, RLS hides the finished row from UPDATE.
    await expect(
      recordStep(pool, {
        id: row.id,
        expectedStatus: 'rejected',
        change: { ...rowAfterDecision(REJECT), reasonCode: 'ALREADY_REFUNDED' },
        audit: DECISION_AUDIT,
      }),
    ).rejects.toThrow('recordStep: expected to update 1 row in status rejected, updated 0');
    expect(await auditRows(row.id)).toHaveLength(1);
    expect((await readByKey(pool, storeId, `itest-key-${counter}`))?.reasonCode).toBe('NOT_PAID');
  });

  it('row change and audit entry are one transaction: a failing audit insert undoes the row change', async () => {
    const row = await claimNew('1020');
    // outcome longer than 64 characters breaks an audit_log CHECK after the UPDATE has run.
    await expect(
      recordStep(pool, {
        id: row.id,
        expectedStatus: 'in_progress',
        change: rowAfterDecision(REJECT),
        audit: { eventType: 'decision', outcome: 'x'.repeat(65), detail: {} },
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('select status from gateway.action_requests where id = $1', [row.id])).rows).toEqual([
      { status: 'in_progress' },
    ]);
    expect(await auditRows(row.id)).toEqual([]);
  });

  it('the same key in another store is a different request', async () => {
    const claim = claimFor('1021');
    expect((await claimRefund(pool, claim)).outcome).toBe('claimed');
    const otherStore = `${storeId}-b`;
    const elsewhere = await claimRefund(pool, {
      ...claim,
      storeId: otherStore,
      requestHash: refundRequestHash(otherStore, { orderId: '1021', amountCents: 1800, currency: 'USD' }),
    });
    expect(elsewhere.outcome).toBe('claimed');
    expect(await readByKey(pool, otherStore, claim.idempotencyKey)).not.toBeNull();
  });

  it('a wrong expected status changes nothing', async () => {
    const row = await claimNew('1008');
    await expect(
      recordStep(pool, {
        id: row.id,
        expectedStatus: 'pending_approval',
        change: rowAfterDecision(REJECT),
        audit: DECISION_AUDIT,
      }),
    ).rejects.toThrow('updated 0');
    expect(await auditRows(row.id)).toEqual([]);
  });

  it('a forbidden transition is refused by the trigger (23514) and rolled back', async () => {
    const row = await claimNew('1009');
    await expect(
      recordStep(pool, {
        id: row.id,
        expectedStatus: 'in_progress',
        change: { status: 'cancelled', decision: null, reasonCode: 'X', policyVersion: null, storeRefundId: null },
        audit: DECISION_AUDIT,
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await auditRows(row.id)).toEqual([]);
    expect((await pool.query('select status from gateway.action_requests where id = $1', [row.id])).rows).toEqual([
      { status: 'in_progress' },
    ]);
  });

  it('AUTO_APPROVE then created: decision keeps in_progress, execution -> succeeded, two audit entries', async () => {
    const row = await claimNew('1010');
    const decided = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(AUTO),
      audit: DECISION_AUDIT,
    });
    expect(decided).toMatchObject({ status: 'in_progress', decision: 'AUTO_APPROVE' });
    expect((await claimRefund(pool, claimFor('1010'))).outcome).toBe('pending'); // still locked
    const done = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterExecution(AUTO, { outcome: 'created', storeRefundId: '37', amountCents: 1800 }),
      audit: { eventType: 'execution', outcome: 'created', detail: {} },
    });
    expect(done).toMatchObject({ status: 'succeeded', reasonCode: 'WITHIN_AUTO_LIMIT', storeRefundId: '37' });
    const audit = await auditRows(row.id);
    expect(audit.map((a) => [a.event_type, a.outcome, a.store_refund_id])).toEqual([
      ['decision', null, null],
      ['execution', 'created', '37'],
    ]);
  });

  it('AUTO_APPROVE then the store refused: failed with the store code', async () => {
    const row = await claimNew('1011');
    await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(AUTO),
      audit: DECISION_AUDIT,
    });
    const done = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterExecution(AUTO, { outcome: 'rejected', reason: 'STORE_REFUSED' }),
      audit: { eventType: 'execution', outcome: 'rejected:STORE_REFUSED', detail: {} },
    });
    expect(done).toMatchObject({ status: 'failed', decision: 'AUTO_APPROVE', reasonCode: 'STORE_REFUSED' });
  });

  it('AUTO_APPROVE then no answer: unknown keeps the order locked', async () => {
    const row = await claimNew('1012');
    await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(AUTO),
      audit: DECISION_AUDIT,
    });
    const done = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterExecution(AUTO, { outcome: 'unknown' }),
      audit: { eventType: 'execution', outcome: 'unknown', detail: {} },
    });
    expect(done.status).toBe('unknown');
    expect(await claimRefund(pool, claimFor('1012'))).toEqual({ outcome: 'pending' });
  });

  it('NEEDS_APPROVAL: pending_approval keeps the order locked', async () => {
    const row = await claimNew('1013', 8900);
    const done = await recordStep(pool, {
      id: row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(NEEDS),
      audit: DECISION_AUDIT,
    });
    expect(done).toMatchObject({ status: 'pending_approval', decision: 'NEEDS_APPROVAL', amountCents: 8900 });
    expect(await claimRefund(pool, claimFor('1013', 8900))).toEqual({ outcome: 'pending' });
  });

  it('read error: ORDER_NOT_FOUND -> rejected; STORE_UNAVAILABLE -> failed with no decision', async () => {
    const missing = await claimNew('1014');
    const rejected = await recordStep(pool, {
      id: missing.id,
      expectedStatus: 'in_progress',
      change: rowAfterReadError('NOT_FOUND'),
      audit: { eventType: 'decision', outcome: null, detail: { step: 'read', error: 'NOT_FOUND' } },
    });
    expect(rejected).toMatchObject({ status: 'rejected', decision: 'REJECT', reasonCode: 'ORDER_NOT_FOUND' });

    const down = await claimNew('1015');
    const failed = await recordStep(pool, {
      id: down.id,
      expectedStatus: 'in_progress',
      change: rowAfterReadError('UNAVAILABLE'),
      audit: { eventType: 'decision', outcome: null, detail: { step: 'read', error: 'UNAVAILABLE' } },
    });
    expect(failed).toMatchObject({ status: 'failed', decision: null, reasonCode: 'STORE_UNAVAILABLE' });
    const audit = await auditRows(down.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: null, reason_code: 'STORE_UNAVAILABLE', policy_version: null });
    expect(audit[0].detail).toEqual({ step: 'read', error: 'UNAVAILABLE' });
  });

  it('replay audit entry: caller as actor, current status as outcome', async () => {
    const claim = claimFor('1016');
    const first = await claimRefund(pool, claim);
    if (first.outcome !== 'claimed') throw new Error('expected claimed');
    await recordStep(pool, {
      id: first.row.id,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(REJECT),
      audit: DECISION_AUDIT,
    });
    const again = await claimRefund(pool, { ...claim, actor: 'http' });
    if (again.outcome !== 'replay') throw new Error('expected replay');
    await recordReplay(pool, again.row, 'http');
    const audit = await auditRows(first.row.id);
    expect(audit.map((a) => [a.event_type, a.outcome, a.actor, a.reason_code])).toEqual([
      ['decision', null, 'stdio', 'NOT_PAID'],
      ['replay', 'rejected', 'http', 'NOT_PAID'],
    ]);
    expect(audit[1].detail).toEqual({});
  });

  it('readByKey: null for an unknown key, the stored row for a known key', async () => {
    expect(await readByKey(pool, storeId, 'never-used-key')).toBeNull();
    const claim = claimFor('1017');
    const result = await claimRefund(pool, claim);
    if (result.outcome !== 'claimed') throw new Error('expected claimed');
    expect(await readByKey(pool, storeId, claim.idempotencyKey)).toEqual(result.row);
  });

  it('race: the same key twice at once -> one claimed, one replay of the same row', async () => {
    const claim = claimFor('1018');
    const results = await Promise.all([claimRefund(pool, claim), claimRefund(pool, claim)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'replay']);
    const ids = results.map((r) => ('row' in r ? r.row.id : null));
    expect(ids[0]).toBe(ids[1]);
  });

  it('race: two keys for one order at once -> one claimed, one pending', async () => {
    const results = await Promise.all([claimRefund(pool, claimFor('1019')), claimRefund(pool, claimFor('1019'))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'pending']);
  });

  async function decide(rowId: string, decision: typeof AUTO | typeof NEEDS | typeof REJECT) {
    return recordStep(pool, {
      id: rowId,
      expectedStatus: 'in_progress',
      change: rowAfterDecision(decision),
      audit: DECISION_AUDIT,
    });
  }

  it('cancel-pending: pending -> cancelled + audit entry; order free again; replay answers cancelled', async () => {
    const claim = claimFor('1030', 8900);
    const first = await claimRefund(pool, claim);
    if (first.outcome !== 'claimed') throw new Error('expected claimed');
    await decide(first.row.id, NEEDS);
    const result = await cancelPendingRefund(pool, { id: first.row.id, storeId });
    expect(result).toEqual({
      outcome: 'cancelled',
      row: {
        ...first.row,
        status: 'cancelled',
        decision: 'NEEDS_APPROVAL',
        reasonCode: 'ABOVE_AUTO_LIMIT',
      },
    });
    const audit = await auditRows(first.row.id);
    const columns = audit.map((a) => [a.event_type, a.outcome, a.actor, a.decision, a.reason_code, a.policy_version]);
    expect(columns).toEqual([
      ['decision', null, 'stdio', 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT', VERSION],
      ['decision', 'cancelled', CANCEL_PENDING_ACTOR, 'NEEDS_APPROVAL', 'ABOVE_AUTO_LIMIT', VERSION],
    ]);
    expect(audit[1].detail).toEqual({ step: 'cancel-pending' });
    const again = await claimRefund(pool, claim);
    expect(again.outcome).toBe('replay');
    if (again.outcome !== 'replay') return;
    expect(again.row.status).toBe('cancelled');
    expect((await claimRefund(pool, claimFor('1030', 8900))).outcome).toBe('claimed');
  });

  it('cancel-pending changes nothing: another store, a second cancel, a request that is not pending', async () => {
    const pending = await claimNew('1031', 8900);
    await decide(pending.id, NEEDS);
    expect(await cancelPendingRefund(pool, { id: pending.id, storeId: `${storeId}-x` })).toEqual({
      outcome: 'not_pending',
    });
    expect((await readByKey(pool, storeId, `itest-key-${counter}`))?.status).toBe('pending_approval');
    expect((await cancelPendingRefund(pool, { id: pending.id, storeId })).outcome).toBe('cancelled');
    expect(await cancelPendingRefund(pool, { id: pending.id, storeId })).toEqual({ outcome: 'not_pending' });
    expect(await auditRows(pending.id)).toHaveLength(2);

    const running = await claimNew('1032');
    expect(await cancelPendingRefund(pool, { id: running.id, storeId })).toEqual({ outcome: 'not_pending' });
    const rejected = await claimNew('1033');
    await decide(rejected.id, REJECT);
    expect(await cancelPendingRefund(pool, { id: rejected.id, storeId })).toEqual({ outcome: 'not_pending' });
    const statuses = await pool.query(
      'select status from gateway.action_requests where id = any($1::uuid[]) order by order_id',
      [[running.id, rejected.id]],
    );
    expect(statuses.rows).toEqual([{ status: 'in_progress' }, { status: 'rejected' }]);
    expect(await auditRows(running.id)).toEqual([]);
    expect(await auditRows(rejected.id)).toHaveLength(1);
  });

  it("listPendingRefunds: only this store's pending refund requests, oldest first", async () => {
    const listStore = `${storeId}-list`;
    async function claimIn(orderId: string, amountCents: number) {
      counter += 1;
      const result = await claimRefund(pool, {
        storeId: listStore,
        orderId,
        amountCents,
        currency: 'USD',
        idempotencyKey: `itest-key-${counter}`,
        requestHash: refundRequestHash(listStore, { orderId, amountCents, currency: 'USD' }),
        actor: 'stdio',
      });
      if (result.outcome !== 'claimed') throw new Error('expected claimed');
      return result.row;
    }
    expect(await listPendingRefunds(pool, listStore)).toEqual([]);
    const a = await claimIn('2001', 8900);
    await decide(a.id, NEEDS);
    const b = await claimIn('2002', 3500);
    await decide(b.id, NEEDS);
    await claimIn('2003', 1800); // in_progress
    const c = await claimIn('2004', 1800);
    await decide(c.id, REJECT);

    const listed = await listPendingRefunds(pool, listStore);
    expect(listed.map((p) => [p.id, p.orderId, p.amountCents, p.currency])).toEqual([
      [a.id, '2001', 8900, 'USD'],
      [b.id, '2002', 3500, 'USD'],
    ]);
    expect(listed.every((p) => p.createdAt instanceof Date)).toBe(true);
    await cancelPendingRefund(pool, { id: a.id, storeId: listStore });
    expect((await listPendingRefunds(pool, listStore)).map((p) => p.orderId)).toEqual(['2002']);
  });

  it('leaves no connection checked out', () => {
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  });
});