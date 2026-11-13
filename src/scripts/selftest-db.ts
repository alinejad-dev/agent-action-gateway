// Database self-test: proves on the real database what the app role can and cannot do.
//   npm run db:selftest
// It connects exactly like the server (shared pool, .env, role gateway_app).
// Everything runs in ONE transaction that is always rolled back: no test rows are kept,
// and if a statement that must be rejected ever succeeds, that is undone as well.
// Output contains no secrets. Exit code 1 if any check fails.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

const APP_ROLE = 'gateway_app';

// Clearly fake data, in case a row is ever seen outside this test.
const STORE = 'selftest';
const RUN = randomUUID().slice(0, 8);
const ORDER_1 = `selftest-${RUN}-1`;
const ORDER_2 = `selftest-${RUN}-2`;
const ORDER_3 = `selftest-${RUN}-3`;
const KEY_1 = `key-${RUN}-1`;
const KEY_2 = `key-${RUN}-2`;
const KEY_3 = `key-${RUN}-3`;
const KEY_4 = `key-${RUN}-4`;
const HASH = 'a'.repeat(64);

// PostgreSQL error codes (SQLSTATE) we expect.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const PERMISSION_DENIED = '42501';

type Expect =
  | { allowed: true; rows?: number } // must succeed (optionally: affect exactly this many rows)
  | { allowed: false; code: string; constraint?: string }; // must fail with this error

type Row = Record<string, unknown>;
type Params = (string | number | null)[];

let passed = 0;
let failed = 0;

