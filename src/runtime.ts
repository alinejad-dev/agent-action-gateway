// Everything the server builds once per process, shared by the stdio and the HTTP entry point:
// the policy, the store adapter and the database pool. createServer runs once per HTTP request,
// so none of this may be created there. This file does not import config.ts (which reads .env and
// exits): the entry points pass the values in, so createRuntime is testable without a .env file.
import type { Actor, RefundFlowDeps } from './actions/refundFlow.js';
import { createPool, resolveDbSettings, type DbSettings, type DbSettingsResult } from './db/dbSettings.js';
import { DEFAULT_POLICY_PATH, loadPolicy, PolicyFileError, type LoadedPolicy } from './policy/policyFile.js';
import type { RefundToolDeps } from './tools/requestRefund.js';
import { createWooAdapter } from './woo/adapter.js';
import type { WooKeyPair } from './woo/keys.js';
import type { FetchLike } from './woo/request.js';

/** Whether request_refund can be offered. It needs BOTH the write key and the database. */
export type RefundSetup =
  | { state: 'enabled'; writeKeys: WooKeyPair; settings: DbSettings }
  | { state: 'off'; reason: string }
  | { state: 'broken'; problems: string[] };

/** Pure: a broken database configuration stops the server; a missing one only switches the tool off. */
export function decideRefundSetup(writeKeys: WooKeyPair | null, db: DbSettingsResult): RefundSetup {
  if (!db.ok) {
    return { state: 'broken', problems: db.problems };
  }
  if (writeKeys === null && db.settings === null) {
    return { state: 'off', reason: 'no store write key and no database are configured' };
  }
  if (writeKeys === null) {
    return { state: 'off', reason: 'no store write key is configured' };
  }
  if (db.settings === null) {
    return { state: 'off', reason: 'no database is configured' };
  }
  return { state: 'enabled', writeKeys, settings: db.settings };
}

export type RuntimeOptions = Readonly<{
  baseUrl: string;
  readKeys: WooKeyPair;
  writeKeys: WooKeyPair | null;
  env: Readonly<Record<string, string | undefined>>;
  policyPath?: string; // tests only
  readTextFile?: (path: string) => string; // tests only: reads the database CA file
  fetchImpl?: FetchLike; // tests only: the store's HTTP client
}>;

export type Runtime = Readonly<{
  policy: LoadedPolicy;
  /** The flow's dependencies without the actor, or null when request_refund is off. */
  refund: RefundFlowDeps | null;
  /** One line for stderr: whether request_refund is on, and why not. No secrets. */
  notice: string;
  /** Closes the database pool, if there is one. */
  close: () => Promise<void>;
}>;

export type RuntimeResult = { ok: true; runtime: Runtime } | { ok: false; header: string; problems: string[] };

/** Builds the runtime, or lists what is wrong. Never exits and never connects to the database. */
export function createRuntime(options: RuntimeOptions): RuntimeResult {
  let policy: LoadedPolicy;
  try {
    policy = loadPolicy(options.policyPath ?? DEFAULT_POLICY_PATH);
  } catch (error) {
    if (error instanceof PolicyFileError) {
      return { ok: false, header: 'Invalid policy file (config/policy.json):', problems: [...error.problems] };
    }
    throw error;
  }

  const dbOptions = options.readTextFile === undefined ? {} : { readTextFile: options.readTextFile };
  const setup = decideRefundSetup(options.writeKeys, resolveDbSettings(options.env, dbOptions));
  if (setup.state === 'broken') {
    return { ok: false, header: 'Invalid database configuration. Check your .env file:', problems: setup.problems };
  }
  if (setup.state === 'off') {
    const notice = `request_refund is off: ${setup.reason} (read-only tools only)`;
    return { ok: true, runtime: { policy, refund: null, notice, close: async () => {} } };
  }

  const pool = createPool(setup.settings); // does not connect yet: the first request does
  const adapter = createWooAdapter({
    baseUrl: options.baseUrl,
    readKeys: options.readKeys,
    writeKeys: setup.writeKeys,
    deliveredMetaKey: policy.store.deliveredMetaKey,
    refundFlags: { apiRefund: policy.store.apiRefund, apiRestock: policy.store.apiRestock },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const refund = Object.freeze({
    db: pool,
    adapter,
    policy: policy.refund,
    storeId: policy.store.storeId,
    now: () => new Date(),
  });
  const notice = `request_refund is on (store ${policy.store.storeId}, database ${setup.settings.host})`;
  return { ok: true, runtime: { policy, refund, notice, close: () => pool.end() } };
}

/** For the entry points: prints the notice, or the problems and exits. Returns the tool's dependencies. */
export function startRuntime(
  options: RuntimeOptions,
  actor: Actor,
): { refundTool: RefundToolDeps | null; close: () => Promise<void> } {
  const result = createRuntime(options);
  if (!result.ok) {
    console.error(result.header);
    for (const problem of result.problems) {
      // Problems name the setting and the rule, never a value.
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  const { runtime } = result;
  console.error(runtime.notice);
  const refundTool = runtime.refund === null ? null : Object.freeze({ flow: runtime.refund, actor });
  return { refundTool, close: runtime.close };
}