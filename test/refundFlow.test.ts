import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { runRefund, type RefundFlowDeps } from '../src/actions/refundFlow.js';
import { KEY_REUSED_ANSWER, REFUND_PENDING_ANSWER } from '../src/actions/refundAnswer.js';
import { refundRequestHash, type RefundInput } from '../src/actions/refundInput.js';
import type { RequestsDb } from '../src/db/refundRequests.js';
import { loadPolicy } from '../src/policy/policyFile.js';
import type { OrderSnapshot, RefundRequest, RefundResult, StoreAdapter } from '../src/store/adapter.js';
import { WooError, type WooErrorKind } from '../src/woo/errors.js';

// No database and no store here: a fake pool and a fake adapter write into one shared timeline,
// so the tests can prove the ORDER of the steps. The SQL itself is tested against a real Postgres
// in test/refundFlow.db.test.ts (integration, only with GATEWAY_DB_TEST=1).

type Answer = { rows?: Record<string, unknown>[]; rowCount?: number } | Error;
type Query = { via: 'pool' | 'client'; step: string; params: unknown[] };

const POLICY = loadPolicy().refund;
const VERSION = POLICY.policyVersion;
const ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const HASH = 'fd98f7054726b71c9b31fde2955bf322c25a627824bdf337c20d5a30362176af'; // pinned in 4c
const NOW = new Date('2026-11-24T12:00:00Z');

/** Names a statement by what it does, so the timeline reads like the flow. */
function stepOf(sql: string): string {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return sql;
  if (sql.startsWith('insert into gateway.action_requests')) return 'claim';
  if (sql.startsWith('select request_hash')) return 'select';
  if (sql.startsWith('update gateway.action_requests')) return 'update';
  if (sql.startsWith('insert into gateway.audit_log')) return 'audit';
  throw new Error(`unexpected SQL: ${sql}`);
}

function fakeDb(answers: Answer[], timeline: string[]) {
  const queries: Query[] = [];
  const releases: unknown[] = [];
  const query = (via: Query['via']) => async (sql: string, params: unknown[] = []) => {
    const step = stepOf(sql);
    queries.push({ via, step, params });
    timeline.push(`${via}:${step}`);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`fakeDb: no answer left for ${step}`);
    if (answer instanceof Error) throw answer;
    const rows = answer.rows ?? [];
    return { rows, rowCount: answer.rowCount ?? rows.length };
  };
  const db = {
    query: query('pool'),
    connect: async () => ({ query: query('client'), release: (destroy?: unknown) => releases.push(destroy) }),
  } as unknown as RequestsDb;
  return { db, queries, releases };
}

function fakeAdapter(order: OrderSnapshot | Error, refund: RefundResult | Error, timeline: string[]) {
  const refunds: RefundRequest[] = [];
  const adapter: StoreAdapter = {
    platform: 'woocommerce',
    async getOrder(orderId) {
      timeline.push(`store:getOrder ${orderId}`);
      if (order instanceof Error) throw order;
      return order;
    },
    async createRefund(request) {
      timeline.push('store:createRefund');
      refunds.push(request);
      if (refund instanceof Error) throw refund;
      return refund;
    },
    async cancelOrder() {
      throw new Error('cancelOrder must not be called');
    },
    async findRefund() {
      throw new Error('findRefund must not be called');
    },
  };
  return { adapter, refunds };
}

function order(extra: Partial<OrderSnapshot> = {}): OrderSnapshot {
  // Like demo order #20: delivered 11 days ago, $18.00, nothing refunded.
  return {
    orderId: '20',
    status: 'completed',
    paid: true,
    currency: 'USD',
    totalCents: 1800,
    refundedCents: 0,
    deliveredOn: '2026-11-13',
    ...extra,
  };
}

function dbRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    action: 'refund',
    status: 'in_progress',
    decision: null,
    reason_code: null,
    amount_cents: 1800,
    currency: 'USD',
    store_refund_id: null,
    ...extra,
  };
}

const AUTO = { decision: 'AUTO_APPROVE', reason_code: 'WITHIN_AUTO_LIMIT' };

/** The 4 answers of one recordStep transaction: BEGIN, UPDATE ... RETURNING, audit insert, COMMIT. */
function step(row: Record<string, unknown>): Answer[] {
  return [{}, { rows: [row] }, { rowCount: 1 }, {}];
}