function report(ok: boolean, name: string, note: string): void {
  if (ok) {
    passed++;
  } else {
    failed++;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${note}`);
}

// Runs one statement inside a savepoint, so a rejected statement does not end the transaction.
async function check(client: PoolClient, name: string, expect: Expect, sql: string, params?: Params): Promise<Row[]> {
  await client.query('SAVEPOINT one_check');
  try {
    const res = await client.query<Row>(sql, params);
    if (!expect.allowed) {
      await client.query('ROLLBACK TO SAVEPOINT one_check'); // undo it right away
      report(false, name, 'was ALLOWED, but must be rejected');
      return [];
    }
    await client.query('RELEASE SAVEPOINT one_check');
    if (expect.rows !== undefined && res.rowCount !== expect.rows) {
      report(false, name, `expected ${expect.rows} row(s), got ${res.rowCount}`);
    } else {
      report(true, name, expect.rows === undefined ? 'allowed' : `allowed, ${res.rowCount} row(s)`);
    }
    return res.rows;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT one_check');
    const pgError = error as { code?: string; constraint?: string; message?: string };
    const got = `${pgError.code ?? 'no code'}${pgError.constraint ? ` ${pgError.constraint}` : ''}`;
    if (expect.allowed) {
      report(false, name, `must be allowed, but failed: ${pgError.message ?? ''} (${got})`);
      return [];
    }
    const sameCode = pgError.code === expect.code;
    const sameConstraint = expect.constraint === undefined || pgError.constraint === expect.constraint;
    if (sameCode && sameConstraint) {
      report(true, name, `rejected (${got})`);
    } else {
      const wanted = `${expect.code}${expect.constraint ? ` ${expect.constraint}` : ''}`;
      report(false, name, `rejected with ${got}, expected ${wanted}`);
    }
    return [];
  }
}

const allowed: Expect = { allowed: true };
const denied: Expect = { allowed: false, code: PERMISSION_DENIED };

const CLAIM_SQL = `
  insert into gateway.action_requests
    (store_id, action, order_id, idempotency_key, request_hash, amount_cents, currency, actor)
  values ($1, 'refund', $2, $3, $4, $5, 'USD', 'selftest')
  returning id`;

const AUDIT_SQL = `
  insert into gateway.audit_log (request_id, event_type, tool, store_id, order_id, amount_cents, decision, outcome, actor)
  values ($1, $2, 'request_refund', $3, $4, 1800, 'AUTO_APPROVE', $5, 'selftest')`;

async function runChecks(client: PoolClient): Promise<void> {
  // ----- Claim (idempotency) -----
  const claimed = await check(client, 'claim a refund request', allowed, CLAIM_SQL, [STORE, ORDER_1, KEY_1, HASH, 1800]);
  const id = String(claimed[0]?.id ?? '');

  await check(
    client,
    'same idempotency key again',
    { allowed: false, code: UNIQUE_VIOLATION, constraint: 'action_requests_idempotency_key' },
    CLAIM_SQL,
    [STORE, ORDER_2, KEY_1, HASH, 1800],
  );
  await check(
    client,
    'new key, but the order already has an open request',
    { allowed: false, code: UNIQUE_VIOLATION, constraint: 'action_requests_one_open_per_order' },
    CLAIM_SQL,
    [STORE, ORDER_1, KEY_2, HASH, 1800],
  );
  await check(
    client,
    'refund without an amount',
    { allowed: false, code: CHECK_VIOLATION, constraint: 'refund_has_amount' },
    CLAIM_SQL,
    [STORE, ORDER_3, KEY_3, HASH, null],
  );

  // ----- Updates on an open request -----
  await check(client, 'change the amount after the claim', denied,
    'update gateway.action_requests set amount_cents = 1 where id = $1', [id]);
  await check(
    client,
    'status "rejected" without decision REJECT',
    { allowed: false, code: CHECK_VIOLATION, constraint: 'rejected_means_reject' },
    "update gateway.action_requests set status = 'rejected' where id = $1",
    [id],
  );
  await check(
    client,
    'status change that is not allowed (-> cancelled)',
    { allowed: false, code: CHECK_VIOLATION },
    "update gateway.action_requests set status = 'cancelled' where id = $1",
    [id],
  );

  // ----- Happy path: decision -> execute -> finished -----
  await check(client, 'audit row: decision', allowed, AUDIT_SQL, [id, 'decision', STORE, ORDER_1, null]);
  await check(
    client,
    'finish the request (in_progress -> succeeded)',
    { allowed: true, rows: 1 },
    `update gateway.action_requests
        set status = 'succeeded', decision = 'AUTO_APPROVE', reason_code = 'SELFTEST',
            policy_version = 'selftest', store_refund_id = 'selftest-refund'
      where id = $1`,
    [id],
  );
  await check(client, 'audit row: execution', allowed, AUDIT_SQL, [id, 'execution', STORE, ORDER_1, 'succeeded']);

  // ----- Finished rows -----
  await check(
    client,
    'change a finished request (hidden by RLS)',
    { allowed: true, rows: 0 },
    "update gateway.action_requests set status = 'failed' where id = $1",
    [id],
  );
  await check(client, 'new request for the same order after it finished', allowed,
    CLAIM_SQL, [STORE, ORDER_1, KEY_4, HASH, 1800]);

  // ----- Audit log is append-only -----
  await check(client, 'UPDATE audit_log', denied, "update gateway.audit_log set outcome = 'changed' where request_id = $1", [id]);
  await check(client, 'DELETE FROM audit_log', denied, 'delete from gateway.audit_log where request_id = $1', [id]);
  await check(client, 'TRUNCATE audit_log', denied, 'truncate gateway.audit_log');
  await check(client, 'disable the triggers on audit_log', denied, 'alter table gateway.audit_log disable trigger all');

  // ----- No delete, no DDL, no admin tables -----
  await check(client, 'DELETE FROM action_requests', denied, 'delete from gateway.action_requests where id = $1', [id]);
  await check(client, 'TRUNCATE action_requests', denied, 'truncate gateway.action_requests cascade');
  await check(client, 'DROP TABLE audit_log', denied, 'drop table gateway.audit_log');
  await check(client, 'CREATE TABLE in schema gateway', denied, 'create table gateway.selftest_table (i int)');
  await check(client, 'CREATE TABLE in schema public', denied, 'create table public.selftest_table (i int)');
  await check(client, 'read gateway.schema_migrations', denied, 'select version from gateway.schema_migrations');

  // ----- No privilege escalation -----
  await check(client, 'give itself CREATEROLE', denied, `alter role ${APP_ROLE} createrole`);
  await check(client, 'become the admin (SET ROLE postgres)', denied, 'set role postgres');
}

async function main(): Promise<void> {
  const who = await pool.query<{ usr: string; rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(
    'select current_user as usr, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user',
  );
  const me = who.rows[0];
  if (me?.usr !== APP_ROLE) {
    // The admin bypasses RLS, so the results would be misleading.
    throw new Error(`This test must run as ${APP_ROLE} (DB_USER in .env). Connected as: ${me?.usr ?? 'unknown'}`);
  }
  console.log(`Database self-test as ${me.usr} (one transaction, rolled back at the end)`);
  report(!me.rolsuper && !me.rolcreaterole && !me.rolbypassrls, 'role is not superuser / createrole / bypassrls', '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await runChecks(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }

  const left = await pool.query<{ n: number }>(
    'select count(*)::int as n from gateway.action_requests where store_id = $1 and order_id like $2',
    [STORE, `selftest-${RUN}-%`],
  );
  report(left.rows[0]?.n === 0, 'no test rows left after the rollback', `${left.rows[0]?.n ?? '?'} row(s)`);

  console.log(`Result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    // Print only the error message, never the config (it contains the password).
    console.error('Self-test could not run:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());