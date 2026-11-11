# Database design

Status: design approved (Nov 11, 2026). Migration `001_init.sql` is not written yet.

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
| 3 | Runtime role `gateway_app` (DML only, no DDL). `postgres` only runs migrations, and its password is kept out of `.env` | The running server never holds admin credentials. |
| 4 | RLS enabled explicitly in the migration, with policies only for `gateway_app` | The project's `ensure_rls` trigger only covers `public` (see findings). Grants are the main control; RLS is a second layer. |
| 5 | Two idempotency guards: client key (`UNIQUE (store_id, idempotency_key)`) and one open request per order (partial unique index) | An agent may retry with a new key; the per-order guard is the real protection. |
| 6 | Claim first, then live re-fetch, then policy, then execute | Re-fetching before taking the lock lets a second request act on stale data. |

## Request flow

1. Validate input (zod).
2. Claim: insert into `action_requests` with status `in_progress`. A unique violation means a duplicate or an already open request -> replay or reject.
3. Re-fetch the order live from the store.
4. Evaluate the policy -> write a `decision` row to `audit_log`.
5. Execute the store API call (no DB transaction stays open during HTTP).
6. Update the status -> write an `execution` row to `audit_log`.

## Tables (planned)

### `gateway.action_requests` (mutable state)

| Column | Notes |
|---|---|
| `id uuid` | Our id; also stored in the store refund's `meta_data` for reconciliation |
| `store_id`, `action`, `order_id text` | `order_id` is text so Shopify GIDs fit |
| `idempotency_key`, `request_hash` | Same key with different parameters -> error |
| `amount_cents integer`, `currency` | `CHECK (amount_cents > 0)` |
| `status` | `in_progress`, `rejected`, `pending_approval`, `succeeded`, `failed`, `unknown`, `cancelled` |
| `decision`, `reason_code`, `policy_version`, `store_refund_id`, `actor` | Policy and execution result |
| `created_at`, `updated_at timestamptz` | Database clock, not app clock |

Open statuses (`in_progress`, `pending_approval`, `unknown`) hold the per-order lock.
`unknown` means a timeout or crash during execution; it stays locked until a human checks the store.

### `gateway.audit_log` (append-only)

| Column | Notes |
|---|---|
| `id bigint identity`, `occurred_at timestamptz` | |
| `request_id uuid` | FK to `action_requests` |
| `event_type` | `decision`, `execution`, `replay` |
| `tool`, `store_id`, `order_id`, `amount_cents`, `decision`, `reason_code`, `policy_version`, `outcome`, `store_refund_id`, `actor` | Copied, so each row stands on its own |
| `detail jsonb` | What the policy saw (status, totals, `deliveredAt`, days). No customer PII |

Append-only in three layers: `gateway_app` gets only `INSERT, SELECT`; RLS has no update/delete policy; a trigger rejects `UPDATE`/`DELETE`, plus a statement-level trigger for `TRUNCATE` (row triggers do not fire on TRUNCATE).

## Findings from the live database (Nov 11, 2026)

- Postgres 17.11. `postgres` is not a superuser, but has `CREATEROLE` and `BYPASSRLS`. RLS never applies to `postgres`, so it only matters for `gateway_app`.
- `postgres` default privileges exist for `public` and `storage` only, not for all schemas.
- Event trigger `ensure_rls` (function `public.rls_auto_enable`, owner `postgres`) enables RLS only for tables in `public`. Errors inside it are logged, not raised. We do not rely on it.
- No `gateway` schema and no `gateway_app` role exist yet. `public` has no tables. `pg_net` and `pg_cron` are not installed.

## Known limits

- The table owner (`postgres`) can disable triggers and change rows. The audit log is protected against the app and against mistakes, not against the database admin. No hash chain.
- `actor` is self-reported by the client (single bearer token), not a verified identity.
- CI has no database, so DB tests are manual for now. The SQL avoids Supabase-only features so it can later run in CI against a Postgres container.
- Shared pooler: after rotating the `gateway_app` password, connections may fail briefly until the pooler refreshes its cached credentials.