const CREATED: RefundResult = { outcome: 'created', storeRefundId: '37', amountCents: 1800 };

function input(extra: Partial<RefundInput> = {}): RefundInput {
  return { order_id: 20, amount: '18.00', currency: 'USD', idempotency_key: 'agent-key-0001', ...extra };
}

function setup(answers: Answer[], storeOrder: OrderSnapshot | Error, refund: RefundResult | Error = CREATED) {
  const timeline: string[] = [];
  const db = fakeDb(answers, timeline);
  const store = fakeAdapter(storeOrder, refund, timeline);
  const now = vi.fn(() => NOW);
  const deps: RefundFlowDeps = { db: db.db, adapter: store.adapter, policy: POLICY, storeId: 'lumio-demo', now };
  return { deps, timeline, now, ...db, ...store };
}

function duplicate(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
    table: 'action_requests',
    schema: 'gateway',
  });
}

const DECISION_DETAIL = JSON.stringify({
  today: '2026-11-24',
  order: {
    orderId: '20',
    status: 'completed',
    paid: true,
    currency: 'USD',
    totalCents: 1800,
    refundedCents: 0,
    deliveredOn: '2026-11-13',
  },
});

let stderr: MockInstance;
beforeEach(() => {
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
});

function logged(): string[] {
  return stderr.mock.calls.map((call) => call.map(String).join(' '));
}

