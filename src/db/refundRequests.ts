// Database access for refund requests: claim, row changes with their audit entry, replay.
// Takes the pool as an argument (no import of pool.ts or dbConfig.ts, which exit the process),
// so the server can pass its own pool. No transaction is ever open while the store is called:
// each function below is one short statement or one short transaction.
import type { Pool, PoolClient } from 'pg';
import type { Decision, RequestStatus, RowChange, StoredRefundRequest } from '../actions/refundAnswer.js';

/** The tool name written into gateway.audit_log.tool. */
export const REFUND_TOOL = 'request_refund';

const KEY_CONSTRAINT = 'action_requests_idempotency_key';
const OPEN_ORDER_INDEX = 'action_requests_one_open_per_order';

/** The part of a pg Pool these functions use (a real Pool fits; tests pass a fake). */
export type RequestsDb = Pick<Pool, 'query' | 'connect'>;

/** Which of our two unique guards a 23505 came from. */
export type UniqueViolation = 'key' | 'open_order';

/** Decided by SQLSTATE + constraint name (+ table), never by the message text. */
export function classifyUniqueViolation(error: unknown): UniqueViolation | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const { code, constraint, table, schema } = error as Record<string, unknown>;
  if (code !== '23505' || table !== 'action_requests' || schema !== 'gateway') {
    return null;
  }
  if (constraint === KEY_CONSTRAINT) {
    return 'key';
  }
  if (constraint === OPEN_ORDER_INDEX) {
    return 'open_order';
  }
  return null;
}

const STATUSES: readonly RequestStatus[] = [
  'in_progress',
  'rejected',
  'pending_approval',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
];
const DECISIONS: readonly Decision[] = ['AUTO_APPROVE', 'NEEDS_APPROVAL', 'REJECT'];

function badColumn(column: string, where = 'rowFromDb'): never {
  throw new Error(`${where}: unexpected value in column ${column}`);
}

/** A row of gateway.action_requests -> StoredRefundRequest. Anything unexpected is a bug: throw. */
export function rowFromDb(record: Readonly<Record<string, unknown>>): StoredRefundRequest {
  const { id, action, status, decision, reason_code, amount_cents, currency, store_refund_id } = record;
  if (typeof id !== 'string') badColumn('id');
  if (action !== 'refund') badColumn('action');
  if (!STATUSES.includes(status as RequestStatus)) badColumn('status');
  if (decision !== null && !DECISIONS.includes(decision as Decision)) badColumn('decision');
  if (reason_code !== null && typeof reason_code !== 'string') badColumn('reason_code');
  if (typeof amount_cents !== 'number' || !Number.isSafeInteger(amount_cents) || amount_cents <= 0) {
    badColumn('amount_cents');
  }
  if (typeof currency !== 'string') badColumn('currency');
  if (store_refund_id !== null && typeof store_refund_id !== 'string') badColumn('store_refund_id');
  return Object.freeze({
    id,
    status: status as RequestStatus,
    decision: decision as Decision | null,
    reasonCode: reason_code as string | null,
    amountCents: amount_cents,
    currency,
    storeRefundId: store_refund_id as string | null,
  });
}

// Explicit columns, never "*": the answer needs exactly these.
const ROW_COLUMNS = 'id, action, status, decision, reason_code, amount_cents, currency, store_refund_id';

const INSERT_CLAIM = `insert into gateway.action_requests
  (store_id, action, order_id, idempotency_key, request_hash, amount_cents, currency, actor)
  values ($1, 'refund', $2, $3, $4, $5, $6, $7)
  returning ${ROW_COLUMNS}`;

const SELECT_BY_KEY = `select request_hash, ${ROW_COLUMNS} from gateway.action_requests
  where store_id = $1 and idempotency_key = $2`;

// Only the 5 columns the app role may update. "status = $2" catches a change made in between;
// RLS hides finished rows and the trigger refuses a wrong transition.
const UPDATE_ROW = `update gateway.action_requests
  set status = $3, decision = $4, reason_code = $5, policy_version = $6, store_refund_id = $7
  where id = $1 and status = $2
  returning ${ROW_COLUMNS}`;

