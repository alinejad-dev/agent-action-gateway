# Database design

Status: schema `001_init.sql` applied on Nov 11, 2026. Since Nov 13, 2026 the server connects
as the restricted role `gateway_app`, and `npm run db:selftest` passes on the live database (26 checks).

The gateway stores two things in Postgres (Supabase, Frankfurt):

- `gateway.action_requests`: one row per action request. Holds the state and acts as the lock.
- `gateway.audit_log`: append-only record of every decision and every execution.

Read-only tools (`get_order`, `search_orders`) do not touch the database.
If the database is down, actions fail closed and reads keep working.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Private schema `gateway`, not `public` | In this project, `postgres` has default privileges in `public` that grant new tables to `anon` and `authenticated`. A new schema has no such defaults. |
| 2 | Plain SQL files in `migrations/` + a small runner (`src/scripts/migrate.ts`), forward-only, tracked in `gateway.schema_migrations` | No extra dependency; every line is reviewable. |
| 3 | Runtime role `gateway_app` (DML only, no DDL). `postgres` only runs admin scripts, and its password is not in `.env` | The running server never holds admin credentials. |
| 4 | RLS enabled explicitly in the migration, with policies only for `gateway_app` | The project's `ensure_rls` trigger only covers `public` (see findings). Grants are the main control; RLS is a second layer. |
| 5 | Two idempotency guards: client key (`UNIQUE (store_id, idempotency_key)`) and one open request per order (partial unique index) | An agent may retry with a new key; the per-order guard is the real protection. |
| 6 | Claim first, then live re-fetch, then policy, then execute | Re-fetching before taking the lock lets a second request act on stale data. |
| 7 | `gateway_app` may update only the result columns (`status`, `decision`, `reason_code`, `policy_version`, `store_refund_id`), and only on open rows | Who, what and how much are fixed at claim time. Finished rows cannot be changed by the app. |
| 8 | Status changes are checked by a trigger | A finished request can never be reopened, not even by the admin by mistake. |
| 9 | The app password is generated and hashed on the admin's machine; the database only receives a SCRAM-SHA-256 verifier (`src/scripts/set-app-password.ts`) | A plain `ALTER ROLE ... PASSWORD` can end up in query history and statistics. This is what `psql \password` does. |
| 10 | The permissions are proven by a self-test that runs as the app and rolls everything back (`src/scripts/selftest-db.ts`) | Least privilege is checked on the live database, not only read from the migration file. |

## Request flow

1. Validate input (zod).
2. Claim: insert into `action_requests` with status `in_progress`. A unique violation means a duplicate or an already open request -> replay or reject.
3. Re-fetch the order live from the store.
4. Evaluate the policy -> write a `decision` row to `audit_log`.
5. Execute the store API call (no DB transaction stays open during HTTP).
6. Update the status -> write an `execution` row to `audit_log`.

Rules for the application code that follow from the schema:

- Unique violation (`23505`) on claim: constraint `action_requests_idempotency_key` -> replay the stored result if `request_hash` matches, otherwise "key reused with different parameters". Constraint `action_requests_one_open_per_order` -> reject, a request for this order is already open.
- An `UPDATE` on `action_requests` that changes 0 rows is an error: the row is finished (hidden by RLS) or missing.
- Audit rows need a request row (foreign key), so input that fails validation before the claim is not audited.

## Tables

### `gateway.action_requests` (mutable state)

| Column | Notes |
|---|---|
| `id uuid` | Our id; also stored in the store refund's `meta_data` for reconciliation |
| `store_id`, `action`, `order_id text` | `order_id` is text so Shopify GIDs fit |
| `idempotency_key`, `request_hash` | Same key with different parameters -> error |
| `amount_cents integer`, `currency` | `CHECK (amount_cents > 0)`; a refund must have both |
| `status` | `in_progress`, `rejected`, `pending_approval`, `succeeded`, `failed`, `unknown`, `cancelled` |
| `decision`, `reason_code`, `policy_version`, `store_refund_id`, `actor` | Policy and execution result |
| `created_at`, `updated_at timestamptz` | Database clock, not app clock |

Open statuses (`in_progress`, `pending_approval`, `unknown`) hold the per-order lock.
`unknown` means a timeout or crash during execution; it stays locked until a human checks the store.

Allowed status changes (everything else is rejected by the trigger):