describe('runRefund: AUTO_APPROVE', () => {
  it('claims, reads, decides, commits the decision, then refunds and records the result', async () => {
    const t = setup(
      [
        { rows: [dbRow()] },
        ...step(dbRow({ ...AUTO })),
        ...step(dbRow({ ...AUTO, status: 'succeeded', store_refund_id: '37' })),
      ],
      order(),
    );
    const answer = await runRefund(t.deps, input(), 'stdio');

    expect(t.timeline).toEqual([
      'pool:claim',
      'store:getOrder 20',
      'client:BEGIN',
      'client:update',
      'client:audit',
      'client:COMMIT',
      'store:createRefund',
      'client:BEGIN',
      'client:update',
      'client:audit',
      'client:COMMIT',
    ]);
    expect(answer).toEqual({
      ok: true,
      data: {
        request_id: ID,
        status: 'succeeded',
        decision: 'AUTO_APPROVE',
        reason_code: 'WITHIN_AUTO_LIMIT',
        amount: '18.00',
        currency: 'USD',
        store_refund_id: '37',
        replayed: false,
        next_step: 'The refund is recorded in the store. Do not request it again.',
      },
    });
    expect(t.releases).toEqual([undefined, undefined]);
    expect(logged()).toEqual([]);
  });

  it('claims with the checked values, the pinned hash and the caller transport', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund(t.deps, input({ amount: '18' }), 'http');
    expect(t.queries[0]).toEqual({
      via: 'pool',
      step: 'claim',
      params: ['lumio-demo', '20', 'agent-key-0001', HASH, 1800, 'USD', 'http'],
    });
  });

  it('claims under the store id it was given (also in the hash)', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund({ ...t.deps, storeId: 'other-store' }, input(), 'stdio');
    const hash = refundRequestHash('other-store', { orderId: '20', amountCents: 1800, currency: 'USD' });
    expect(hash).not.toBe(HASH);
    expect(t.queries[0]?.params.slice(0, 4)).toEqual(['other-store', '20', 'agent-key-0001', hash]);
  });

  it('writes the decision with the policy version and the order as the policy saw it', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund(t.deps, input(), 'stdio');
    expect(t.queries[2]?.params).toEqual([ID, 'in_progress', 'in_progress', 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT',
      VERSION, null]);
    expect(t.queries[3]?.params).toEqual([ID, 'decision', 'request_refund', null, null, DECISION_DETAIL]);
  });

  it('sends the refund for the stored amount with the row id as request id', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund(t.deps, input(), 'stdio');
    expect(t.refunds).toEqual([{ orderId: '20', amountCents: 1800, requestId: ID }]);
  });

  it('records the execution with the store refund id and what the store recorded', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund(t.deps, input(), 'stdio');
    expect(t.queries[6]?.params).toEqual([ID, 'in_progress', 'succeeded', 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT',
      VERSION, '37']);
    expect(t.queries[7]?.params).toEqual([ID, 'execution', 'request_refund', 'created', null,
      '{"storeAmountCents":1800}']);
  });

  it('runs every step query on the transaction client, never on the pool', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    await runRefund(t.deps, input(), 'stdio');
    expect(t.queries.slice(1).every((q) => q.via === 'client')).toBe(true);
  });

  it('reads the clock exactly once and counts "today" in the policy time zone', async () => {
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow())], order());
    t.now.mockReturnValue(new Date('2026-11-24T22:30:00Z')); // already Nov 25 in Istanbul
    const deps = { ...t.deps, policy: { ...POLICY, timeZone: 'Europe/Istanbul' } };
    await runRefund(deps, input(), 'stdio');
    expect(t.now).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(t.queries[3]?.params[5]))).toMatchObject({ today: '2026-11-25' });
  });

  it('records a store refusal as failed with the store code and an execution outcome', async () => {
    const t = setup(
      [{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow({ status: 'failed', decision: 'AUTO_APPROVE',
        reason_code: 'STORE_REFUSED' }))],
      order(),
      { outcome: 'rejected', reason: 'STORE_REFUSED' },
    );
    const answer = await runRefund(t.deps, input(), 'stdio');
    expect(t.queries[6]?.params).toEqual([ID, 'in_progress', 'failed', 'AUTO_APPROVE', 'STORE_REFUSED', VERSION,
      null]);
    expect(t.queries[7]?.params).toEqual([ID, 'execution', 'request_refund', 'rejected:STORE_REFUSED', null, '{}']);
    expect(answer).toMatchObject({ ok: true, data: { status: 'failed', reason_code: 'STORE_REFUSED' } });
    expect(logged()).toEqual([]);
  });

  it('records an unconfirmed refund as unknown and tells the operator, without retrying', async () => {
    const t = setup(
      [{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow({ ...AUTO, status: 'unknown' }))],
      order(),
      { outcome: 'unknown' },
    );
    const answer = await runRefund(t.deps, input(), 'stdio');
    expect(t.refunds).toHaveLength(1);
    expect(t.queries[6]?.params.slice(2, 5)).toEqual(['unknown', 'AUTO_APPROVE', 'WITHIN_AUTO_LIMIT']);
    expect(t.queries[7]?.params).toEqual([ID, 'execution', 'request_refund', 'unknown', null, '{}']);
    expect(answer).toMatchObject({ ok: true, data: { status: 'unknown' } });
    expect(logged()).toEqual([
      `[request_refund] the store did not confirm the refund for request ${ID} (order 20). ` +
        'It is never retried: reconciliation must check the store.',
    ]);
  });

  it('warns when the store recorded another amount than requested', async () => {
    const t = setup(
      [{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), ...step(dbRow({ ...AUTO, status: 'succeeded' }))],
      order(),
      { outcome: 'created', storeRefundId: '37', amountCents: 1700 },
    );
    await runRefund(t.deps, input(), 'stdio');
    expect(t.queries[7]?.params[5]).toBe('{"storeAmountCents":1700}');
    expect(logged()).toEqual([
      `[request_refund] WARNING: the store recorded 1700 cents for request ${ID}, 1800 cents were requested.`,
    ]);
  });
});

