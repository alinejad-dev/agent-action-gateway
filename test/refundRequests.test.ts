import { describe, expect, it } from 'vitest';
import {
  claimRefund,
  classifyUniqueViolation,
  readByKey,
  recordReplay,
  recordStep,
  REFUND_TOOL,
  rowFromDb,
  type RefundClaim,
  type RefundStep,
  type RequestsDb,
} from '../src/db/refundRequests.js';
import type { StoredRefundRequest } from '../src/actions/refundAnswer.js';

// No database here: a fake pool records every query. The SQL itself is tested against a real
// Postgres in the integration test (test/refundRequests.db.test.ts, only with GATEWAY_DB_TEST=1).

type Call = { via: 'pool' | 'client'; sql: string; params: unknown[] | undefined };
type Answer = { rows?: Record<string, unknown>[]; rowCount?: number } | Error | { thrown: unknown };

function fakeDb(answers: Answer[]) {
  const calls: Call[] = [];
  const releases: unknown[] = [];
  let connects = 0;
  const query = (via: Call['via']) => async (sql: string, params?: unknown[]) => {
    calls.push({ via, sql, params });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(`fakeDb: no answer left for: ${sql}`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    if ('thrown' in answer) {
      throw answer.thrown;
    }
    const rows = answer.rows ?? [];
    return { rows, rowCount: answer.rowCount ?? rows.length };
  };
  const db = {
    query: query('pool'),
    connect: async () => {
      connects += 1;
      return { query: query('client'), release: (destroy?: unknown) => releases.push(destroy) };
    },
  } as unknown as RequestsDb;
  return { db, calls, releases, connects: () => connects };
}

function pgError(code: string, constraint?: string, table = 'action_requests', schema = 'gateway') {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
    table,
    schema,
  });
}

const ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const HASH = 'fd98f7054726b71c9b31fde2955bf322c25a627824bdf337c20d5a30362176af';
const OTHER_HASH = 'a'.repeat(64);

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

const SUCCEEDED = {
  status: 'succeeded',
  decision: 'AUTO_APPROVE',
  reason_code: 'WITHIN_AUTO_LIMIT',
  store_refund_id: '37',
};

const STORED: StoredRefundRequest = {
  id: ID,
  status: 'in_progress',
  decision: null,
  reasonCode: null,
  amountCents: 1800,
  currency: 'USD',
  storeRefundId: null,
};

const CLAIM: RefundClaim = {
  storeId: 'lumio-demo',
  orderId: '20',
  amountCents: 1800,
  currency: 'USD',
  idempotencyKey: 'agent-key-0001',
  requestHash: HASH,
  actor: 'stdio',
};

describe('classifyUniqueViolation', () => {
  it('recognises the idempotency key constraint', () => {
    expect(classifyUniqueViolation(pgError('23505', 'action_requests_idempotency_key'))).toBe('key');
  });

  it('recognises the one-open-request-per-order index', () => {
    expect(classifyUniqueViolation(pgError('23505', 'action_requests_one_open_per_order'))).toBe('open_order');
  });

  it('returns null for another unique constraint, even with code 23505', () => {
    expect(classifyUniqueViolation(pgError('23505', 'action_requests_pkey'))).toBeNull();
    expect(classifyUniqueViolation(pgError('23505', undefined))).toBeNull();
  });

  it('returns null for another SQLSTATE with our constraint name', () => {
    expect(classifyUniqueViolation(pgError('23514', 'action_requests_idempotency_key'))).toBeNull();
    expect(classifyUniqueViolation(pgError('23505 ', 'action_requests_idempotency_key'))).toBeNull();
  });

  it('returns null when the table or schema is not ours', () => {
    expect(
      classifyUniqueViolation(pgError('23505', 'action_requests_idempotency_key', 'audit_log')),
    ).toBeNull();
    expect(
      classifyUniqueViolation(pgError('23505', 'action_requests_idempotency_key', 'action_requests', 'public')),
    ).toBeNull();
  });

  it('returns null for values that are not database errors', () => {
    expect(classifyUniqueViolation(null)).toBeNull();
    expect(classifyUniqueViolation(undefined)).toBeNull();
    expect(classifyUniqueViolation('23505')).toBeNull();
    expect(classifyUniqueViolation(new Error('action_requests_idempotency_key 23505'))).toBeNull();
  });
});

