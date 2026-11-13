-- 001_init: action requests (state + lock), append-only audit log, app role.
-- Runs as postgres inside the runner's transaction. The runner already
-- created schema "gateway". Design notes: docs/database.md

-- ============================================================
-- 1. action_requests: one row per action request (state + lock)
-- ============================================================

create table gateway.action_requests (
  id              uuid primary key default gen_random_uuid(),
  store_id        text not null check (store_id ~ '^[a-z0-9_-]{1,64}$'),
  action          text not null check (action in ('refund', 'cancel')),
  order_id        text not null check (length(order_id) between 1 and 200),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash    text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  amount_cents    integer check (amount_cents > 0),
  currency        text check (currency ~ '^[A-Z]{3}$'),
  status          text not null default 'in_progress' check (status in (
                    'in_progress', 'rejected', 'pending_approval',
                    'succeeded', 'failed', 'unknown', 'cancelled')),
  decision        text check (decision in ('AUTO_APPROVE', 'NEEDS_APPROVAL', 'REJECT')),
  reason_code     text check (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  policy_version  text check (length(policy_version) <= 64),
  store_refund_id text check (length(store_refund_id) <= 200),
  actor           text check (length(actor) <= 200),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Guard 1: the same client key can only be used once per store.
  constraint action_requests_idempotency_key unique (store_id, idempotency_key),
  -- A refund always has an amount and a currency.
  constraint refund_has_amount check (
    action <> 'refund' or (amount_cents is not null and currency is not null)),
  -- Status and decision must agree.
  -- ("is not distinct from" / coalesce: a NULL decision must fail the check, not pass it.)
  constraint rejected_means_reject check (
    status <> 'rejected' or decision is not distinct from 'REJECT'),
  constraint pending_means_needs_approval check (
    status <> 'pending_approval' or decision is not distinct from 'NEEDS_APPROVAL'),
  constraint executed_means_approved check (
    status not in ('succeeded', 'unknown')
    or coalesce(decision, '') in ('AUTO_APPROVE', 'NEEDS_APPROVAL'))
);

-- Guard 2: at most one OPEN request per order (any action, any key).
-- This is what stops a double refund when an agent retries with a new key.
create unique index action_requests_one_open_per_order
  on gateway.action_requests (store_id, order_id)
  where status in ('in_progress', 'pending_approval', 'unknown');

-- Allowed status changes; finished rows can never be reopened.
-- Also sets updated_at from the database clock.
create function gateway.action_requests_before_update() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'in_progress'
          and new.status in ('rejected', 'pending_approval', 'succeeded', 'failed', 'unknown'))
    or (old.status = 'pending_approval' and new.status = 'cancelled')
    or (old.status = 'unknown' and new.status in ('succeeded', 'failed'))
  ) then
    raise exception 'action_requests: status change % -> % is not allowed', old.status, new.status
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger action_requests_before_update
  before update on gateway.action_requests
  for each row execute function gateway.action_requests_before_update();

-- ============================================================
-- 2. audit_log: append-only record of decisions and executions
-- ============================================================

create table gateway.audit_log (
  id              bigint generated always as identity primary key,
  occurred_at     timestamptz not null default now(),
  request_id      uuid not null references gateway.action_requests (id),
  event_type      text not null check (event_type in ('decision', 'execution', 'replay')),
  -- Copied from the request, so each row stands on its own.
  tool            text not null check (length(tool) <= 64),
  store_id        text not null,
  order_id        text not null,
  amount_cents    integer,
  decision        text,
  reason_code     text,
  policy_version  text,
  outcome         text check (length(outcome) <= 64),
  store_refund_id text,
  actor           text,
  -- What the policy saw (status, totals, deliveredAt, days). No customer PII.
  detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);

create index audit_log_request_id on gateway.audit_log (request_id);
create index audit_log_order on gateway.audit_log (store_id, order_id, occurred_at);

-- Append-only, also for the admin by mistake (the owner can still disable it on purpose).
create function gateway.audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only (% is not allowed)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on gateway.audit_log
  for each row execute function gateway.audit_log_append_only();

-- Row triggers do not fire on TRUNCATE, so it needs its own statement trigger.
create trigger audit_log_no_truncate
  before truncate on gateway.audit_log
  for each statement execute function gateway.audit_log_append_only();

-- ============================================================
-- 3. App role: data access only, no DDL, no delete
-- ============================================================

-- Created WITHOUT login. The password is set outside the repo, so it never
-- appears in a migration file (see docs/database.md).
create role gateway_app nologin connection limit 10;

grant usage on schema gateway to gateway_app;

grant select, insert on gateway.action_requests to gateway_app;
-- Only the result columns can change; who/what/how much is fixed at claim time.
grant update (status, decision, reason_code, policy_version, store_refund_id)
  on gateway.action_requests to gateway_app;

grant select, insert on gateway.audit_log to gateway_app;

-- Row Level Security: second layer, policies only for gateway_app.
-- (postgres has BYPASSRLS, so RLS never applies to the admin.)
alter table gateway.action_requests enable row level security;
alter table gateway.audit_log enable row level security;

create policy app_select on gateway.action_requests
  for select to gateway_app using (true);
create policy app_insert on gateway.action_requests
  for insert to gateway_app with check (true);
-- Finished rows are invisible to UPDATE, so the app cannot touch them.
create policy app_update_open on gateway.action_requests
  for update to gateway_app
  using (status in ('in_progress', 'pending_approval', 'unknown'))
  with check (true);

create policy app_select on gateway.audit_log
  for select to gateway_app using (true);
create policy app_insert on gateway.audit_log
  for insert to gateway_app with check (true);
-- No update/delete policy on audit_log: those are denied for gateway_app.