// The audit entry copies the request's values from the table itself (inside the same transaction),
// so it records what the database holds, not what the program believes.
const INSERT_AUDIT = `insert into gateway.audit_log
  (request_id, event_type, tool, store_id, order_id, amount_cents, decision, reason_code,
   policy_version, outcome, store_refund_id, actor, detail)
  select id, $2, $3, store_id, order_id, amount_cents, decision, reason_code,
   policy_version, $4, store_refund_id, coalesce($5::text, actor), $6::jsonb
  from gateway.action_requests where id = $1`;

/** Everything the claim writes. Fixed at claim time: the app role cannot change these columns later. */
export type RefundClaim = Readonly<{
  storeId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  requestHash: string;
  actor: string; // the transport ("stdio" / "http"), not self-reported
}>;

export type ClaimResult =
  | { outcome: 'claimed'; row: StoredRefundRequest }
  | { outcome: 'replay'; row: StoredRefundRequest } // same key, same values: answer from this row
  | { outcome: 'key_reused' } // same key, other values: nothing saved
  | { outcome: 'pending' }; // another request for this order is still open: nothing saved

function singleRow(rows: readonly Record<string, unknown>[], what: string): Record<string, unknown> {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`${what}: expected exactly 1 row, got ${rows.length}`);
  }
  return row;
}

async function selectByKey(
  db: RequestsDb,
  storeId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const result = await db.query(SELECT_BY_KEY, [storeId, idempotencyKey]);
  return result.rows.length === 0 ? null : singleRow(result.rows, 'selectByKey');
}

/**
 * Claims the request with one INSERT (autocommit). On a duplicate, the stored row decides,
 * not which unique index Postgres checked first: a row with this key exists -> replay or key_reused
 * (by request_hash); no such row and the order is locked -> pending.
 */
export async function claimRefund(db: RequestsDb, claim: RefundClaim): Promise<ClaimResult> {
  try {
    const result = await db.query(INSERT_CLAIM, [
      claim.storeId,
      claim.orderId,
      claim.idempotencyKey,
      claim.requestHash,
      claim.amountCents,
      claim.currency,
      claim.actor,
    ]);
    return { outcome: 'claimed', row: rowFromDb(singleRow(result.rows, 'claimRefund')) };
  } catch (error) {
    const violation = classifyUniqueViolation(error);
    if (violation === null) {
      throw error;
    }
    const existing = await selectByKey(db, claim.storeId, claim.idempotencyKey);
    if (existing !== null) {
      // Compared before rowFromDb: a row of another action (no amount) is simply another request.
      if (existing.request_hash !== claim.requestHash) {
        return { outcome: 'key_reused' };
      }
      return { outcome: 'replay', row: rowFromDb(existing) };
    }
    if (violation === 'open_order') {
      return { outcome: 'pending' };
    }
    throw new Error('claimRefund: the idempotency key was reported as used, but no row has it');
  }
}

/** Reads the request stored under this key, or null. */
export async function readByKey(
  db: RequestsDb,
  storeId: string,
  idempotencyKey: string,
): Promise<StoredRefundRequest | null> {
  const record = await selectByKey(db, storeId, idempotencyKey);
  return record === null ? null : rowFromDb(record);
}