describe('runRefund: decisions without a store refund', () => {
  it('NEEDS_APPROVAL: saves pending_approval and never calls the store refund', async () => {
    const big = order({ orderId: '22', totalCents: 8900, deliveredOn: '2026-11-15' });
    const t = setup(
      [{ rows: [dbRow({ amount_cents: 8900 })] }, ...step(dbRow({ amount_cents: 8900, status: 'pending_approval',
        decision: 'NEEDS_APPROVAL', reason_code: 'ABOVE_AUTO_LIMIT' }))],
      big,
    );
    const answer = await runRefund(t.deps, input({ order_id: 22, amount: '89.00' }), 'stdio');
    expect(t.queries[2]?.params).toEqual([ID, 'in_progress', 'pending_approval', 'NEEDS_APPROVAL',
      'ABOVE_AUTO_LIMIT', VERSION, null]);
    expect(t.refunds).toEqual([]);
    expect(t.timeline.at(-1)).toBe('client:COMMIT');
    expect(answer).toMatchObject({
      ok: true,
      data: { status: 'pending_approval', amount: '89.00', replayed: false },
    });
  });

  it('REJECT: saves rejected with the policy reason and never calls the store refund', async () => {
    const notDelivered = order({ orderId: '21', status: 'processing', deliveredOn: null });
    const t = setup(
      [{ rows: [dbRow()] }, ...step(dbRow({ status: 'rejected', decision: 'REJECT', reason_code: 'NOT_DELIVERED' }))],
      notDelivered,
    );
    const answer = await runRefund(t.deps, input({ order_id: 21 }), 'stdio');
    expect(t.queries[2]?.params).toEqual([ID, 'in_progress', 'rejected', 'REJECT', 'NOT_DELIVERED', VERSION, null]);
    expect(t.refunds).toEqual([]);
    expect(answer).toMatchObject({
      ok: true,
      data: { status: 'rejected', reason_code: 'NOT_DELIVERED', replayed: false },
    });
  });

  it('gives the policy the currency from the stored row', async () => {
    const t = setup(
      [{ rows: [dbRow({ currency: 'EUR' })] }, ...step(dbRow({ currency: 'EUR', status: 'rejected',
        decision: 'REJECT', reason_code: 'CURRENCY_MISMATCH' }))],
      order(),
    );
    await runRefund(t.deps, input({ currency: 'EUR' }), 'stdio');
    expect(t.queries[2]?.params.slice(2, 5)).toEqual(['rejected', 'REJECT', 'CURRENCY_MISMATCH']);
    expect(t.refunds).toEqual([]);
  });
});

describe('runRefund: the order cannot be read', () => {
  it('NOT_FOUND: saves rejected / ORDER_NOT_FOUND with a read detail, without a log line', async () => {
    const t = setup(
      [{ rows: [dbRow()] }, ...step(dbRow({ status: 'rejected', decision: 'REJECT',
        reason_code: 'ORDER_NOT_FOUND' }))],
      new WooError('NOT_FOUND', 'Resource not found', 404),
    );
    const answer = await runRefund(t.deps, input(), 'stdio');
    expect(t.queries[2]?.params).toEqual([ID, 'in_progress', 'rejected', 'REJECT', 'ORDER_NOT_FOUND', null, null]);
    expect(t.queries[3]?.params).toEqual([ID, 'decision', 'request_refund', null, null,
      '{"step":"read","error":"NOT_FOUND"}']);
    expect(t.now).not.toHaveBeenCalled();
    expect(t.refunds).toEqual([]);
    expect(answer).toMatchObject({
      ok: true,
      data: { status: 'rejected', reason_code: 'ORDER_NOT_FOUND', replayed: false },
    });
    expect(logged()).toEqual([]);
  });

  it.each<WooErrorKind>(['UNAVAILABLE', 'AUTH', 'BAD_RESPONSE'])(
    '%s: saves failed / STORE_UNAVAILABLE, logs the kind and answers STORE_UNAVAILABLE',
    async (kind) => {
      const t = setup(
        [{ rows: [dbRow()] }, ...step(dbRow({ status: 'failed', reason_code: 'STORE_UNAVAILABLE' }))],
        new WooError(kind, 'store said no'),
      );
      const answer = await runRefund(t.deps, input(), 'stdio');
      expect(t.queries[2]?.params).toEqual([ID, 'in_progress', 'failed', null, 'STORE_UNAVAILABLE', null, null]);
      expect(t.queries[3]?.params[5]).toBe(`{"step":"read","error":"${kind}"}`);
      expect(t.refunds).toEqual([]);
      expect(answer).toMatchObject({ ok: false, code: 'STORE_UNAVAILABLE' });
      expect(logged()).toEqual([`[woo] ${kind}: store said no`]);
    },
  );

  it('an error that is not a WooError is thrown and nothing else is written', async () => {
    const bug = new Error('bug in the adapter');
    const t = setup([{ rows: [dbRow()] }], bug);
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toBe(bug);
    expect(t.timeline).toEqual(['pool:claim', 'store:getOrder 20']);
  });
});