| From | To |
|---|---|
| `in_progress` | `rejected`, `pending_approval`, `succeeded`, `failed`, `unknown` |
| `pending_approval` | `cancelled` (approve/deny transitions come with Phase 3) |
| `unknown` | `succeeded`, `failed` |

Status and decision must agree: `rejected` needs `REJECT`, `pending_approval` needs `NEEDS_APPROVAL`,
`succeeded`/`unknown` need `AUTO_APPROVE` or `NEEDS_APPROVAL`.

### `gateway.audit_log` (append-only)

| Column | Notes |
|---|---|
| `id bigint identity`, `occurred_at timestamptz` | |
| `request_id uuid` | FK to `action_requests` |
| `event_type` | `decision`, `execution`, `replay` |
| `tool`, `store_id`, `order_id`, `amount_cents`, `decision`, `reason_code`, `policy_version`, `outcome`, `store_refund_id`, `actor` | Copied, so each row stands on its own |
| `detail jsonb` | What the policy saw (status, totals, `deliveredAt`, days). No customer PII |

Append-only in three layers: `gateway_app` gets only `INSERT, SELECT`; RLS has no update/delete policy; a trigger rejects `UPDATE`/`DELETE`, plus a statement-level trigger for `TRUNCATE` (row triggers do not fire on TRUNCATE).

## Roles and credentials

| Role | Used by | Can do | Credentials |
|---|---|---|---|
| `gateway_app` | the server (`.env`: `DB_USER`, `DB_PASSWORD`) | `SELECT`, `INSERT` on both tables; limited `UPDATE` on `action_requests`. No delete, no DDL, no access to `schema_migrations`. Connection limit 10 | Random 256-bit password, written to `.env` by the rotate script. Never shown on screen |
| `postgres` | admin scripts only (`.env.admin`: `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`) | Owns the schema, runs migrations, sets the app password | `.env.admin` is gitignored and never loaded by the server |

Through Supabase's shared pooler the user names are `<role>.<project-ref>`.

## Operations

| Command | What it does |
|---|---|
| `npm run migrate:status` | Read-only: applied and pending migrations |
| `npm run migrate:apply` | Applies pending migrations in one transaction (advisory lock, checksums) |
| `npm run app-password:status` | Read-only: state of `gateway_app` and whether `.env` is ready |
| `npm run app-password:rotate` | New password for `gateway_app`. The role change and the `.env` update happen in one transaction: if `.env` cannot be written, the database change is rolled back. Then it logs in with the new password to prove it works |
| `npm run db:selftest` | Runs as `gateway_app`: happy path plus everything that must be rejected (duplicate key, second open request, audit update/delete/truncate, DDL, privilege escalation). One transaction, always rolled back |

Applied migration files are never edited (the runner compares checksums). A fix is a new file `002_*.sql`.
After a rotation, restart the running server. Run the self-test after every migration.

## Findings from the live database (Nov 11-13, 2026)

- Postgres 17.11. `postgres` is not a superuser, but has `CREATEROLE` and `BYPASSRLS`. RLS never applies to `postgres`, so it only matters for `gateway_app`.
- `postgres` default privileges exist for `public` and `storage` only, not for all schemas.
- Event trigger `ensure_rls` (function `public.rls_auto_enable`, owner `postgres`) enables RLS only for tables in `public`. Errors inside it are logged, not raised. We do not rely on it.
- `pg_net` and `pg_cron` are not installed.
- A SCRAM verifier built on the client is stored as-is and works through the shared pooler (login check passed on the first attempt).
- `gateway_app` cannot create tables in `gateway` or `public`, cannot read `schema_migrations`, cannot `SET ROLE postgres` (self-test).

## Known limits

- The table owner (`postgres`) can disable triggers and change rows. The audit log is protected against the app and against mistakes, not against the database admin. No hash chain.
- `actor` is self-reported by the client (single bearer token), not a verified identity.
- A role can always change its own password in Postgres. A compromised app could lock itself out (not gain privileges); `npm run app-password:rotate` fixes it.
- Both passwords are on the developer's disk in gitignored files (`.env`, `.env.admin`). There is no secret manager yet.
- The app verifies the pooler's certificate (verify-full). The hop from the pooler to Postgres is inside Supabase and not under our control.
- Shared pooler: after rotating the `gateway_app` password, connections may fail briefly until the pooler refreshes its cached credentials. The rotate script retries the login check a few times for this reason.
- CI has no database, so the self-test is run manually. The SQL avoids Supabase-only features so it can later run in CI against a Postgres container.
- Migrations are forward-only; there are no down migrations.