/** One short transaction. A client in an unknown state is destroyed, never returned to the pool. */
async function inTransaction<T>(db: RequestsDb, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

/** The audit entry written together with a row change. detail: no customer data. */
export type StepAudit = Readonly<{
  eventType: 'decision' | 'execution';
  outcome: string | null; // execution: "created", "rejected:<CODE>" or "unknown"
  detail: Readonly<Record<string, unknown>>;
}>;

export type RefundStep = Readonly<{
  id: string;
  expectedStatus: RequestStatus;
  change: RowChange;
  audit: StepAudit;
}>;

/**
 * Row change + its audit entry in ONE transaction: both are saved or neither.
 * Throws if the row was not exactly one open row in the expected status.
 */
export async function recordStep(db: RequestsDb, step: RefundStep): Promise<StoredRefundRequest> {
  return inTransaction(db, async (client) => {
    const { change } = step;
    const updated = await client.query(UPDATE_ROW, [
      step.id,
      step.expectedStatus,
      change.status,
      change.decision,
      change.reasonCode,
      change.policyVersion,
      change.storeRefundId,
    ]);
    if (updated.rowCount !== 1) {
      throw new Error(
        `recordStep: expected to update 1 row in status ${step.expectedStatus}, updated ${updated.rowCount}`,
      );
    }
    const row = rowFromDb(singleRow(updated.rows, 'recordStep'));
    await insertAudit(client, step.id, step.audit.eventType, step.audit.outcome, null, step.audit.detail);
    return row;
  });
}

/** Audit entry for a replay (same key, same values). actor = who called again. */
export async function recordReplay(db: RequestsDb, row: StoredRefundRequest, actor: string): Promise<void> {
  await insertAudit(db, row.id, 'replay', row.status, actor, {});
}

async function insertAudit(
  db: Pick<Pool, 'query'> | PoolClient,
  requestId: string,
  eventType: 'decision' | 'execution' | 'replay',
  outcome: string | null,
  actor: string | null,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  const result = await db.query(INSERT_AUDIT, [
    requestId,
    eventType,
    REFUND_TOOL,
    outcome,
    actor,
    JSON.stringify(detail),
  ]);
  if (result.rowCount !== 1) {
    throw new Error(`insertAudit: expected to insert 1 row, inserted ${result.rowCount}`);
  }
}

// ---- Cancelling requests that wait for a person (npm run requests:cancel-pending) ----
// Until Phase 3 (Slack approval) nothing else can finish a pending_approval request, and each one
// locks its order. A pending request never reached the store, so cancelling it only changes the row.

/** The audit actor of a cancel made by the cancel-pending script. */
export const CANCEL_PENDING_ACTOR = 'script:cancel-pending';

/** One request waiting for approval, as the script lists it. No customer data. */
export type PendingRefund = Readonly<{
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
}>;

const SELECT_PENDING = `select id, order_id, amount_cents, currency, created_at from gateway.action_requests
  where store_id = $1 and action = 'refund' and status = 'pending_approval'
  order by created_at, id`;

// Only the status changes: decision, reason_code and policy_version keep what the policy decided.
// The trigger allows pending_approval -> cancelled; "status = 'pending_approval'" catches a change in between.
const CANCEL_PENDING = `update gateway.action_requests
  set status = 'cancelled'
  where id = $1 and store_id = $2 and action = 'refund' and status = 'pending_approval'
  returning ${ROW_COLUMNS}`;

function pendingFromDb(record: Readonly<Record<string, unknown>>): PendingRefund {
  const WHERE = 'listPendingRefunds';
  const { id, order_id, amount_cents, currency, created_at } = record;
  if (typeof id !== 'string') badColumn('id', WHERE);
  if (typeof order_id !== 'string') badColumn('order_id', WHERE);
  if (typeof amount_cents !== 'number' || !Number.isSafeInteger(amount_cents) || amount_cents <= 0) {
    badColumn('amount_cents', WHERE);
  }
  if (typeof currency !== 'string') badColumn('currency', WHERE);
  if (!(created_at instanceof Date) || Number.isNaN(created_at.getTime())) badColumn('created_at', WHERE);
  return Object.freeze({ id, orderId: order_id, amountCents: amount_cents, currency, createdAt: created_at });
}

/** This store's refund requests in status pending_approval, oldest first. */
export async function listPendingRefunds(db: RequestsDb, storeId: string): Promise<PendingRefund[]> {
  const result = await db.query(SELECT_PENDING, [storeId]);
  return result.rows.map((record) => pendingFromDb(record));
}

export type CancelPendingResult =
  | { outcome: 'cancelled'; row: StoredRefundRequest }
  | { outcome: 'not_pending' }; // no longer pending (or not this store's): nothing changed

/** Cancels one pending_approval request + its audit entry in ONE transaction: both are saved or neither. */
export async function cancelPendingRefund(
  db: RequestsDb,
  request: Readonly<{ id: string; storeId: string }>,
): Promise<CancelPendingResult> {
  return inTransaction(db, async (client) => {
    const updated = await client.query(CANCEL_PENDING, [request.id, request.storeId]);
    if (updated.rowCount === 0) {
      return { outcome: 'not_pending' };
    }
    const row = rowFromDb(singleRow(updated.rows, 'cancelPendingRefund'));
    await insertAudit(client, request.id, 'decision', 'cancelled', CANCEL_PENDING_ACTOR, {
      step: 'cancel-pending',
    });
    return { outcome: 'cancelled', row };
  });
}