describe('runRefund: duplicates (decided from the stored row)', () => {
  it('same key, same values: audits the replay with the caller and answers from the stored row', async () => {
    const stored = dbRow({ request_hash: HASH, ...AUTO, status: 'succeeded', store_refund_id: '37' });
    const t = setup([duplicate('action_requests_idempotency_key'), { rows: [stored] }, { rowCount: 1 }], order());
    const answer = await runRefund(t.deps, input(), 'http');
    expect(t.timeline).toEqual(['pool:claim', 'pool:select', 'pool:audit']);
    expect(t.queries[2]?.params).toEqual([ID, 'replay', 'request_refund', 'succeeded', 'http', '{}']);
    expect(answer).toMatchObject({ ok: true, data: { status: 'succeeded', store_refund_id: '37', replayed: true } });
  });

  it('a failing replay audit is thrown (never skipped silently)', async () => {
    const stored = dbRow({ request_hash: HASH, status: 'rejected', decision: 'REJECT', reason_code: 'NOT_PAID' });
    const auditError = new Error('audit insert failed');
    const t = setup([duplicate('action_requests_idempotency_key'), { rows: [stored] }, auditError], order());
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toBe(auditError);
  });

  it('same key, other values: IDEMPOTENCY_KEY_REUSED with one log line without the key or the amount', async () => {
    const stored = dbRow({ request_hash: 'a'.repeat(64) });
    const t = setup([duplicate('action_requests_idempotency_key'), { rows: [stored] }], order());
    const answer = await runRefund(t.deps, input(), 'stdio');
    expect(answer).toBe(KEY_REUSED_ANSWER);
    expect(t.timeline).toEqual(['pool:claim', 'pool:select']);
    expect(logged()).toEqual(['[request_refund] IDEMPOTENCY_KEY_REUSED order 20 (actor stdio)']);
  });

  it('another open request for the order: REFUND_PENDING, nothing written, no log line', async () => {
    const t = setup([duplicate('action_requests_one_open_per_order'), { rows: [] }], order());
    const answer = await runRefund(t.deps, input(), 'stdio');
    expect(answer).toBe(REFUND_PENDING_ANSWER);
    expect(t.timeline).toEqual(['pool:claim', 'pool:select']);
    expect(logged()).toEqual([]);
  });
});

describe('runRefund: failures after the claim', () => {
  it('a failing decision step is thrown and the store refund is never sent', async () => {
    const t = setup([{ rows: [dbRow()] }, {}, { rows: [], rowCount: 0 }, {}], order());
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toThrow('recordStep');
    expect(t.refunds).toEqual([]);
    expect(t.timeline).not.toContain('store:createRefund');
  });

  it('a failing execution step after a created refund is thrown with a CRITICAL log line', async () => {
    const saveError = new Error('connection lost');
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), {}, saveError, {}], order());
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toBe(saveError);
    expect(t.refunds).toHaveLength(1);
    expect(logged()).toEqual([
      `[request_refund] CRITICAL: the store answered "created", store refund 37 for request ${ID} (order 20), ` +
        'but saving it failed. The order stays locked until a person checks it.',
    ]);
  });

  it('a failing execution step after an unconfirmed refund names the outcome without a refund id', async () => {
    const saveError = new Error('connection lost');
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO })), {}, saveError, {}], order(),
      { outcome: 'unknown' });
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toBe(saveError);
    expect(logged()[1]).toBe(
      `[request_refund] CRITICAL: the store answered "unknown" for request ${ID} (order 20), ` +
        'but saving it failed. The order stays locked until a person checks it.',
    );
  });

  it('a bug thrown by createRefund is passed on after the decision was saved', async () => {
    const bug = new Error('bad request id');
    const t = setup([{ rows: [dbRow()] }, ...step(dbRow({ ...AUTO }))], order(), bug);
    await expect(runRefund(t.deps, input(), 'stdio')).rejects.toBe(bug);
    expect(t.timeline.at(-1)).toBe('store:createRefund');
  });

  it('input that skipped the schema is a bug: thrown before anything is written', async () => {
    const t = setup([], order());
    await expect(runRefund(t.deps, input({ amount: 'abc' }), 'stdio')).rejects.toThrow('readRefundInput');
    expect(t.timeline).toEqual([]);
  });
});