describe('rowFromDb', () => {
  it('maps a row to StoredRefundRequest (frozen, extra columns ignored)', () => {
    const row = rowFromDb(dbRow({ request_hash: HASH }));
    expect(row).toEqual(STORED);
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('maps a finished row', () => {
    const row = rowFromDb(dbRow(SUCCEEDED));
    expect(row).toEqual({
      ...STORED,
      status: 'succeeded',
      decision: 'AUTO_APPROVE',
      reasonCode: 'WITHIN_AUTO_LIMIT',
      storeRefundId: '37',
    });
  });

  it.each(['in_progress', 'rejected', 'pending_approval', 'succeeded', 'failed', 'unknown', 'cancelled'])(
    'accepts status %s',
    (status) => {
      expect(rowFromDb(dbRow({ status })).status).toBe(status);
    },
  );

  it.each(['AUTO_APPROVE', 'NEEDS_APPROVAL', 'REJECT'])('accepts decision %s', (decision) => {
    expect(rowFromDb(dbRow({ decision })).decision).toBe(decision);
  });

  it.each([
    ['id', 42],
    ['id', undefined],
    ['action', 'cancel'],
    ['action', undefined],
    ['status', 'done'],
    ['status', null],
    ['decision', 'MAYBE'],
    ['decision', undefined],
    ['reason_code', 5],
    ['reason_code', undefined],
    ['amount_cents', '1800'],
    ['amount_cents', 0],
    ['amount_cents', -1],
    ['amount_cents', 1.5],
    ['amount_cents', null],
    ['amount_cents', Number.MAX_SAFE_INTEGER + 1],
    ['currency', null],
    ['store_refund_id', 37],
    ['store_refund_id', undefined],
  ])('refuses column %s = %s, naming the column but not the value', (column, value) => {
    expect(() => rowFromDb(dbRow({ [column]: value }))).toThrow(
      new Error(`rowFromDb: unexpected value in column ${column}`),
    );
  });

  it('accepts the smallest amount (1 cent)', () => {
    expect(rowFromDb(dbRow({ amount_cents: 1 })).amountCents).toBe(1);
  });
});

describe('claimRefund', () => {
  it('claims with one INSERT and the values in a fixed order', async () => {
    const fake = fakeDb([{ rows: [dbRow()] }]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({ outcome: 'claimed', row: STORED });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.via).toBe('pool');
    expect(fake.calls[0]?.sql).toMatch(/^insert into gateway\.action_requests/);
    expect(fake.calls[0]?.params).toEqual(['lumio-demo', '20', 'agent-key-0001', HASH, 1800, 'USD', 'stdio']);
    expect(fake.connects()).toBe(0); // autocommit: no transaction
  });

  it('throws if the INSERT returns no row', async () => {
    const fake = fakeDb([{ rows: [] }]);
    await expect(claimRefund(fake.db, CLAIM)).rejects.toThrow('claimRefund: expected exactly 1 row, got 0');
  });

  it('rethrows any other database error without a second query', async () => {
    const error = pgError('23514', 'refund_has_amount');
    const fake = fakeDb([error]);
    await expect(claimRefund(fake.db, CLAIM)).rejects.toBe(error);
    expect(fake.calls).toHaveLength(1);
  });

  it('same key, same hash -> replay of the stored row (read by store and key)', async () => {
    const stored = dbRow({ status: 'rejected', decision: 'REJECT', reason_code: 'NOT_PAID', request_hash: HASH });
    const fake = fakeDb([pgError('23505', 'action_requests_idempotency_key'), { rows: [stored] }]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({
      outcome: 'replay',
      row: { ...STORED, status: 'rejected', decision: 'REJECT', reasonCode: 'NOT_PAID' },
    });
    expect(fake.calls[1]?.sql).toMatch(/^select request_hash, .* where store_id = \$1 and idempotency_key = \$2$/s);
    expect(fake.calls[1]?.params).toEqual(['lumio-demo', 'agent-key-0001']);
  });

  it('same key, other hash -> key_reused', async () => {
    const fake = fakeDb([
      pgError('23505', 'action_requests_idempotency_key'),
      { rows: [dbRow({ request_hash: OTHER_HASH })] },
    ]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({ outcome: 'key_reused' });
  });

  it('same key used by another action (no amount) -> key_reused, not a crash', async () => {
    const cancelRow = dbRow({ action: 'cancel', amount_cents: null, currency: null, request_hash: OTHER_HASH });
    const fake = fakeDb([pgError('23505', 'action_requests_idempotency_key'), { rows: [cancelRow] }]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({ outcome: 'key_reused' });
  });

  it('the stored row decides, not the index: open_order + a row with this key -> replay', async () => {
    const fake = fakeDb([
      pgError('23505', 'action_requests_one_open_per_order'),
      { rows: [dbRow({ request_hash: HASH })] },
    ]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({ outcome: 'replay', row: STORED });
  });

  it('order locked and no row with this key -> pending', async () => {
    const fake = fakeDb([pgError('23505', 'action_requests_one_open_per_order'), { rows: [] }]);
    await expect(claimRefund(fake.db, CLAIM)).resolves.toEqual({ outcome: 'pending' });
    expect(fake.calls).toHaveLength(2);
  });

  it('key reported as used but no row has it -> throws (cannot happen)', async () => {
    const fake = fakeDb([pgError('23505', 'action_requests_idempotency_key'), { rows: [] }]);
    await expect(claimRefund(fake.db, CLAIM)).rejects.toThrow(
      'claimRefund: the idempotency key was reported as used, but no row has it',
    );
  });
});

describe('readByKey', () => {
  it('returns null when no row has the key', async () => {
    const fake = fakeDb([{ rows: [] }]);
    await expect(readByKey(fake.db, 'lumio-demo', 'agent-key-0001')).resolves.toBeNull();
    expect(fake.calls[0]?.params).toEqual(['lumio-demo', 'agent-key-0001']);
  });

  it('returns the mapped row', async () => {
    const fake = fakeDb([{ rows: [dbRow({ request_hash: HASH })] }]);
    await expect(readByKey(fake.db, 'lumio-demo', 'agent-key-0001')).resolves.toEqual(STORED);
  });

  it('throws on more than one row', async () => {
    const fake = fakeDb([{ rows: [dbRow(), dbRow()] }]);
    await expect(readByKey(fake.db, 'lumio-demo', 'agent-key-0001')).rejects.toThrow(
      'selectByKey: expected exactly 1 row, got 2',
    );
  });
});

const STEP: RefundStep = {
  id: ID,
  expectedStatus: 'in_progress',
  change: {
    status: 'rejected',
    decision: 'REJECT',
    reasonCode: 'NOT_PAID',
    policyVersion: '2026-11-24.2+2bbc3f6d69fc',
    storeRefundId: null,
  },
  audit: { eventType: 'decision', outcome: null, detail: { today: '2026-11-24', order: { status: 'pending' } } },
};
const REJECTED_ROW = dbRow({ status: 'rejected', decision: 'REJECT', reason_code: 'NOT_PAID' });

describe('recordStep', () => {
  it('updates the row and writes the audit entry in one transaction', async () => {
    const fake = fakeDb([{}, { rows: [REJECTED_ROW] }, { rowCount: 1 }, {}]);
    await expect(recordStep(fake.db, STEP)).resolves.toEqual({
      ...STORED,
      status: 'rejected',
      decision: 'REJECT',
      reasonCode: 'NOT_PAID',
    });
    expect(fake.calls.map((c) => c.sql.split(/\s/)[0])).toEqual(['BEGIN', 'update', 'insert', 'COMMIT']);
    expect(fake.calls.every((c) => c.via === 'client')).toBe(true); // all on the transaction's client
    expect(fake.calls[1]?.sql).toMatch(/where id = \$1 and status = \$2/);
    expect(fake.calls[1]?.params).toEqual([
      ID,
      'in_progress',
      'rejected',
      'REJECT',
      'NOT_PAID',
      '2026-11-24.2+2bbc3f6d69fc',
      null,
    ]);
    expect(fake.calls[2]?.sql).toMatch(/^insert into gateway\.audit_log/);
    expect(fake.calls[2]?.params).toEqual([
      ID,
      'decision',
      'request_refund',
      null,
      null, // actor: copied from the request row
      '{"today":"2026-11-24","order":{"status":"pending"}}',
    ]);
    expect(fake.connects()).toBe(1);
    expect(fake.releases).toEqual([undefined]);
  });

  it('passes the execution outcome and store refund id', async () => {
    const step: RefundStep = {
      id: ID,
      expectedStatus: 'in_progress',
      change: {
        status: 'succeeded',
        decision: 'AUTO_APPROVE',
        reasonCode: 'WITHIN_AUTO_LIMIT',
        policyVersion: 'v1',
        storeRefundId: '37',
      },
      audit: { eventType: 'execution', outcome: 'created', detail: {} },
    };
    const fake = fakeDb([{}, { rows: [dbRow(SUCCEEDED)] }, { rowCount: 1 }, {}]);
    await recordStep(fake.db, step);
    expect(fake.calls[1]?.params).toEqual([
      ID,
      'in_progress',
      'succeeded',
      'AUTO_APPROVE',
      'WITHIN_AUTO_LIMIT',
      'v1',
      '37',
    ]);
    expect(fake.calls[2]?.params).toEqual([ID, 'execution', 'request_refund', 'created', null, '{}']);
  });

  it('no row updated (finished, changed or hidden by RLS) -> rollback, no audit, throws', async () => {
    const fake = fakeDb([{}, { rows: [], rowCount: 0 }, {}]);
    await expect(recordStep(fake.db, STEP)).rejects.toThrow(
      'recordStep: expected to update 1 row in status in_progress, updated 0',
    );
    expect(fake.calls.map((c) => c.sql.split(/\s/)[0])).toEqual(['BEGIN', 'update', 'ROLLBACK']);
    expect(fake.releases).toEqual([undefined]);
  });

  it('audit entry not written -> rollback, throws', async () => {
    const fake = fakeDb([{}, { rows: [REJECTED_ROW] }, { rowCount: 0 }, {}]);
    await expect(recordStep(fake.db, STEP)).rejects.toThrow('insertAudit: expected to insert 1 row, inserted 0');
    expect(fake.calls.map((c) => c.sql.split(/\s/)[0])).toEqual(['BEGIN', 'update', 'insert', 'ROLLBACK']);
    expect(fake.releases).toEqual([undefined]);
  });

  it('a database error inside the transaction is rethrown after a rollback', async () => {
    const error = pgError('23514', undefined);
    const fake = fakeDb([{}, error, {}]);
    await expect(recordStep(fake.db, STEP)).rejects.toBe(error);
    expect(fake.calls.map((c) => c.sql.split(/\s/)[0])).toEqual(['BEGIN', 'update', 'ROLLBACK']);
    expect(fake.releases).toEqual([undefined]);
  });

  it('COMMIT and ROLLBACK both fail -> the client is destroyed, the COMMIT error is thrown', async () => {
    const commitError = new Error('connection lost during COMMIT');
    const rollbackError = new Error('connection lost during ROLLBACK');
    const fake = fakeDb([{}, { rows: [REJECTED_ROW] }, { rowCount: 1 }, commitError, rollbackError]);
    await expect(recordStep(fake.db, STEP)).rejects.toBe(commitError);
    expect(fake.releases).toEqual([rollbackError]);
  });

  it('a non-Error thrown by ROLLBACK still destroys the client', async () => {
    const fake = fakeDb([{}, { rows: [], rowCount: 0 }, { thrown: 'not an Error' }]);
    await expect(recordStep(fake.db, STEP)).rejects.toThrow('recordStep: expected to update 1 row');
    expect(fake.releases).toEqual([new Error('ROLLBACK failed')]);
  });
});

describe('recordReplay', () => {
  it('writes one replay audit entry with the caller as actor (no transaction)', async () => {
    const fake = fakeDb([{ rowCount: 1 }]);
    await recordReplay(fake.db, { ...STORED, status: 'succeeded' }, 'http');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.params).toEqual([ID, 'replay', 'request_refund', 'succeeded', 'http', '{}']);
    expect(fake.connects()).toBe(0);
  });

  it('throws if no audit row was written', async () => {
    const fake = fakeDb([{ rowCount: 0 }]);
    await expect(recordReplay(fake.db, STORED, 'stdio')).rejects.toThrow(
      'insertAudit: expected to insert 1 row, inserted 0',
    );
  });
});

describe('REFUND_TOOL', () => {
  it('is the MCP tool name', () => {
    expect(REFUND_TOOL).toBe('request_refund');
  });
});