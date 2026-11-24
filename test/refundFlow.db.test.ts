// Integration test of the whole request_refund flow: the real database layer against a real, LOCAL
// Postgres (as the app role from .env) and a fake store in memory. Skipped unless GATEWAY_DB_TEST=1.
// Never against Supabase: test rows can never be deleted. Each run uses its own random store_id.
// The race tests prove that the Postgres guards, not the store, stop a double refund.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runRefund, type RefundFlowDeps } from '../src/actions/refundFlow.js';
import type { RefundAnswer } from '../src/actions/refundAnswer.js';
import type { RefundInput } from '../src/actions/refundInput.js';
import { createPool, resolveDbSettings } from '../src/db/dbSettings.js';
import type { RequestsDb } from '../src/db/refundRequests.js';
import { loadPolicy } from '../src/policy/policyFile.js';
import type { OrderSnapshot, RefundResult, StoreAdapter } from '../src/store/adapter.js';
import { WooError, type WooErrorKind } from '../src/woo/errors.js';
import { formatCents } from '../src/woo/money.js';

const ENABLED = process.env.GATEWAY_DB_TEST === '1';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const POLICY = loadPolicy().refund;
const NOW = new Date('2026-11-24T12:00:00Z');

/** A store in memory that behaves like WooCommerce for the flow: refunds change the order. */
class FakeStore implements StoreAdapter {
  readonly platform = 'woocommerce';
  readonly orders = new Map<string, OrderSnapshot>();
  readonly readErrors = new Map<string, WooErrorKind>();
  readonly answers = new Map<string, RefundResult>(); // a fixed store answer for an order
  refundCalls = 0;
  private nextRefundId = 100;

  constructor(private readonly delayMs = 0) {}

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise((done) => setTimeout(done, this.delayMs));
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    await this.pause();
    const kind = this.readErrors.get(orderId);
    if (kind !== undefined) throw new WooError(kind, 'fake store');
    const order = this.orders.get(orderId);
    if (order === undefined) throw new WooError('NOT_FOUND', 'Resource not found');
    return { ...order };
  }

  async createRefund({ orderId, amountCents }: { orderId: string; amountCents: number }): Promise<RefundResult> {
    this.refundCalls += 1;
    await this.pause();
    const fixed = this.answers.get(orderId);
    if (fixed !== undefined) return fixed;
    // Like WooCommerce: no lock, no policy. It records whatever it is asked to.
    const order = this.orders.get(orderId);
    if (order === undefined) return { outcome: 'rejected', reason: 'ORDER_NOT_FOUND' };
    const refundedCents = order.refundedCents + amountCents;
    const status = refundedCents >= order.totalCents ? 'refunded' : order.status;
    this.orders.set(orderId, { ...order, refundedCents, status });
    this.nextRefundId += 1;
    return { outcome: 'created', storeRefundId: String(this.nextRefundId), amountCents };
  }

  async cancelOrder(): Promise<never> {
    throw new Error('cancelOrder must not be called');
  }

  async findRefund(): Promise<never> {
    throw new Error('findRefund must not be called');
  }
}

function delivered(orderId: string, totalCents: number, deliveredOn: string | null, extra = {}): OrderSnapshot {
  return {
    orderId,
    status: deliveredOn === null ? 'processing' : 'completed',
    paid: true,
    currency: 'USD',
    totalCents,
    refundedCents: 0,
    deliveredOn,
    ...extra,
  };
}

function input(orderId: number, amount: string, key: string): RefundInput {
  return { order_id: orderId, amount, currency: 'USD', idempotency_key: key };
}

function summary(answer: RefundAnswer): string {
  return answer.ok ? `${answer.data.status}/${answer.data.reason_code}` : answer.code;
}

describe.skipIf(!ENABLED)('request_refund flow on a real Postgres (GATEWAY_DB_TEST=1)', () => {
  let pool: Pool;
  const storeId = `iflow-${randomBytes(4).toString('hex')}`;
  let keyCounter = 0;

  function newKey(): string {
    keyCounter += 1;
    return `iflow-key-${keyCounter}`;
  }

  function depsFor(store: FakeStore, db: RequestsDb = pool): RefundFlowDeps {
    return { db, adapter: store, policy: POLICY, storeId, now: () => NOW };
  }

  async function rowsFor(orderId: string) {
    const result = await pool.query(
      `select id, status, decision, reason_code, policy_version, store_refund_id, actor
       from gateway.action_requests where store_id = $1 and order_id = $2 order by created_at, id`,
      [storeId, orderId],
    );
    return result.rows;
  }

  async function auditFor(requestId: string) {
    const result = await pool.query(
      `select event_type, decision, reason_code, policy_version, outcome, store_refund_id, actor, detail
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

  // The 7 demo orders as they were on Nov 24 (section 5 of the handoff), each asked for a full refund.
  const REFUNDED = { status: 'refunded', paid: false, refundedCents: 7500 } as const;
  it.each([
    { order: delivered('20', 1800, '2026-11-13'), expected: 'succeeded/WITHIN_AUTO_LIMIT' },
    { order: delivered('21', 12900, null), expected: 'rejected/NOT_DELIVERED' },
    { order: delivered('22', 8900, '2026-11-15'), expected: 'pending_approval/ABOVE_AUTO_LIMIT' },
    { order: delivered('23', 6400, '2026-10-05'), expected: 'rejected/OUTSIDE_RETURN_WINDOW' },
    { order: delivered('24', 7500, '2026-11-10', REFUNDED), expected: 'rejected/ALREADY_REFUNDED' },
    { order: delivered('25', 3500, '2026-11-17'), expected: 'pending_approval/ABOVE_AUTO_LIMIT' },
    { order: delivered('26', 2200, null), expected: 'rejected/NOT_DELIVERED' },
  ])('demo order #$order.orderId -> $expected', async ({ order, expected }) => {
    const store = new FakeStore();
    store.orders.set(order.orderId, order);
    const amount = formatCents(order.totalCents);
    const answer = await runRefund(depsFor(store), input(Number(order.orderId), amount, newKey()), 'stdio');
    expect(summary(answer)).toBe(expected);
    expect(store.refundCalls).toBe(expected.startsWith('succeeded') ? 1 : 0);
    const rows = await rowsFor(order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: expected.split('/')[0], policy_version: POLICY.policyVersion });
  });

  it('an automatic refund leaves a decision and an execution entry with what the store recorded', async () => {
    const store = new FakeStore();
    store.orders.set('120', delivered('120', 1800, '2026-11-13'));
    const answer = await runRefund(depsFor(store), input(120, '18.00', newKey()), 'stdio');
    expect(answer).toMatchObject({ ok: true, data: { status: 'succeeded', store_refund_id: '101' } });
    const [row] = await rowsFor('120');
    expect(row).toMatchObject({ status: 'succeeded', store_refund_id: '101', actor: 'stdio' });
    expect(await auditFor(row.id)).toEqual([
      {
        event_type: 'decision',
        decision: 'AUTO_APPROVE',
        reason_code: 'WITHIN_AUTO_LIMIT',
        policy_version: POLICY.policyVersion,
        outcome: null,
        store_refund_id: null,
        actor: 'stdio',
        detail: {
          today: '2026-11-24',
          order: {
            orderId: '120',
            status: 'completed',
            paid: true,
            currency: 'USD',
            totalCents: 1800,
            refundedCents: 0,
            deliveredOn: '2026-11-13',
          },
        },
      },
      {
        event_type: 'execution',
        decision: 'AUTO_APPROVE',
        reason_code: 'WITHIN_AUTO_LIMIT',
        policy_version: POLICY.policyVersion,
        outcome: 'created',
        store_refund_id: '101',
        actor: 'stdio',
        detail: { storeAmountCents: 1800 },
      },
    ]);
  });

  it('same key + same values: the stored answer again, a replay entry, no second refund', async () => {
    const store = new FakeStore();
    store.orders.set('121', delivered('121', 1800, '2026-11-13'));
    const key = newKey();
    const first = await runRefund(depsFor(store), input(121, '18.00', key), 'stdio');
    const again = await runRefund(depsFor(store), input(121, '18', key), 'http');
    expect(store.refundCalls).toBe(1);
    if (!first.ok || !again.ok) throw new Error('expected two ok answers');
    expect(again.data).toEqual({ ...first.data, replayed: true });
    const audit = await auditFor(first.data.request_id);
    expect(audit.map((entry) => `${entry.event_type}:${entry.outcome}:${entry.actor}`)).toEqual([
      'decision:null:stdio',
      'execution:created:stdio',
      'replay:succeeded:http',
    ]);
  });

  it('same key + other values: IDEMPOTENCY_KEY_REUSED and nothing new is saved', async () => {
    const store = new FakeStore();
    store.orders.set('122', delivered('122', 8900, '2026-11-15'));
    const key = newKey();
    await runRefund(depsFor(store), input(122, '89.00', key), 'stdio');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reused = await runRefund(depsFor(store), input(122, '10.00', key), 'stdio');
      expect(summary(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    } finally {
      stderr.mockRestore();
    }
    expect(await rowsFor('122')).toHaveLength(1);
  });

  it('a request waiting for approval locks the order: a new key gets REFUND_PENDING', async () => {
    const store = new FakeStore();
    store.orders.set('123', delivered('123', 8900, '2026-11-15'));
    const first = await runRefund(depsFor(store), input(123, '89.00', newKey()), 'stdio');
    const second = await runRefund(depsFor(store), input(123, '10.00', newKey()), 'stdio');
    expect([summary(first), summary(second)]).toEqual(['pending_approval/ABOVE_AUTO_LIMIT', 'REFUND_PENDING']);
    expect(await rowsFor('123')).toHaveLength(1);
  });

  it('a missing order is rejected and leaves the order free', async () => {
    const store = new FakeStore();
    const answer = await runRefund(depsFor(store), input(124, '18.00', newKey()), 'stdio');
    expect(summary(answer)).toBe('rejected/ORDER_NOT_FOUND');
    const [row] = await rowsFor('124');
    expect(await auditFor(row.id)).toMatchObject([
      { event_type: 'decision', detail: { step: 'read', error: 'NOT_FOUND' } },
    ]);
    store.orders.set('124', delivered('124', 1800, '2026-11-13'));
    expect(summary(await runRefund(depsFor(store), input(124, '18.00', newKey()), 'stdio'))).toBe(
      'succeeded/WITHIN_AUTO_LIMIT',
    );
  });

  it('a store that does not answer the read: STORE_UNAVAILABLE, row failed, order free again', async () => {
    const store = new FakeStore();
    store.orders.set('125', delivered('125', 1800, '2026-11-13'));
    store.readErrors.set('125', 'UNAVAILABLE');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answer = await runRefund(depsFor(store), input(125, '18.00', newKey()), 'stdio');
      expect(summary(answer)).toBe('STORE_UNAVAILABLE');
    } finally {
      stderr.mockRestore();
    }
    expect(await rowsFor('125')).toMatchObject([
      { status: 'failed', decision: null, reason_code: 'STORE_UNAVAILABLE' },
    ]);
    store.readErrors.delete('125');
    expect(summary(await runRefund(depsFor(store), input(125, '18.00', newKey()), 'stdio'))).toBe(
      'succeeded/WITHIN_AUTO_LIMIT',
    );
  });

  it('a store refusal: failed with the store code, the order is free again', async () => {
    const store = new FakeStore();
    store.orders.set('126', delivered('126', 1800, '2026-11-13'));
    store.answers.set('126', { outcome: 'rejected', reason: 'STORE_REFUSED' });
    const answer = await runRefund(depsFor(store), input(126, '18.00', newKey()), 'stdio');
    expect(summary(answer)).toBe('failed/STORE_REFUSED');
    const [row] = await rowsFor('126');
    expect((await auditFor(row.id)).map((entry) => entry.outcome)).toEqual([null, 'rejected:STORE_REFUSED']);
    store.answers.delete('126');
    expect(summary(await runRefund(depsFor(store), input(126, '18.00', newKey()), 'stdio'))).toBe(
      'succeeded/WITHIN_AUTO_LIMIT',
    );
  });

  it('an unconfirmed refund stays unknown and keeps the order locked', async () => {
    const store = new FakeStore();
    store.orders.set('127', delivered('127', 1800, '2026-11-13'));
    store.answers.set('127', { outcome: 'unknown' });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answer = await runRefund(depsFor(store), input(127, '18.00', newKey()), 'stdio');
      expect(summary(answer)).toBe('unknown/WITHIN_AUTO_LIMIT');
    } finally {
      stderr.mockRestore();
    }
    expect(summary(await runRefund(depsFor(store), input(127, '18.00', newKey()), 'stdio'))).toBe('REFUND_PENDING');
    expect(store.refundCalls).toBe(1);
  });

  it('the database fails after the store refunded: row stays in_progress, order stays locked', async () => {
    const store = new FakeStore();
    store.orders.set('128', delivered('128', 1800, '2026-11-13'));
    let connects = 0;
    const failingDb: RequestsDb = {
      query: pool.query.bind(pool) as RequestsDb['query'],
      connect: (async () => {
        connects += 1;
        if (connects === 2) throw new Error('database went away');
        return pool.connect();
      }) as RequestsDb['connect'],
    };
    const key = newKey();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runRefund(depsFor(store, failingDb), input(128, '18.00', key), 'stdio')).rejects.toThrow(
        'database went away',
      );
      expect(stderr.mock.calls.map(String).join('\n')).toContain('CRITICAL');
    } finally {
      stderr.mockRestore();
    }
    expect(store.refundCalls).toBe(1);
    expect(await rowsFor('128')).toMatchObject([{ status: 'in_progress', decision: 'AUTO_APPROVE' }]);
    // Same key: replay of the interrupted request. New key: locked. Never a second refund.
    expect(summary(await runRefund(depsFor(store), input(128, '18.00', key), 'stdio'))).toBe(
      'in_progress/WITHIN_AUTO_LIMIT',
    );
    expect(summary(await runRefund(depsFor(store), input(128, '18.00', newKey()), 'stdio'))).toBe('REFUND_PENDING');
    expect(store.refundCalls).toBe(1);
  });

  it('race: 10 requests with different keys for one order at once -> exactly one refund', async () => {
    const store = new FakeStore(30); // slow store: widens the window for a double refund
    store.orders.set('130', delivered('130', 1800, '2026-11-13'));
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => runRefund(depsFor(store), input(130, '18.00', newKey()), 'stdio')),
    );
    const results = answers.map(summary);
    expect(store.refundCalls).toBe(1);
    expect(results.filter((result) => result === 'succeeded/WITHIN_AUTO_LIMIT')).toHaveLength(1);
    // Everything else was stopped by the open-request lock or, after it, by the policy.
    expect(results.every((result) => ['succeeded/WITHIN_AUTO_LIMIT', 'REFUND_PENDING',
      'rejected/ALREADY_REFUNDED'].includes(result))).toBe(true);
    const rows = await rowsFor('130');
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(1);
    expect(rows).toHaveLength(results.filter((result) => result !== 'REFUND_PENDING').length);
  });

  it('control: the same fake store without the gateway refunds 10 times (no lock, like WooCommerce)', async () => {
    const store = new FakeStore(30);
    store.orders.set('132', delivered('132', 1800, '2026-11-13'));
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const order = await store.getOrder('132');
        if (order.refundedCents === 0) await store.createRefund({ orderId: '132', amountCents: 1800 });
      }),
    );
    expect(store.refundCalls).toBe(10);
  });

  it('race: the same request 10 times at once -> one claim, one refund, nine replays', async () => {
    const store = new FakeStore(30);
    store.orders.set('131', delivered('131', 1800, '2026-11-13'));
    const key = newKey();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => runRefund(depsFor(store), input(131, '18.00', key), 'stdio')),
    );
    expect(store.refundCalls).toBe(1);
    const firstCalls = answers.filter((answer) => answer.ok && !answer.data.replayed);
    expect(firstCalls.map(summary)).toEqual(['succeeded/WITHIN_AUTO_LIMIT']);
    const ids = new Set(answers.map((answer) => (answer.ok ? answer.data.request_id : answer.code)));
    expect(ids.size).toBe(1);
    const [row] = await rowsFor('131');
    const audit = await auditFor(row.id);
    expect(audit.filter((entry) => entry.event_type === 'replay')).toHaveLength(9);
  });

  it('leaves no connection checked out', async () => {
    expect(pool.totalCount).toBe(pool.idleCount);
    expect(pool.waitingCount).toBe(0);
  });
});