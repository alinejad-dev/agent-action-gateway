import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DbSettings } from '../src/db/dbSettings.js';
import { DEFAULT_POLICY_PATH, loadPolicy } from '../src/policy/policyFile.js';
import { createRuntime, decideRefundSetup, startRuntime, type RuntimeOptions } from '../src/runtime.js';
import type { FetchLike } from '../src/woo/request.js';

// No .env, no database, no store: createRuntime builds the pool but never connects,
// and the store's HTTP client is a fake.

const READ_KEYS = { key: 'ck_read_key_never_printed', secret: 'cs_read_secret_never_printed' };
const WRITE_KEYS = { key: 'ck_write_key_never_printed', secret: 'cs_write_secret_never_printed' };
const PASSWORD = 'db-password-never-printed';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const REQUEST_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

const DB_ENV = {
  DB_HOST: 'db.example.test',
  DB_PORT: '5432',
  DB_NAME: 'postgres',
  DB_USER: 'gateway_app.abc',
  DB_PASSWORD: PASSWORD,
  DB_CA_CERT: 'certs/ca.crt',
};

const SETTINGS: DbSettings = {
  host: 'db.example.test',
  port: 5432,
  database: 'postgres',
  user: 'gateway_app.abc',
  password: PASSWORD,
  ca: PEM,
};

function options(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    baseUrl: 'http://localhost:8080',
    readKeys: READ_KEYS,
    writeKeys: WRITE_KEYS,
    env: DB_ENV,
    readTextFile: () => PEM,
    ...overrides,
  };
}

function policyFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'gateway-policy-')), 'policy.json');
  writeFileSync(path, text);
  return path;
}

describe('decideRefundSetup', () => {
  it('enabled only with the write key AND the database', () => {
    expect(decideRefundSetup(WRITE_KEYS, { ok: true, settings: SETTINGS })).toEqual({
      state: 'enabled',
      writeKeys: WRITE_KEYS,
      settings: SETTINGS,
    });
  });

  it('off without the write key', () => {
    expect(decideRefundSetup(null, { ok: true, settings: SETTINGS })).toEqual({
      state: 'off',
      reason: 'no store write key is configured',
    });
  });

  it('off without the database', () => {
    expect(decideRefundSetup(WRITE_KEYS, { ok: true, settings: null })).toEqual({
      state: 'off',
      reason: 'no database is configured',
    });
  });

  it('off without both', () => {
    expect(decideRefundSetup(null, { ok: true, settings: null })).toEqual({
      state: 'off',
      reason: 'no store write key and no database are configured',
    });
  });

  it('broken database settings stop the server, with or without a write key', () => {
    const broken = { ok: false as const, problems: ['DB_HOST: required'] };
    expect(decideRefundSetup(WRITE_KEYS, broken)).toEqual({ state: 'broken', problems: ['DB_HOST: required'] });
    expect(decideRefundSetup(null, broken)).toEqual({ state: 'broken', problems: ['DB_HOST: required'] });
  });
});

describe('createRuntime', () => {
  it('enabled: the flow gets the policy, the store id, a pool and a clock', async () => {
    const result = createRuntime(options());
    if (!result.ok) throw new Error('expected ok');
    const { runtime } = result;
    const refund = runtime.refund;
    if (refund === null) throw new Error('expected the refund tool to be on');
    expect(refund.policy).toBe(runtime.policy.refund);
    expect(refund.policy).toEqual(loadPolicy().refund);
    expect(refund.storeId).toBe('lumio-demo');
    expect(refund.adapter.platform).toBe('woocommerce');
    expect(typeof refund.db.query).toBe('function');
    expect(typeof refund.db.connect).toBe('function');
    const before = Date.now();
    const now = refund.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(Object.isFrozen(refund)).toBe(true);
    expect(runtime.notice).toBe('request_refund is on (store lumio-demo, database db.example.test)');
    await runtime.close(); // ends the pool (it never connected)
    await expect(refund.db.query('select 1')).rejects.toThrow('Cannot use a pool after calling end on the pool');
  });

  it('enabled: reads with the read key and refunds with the write key and the policy flags', async () => {
    const calls: { url: URL; body: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      return new Response('{}', { status: 500 });
    };
    const result = createRuntime(options({ fetchImpl }));
    if (!result.ok || result.runtime.refund === null) throw new Error('expected the refund tool to be on');
    const { adapter } = result.runtime.refund;
    await expect(adapter.getOrder('20')).rejects.toThrow();
    await adapter.createRefund({ orderId: '20', amountCents: 1800, requestId: REQUEST_ID });
    expect(calls[0]?.url.searchParams.get('oauth_consumer_key')).toBe(READ_KEYS.key);
    expect(calls[1]?.url.searchParams.get('oauth_consumer_key')).toBe(WRITE_KEYS.key);
    expect(calls[1]?.body).toMatchObject({ amount: '18.00', api_refund: false, api_restock: false });
    await result.runtime.close();
  });

  it('enabled: the delivery date comes from the meta key in the policy file', async () => {
    const order = {
      id: 20,
      status: 'completed',
      currency: 'USD',
      total: '18.00',
      date_paid: '2026-11-10T10:00:00',
      refunds: [],
      meta_data: [{ key: 'lumio_delivered_date', value: '2026-11-13' }],
    };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(order), { status: 200 });
    const result = createRuntime(options({ fetchImpl }));
    if (!result.ok || result.runtime.refund === null) throw new Error('expected the refund tool to be on');
    expect((await result.runtime.refund.adapter.getOrder('20')).deliveredOn).toBe('2026-11-13');
    await result.runtime.close();
  });

  it('off: no pool, read-only notice, the policy is still loaded', async () => {
    const result = createRuntime(options({ writeKeys: null, env: {} }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.runtime.refund).toBeNull();
    expect(result.runtime.policy).toEqual(loadPolicy());
    expect(result.runtime.notice).toBe(
      'request_refund is off: no store write key and no database are configured (read-only tools only)',
    );
    await expect(result.runtime.close()).resolves.toBeUndefined();
  });

  it('broken database settings: a header and the problems, never a value', () => {
    const result = createRuntime(options({ env: { DB_HOST: 'db.example.test', DB_PASSWORD: PASSWORD } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.header).toBe('Invalid database configuration. Check your .env file:');
    expect(result.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('a broken policy file stops the server even when the refund tool would be off', () => {
    const result = createRuntime(options({ writeKeys: null, env: {}, policyPath: policyFile('{ not json') }));
    expect(result).toEqual({
      ok: false,
      header: 'Invalid policy file (config/policy.json):',
      problems: ['the file is not valid JSON'],
    });
  });

  it('a policy file with an unknown field is refused, field by field', () => {
    const committed = JSON.parse(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
    const text = JSON.stringify({ ...committed, refund: { ...committed.refund, maxPerDay: 3 } });
    const result = createRuntime(options({ policyPath: policyFile(text) }));
    expect(result).toEqual({
      ok: false,
      header: 'Invalid policy file (config/policy.json):',
      problems: ['refund: Unrecognized key: "maxPerDay"'],
    });
  });
});

describe('startRuntime', () => {
  let stderr: MockInstance;
  let exit: MockInstance;
  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
  });
  afterEach(() => {
    stderr.mockRestore();
    exit.mockRestore();
  });

  function printed(): string {
    return stderr.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
  }

  it('enabled: prints the notice and returns the tool with the given transport as actor', async () => {
    const started = startRuntime(options(), 'http');
    expect(started.refundTool?.actor).toBe('http');
    expect(started.refundTool?.flow.storeId).toBe('lumio-demo');
    expect(Object.isFrozen(started.refundTool)).toBe(true);
    expect(printed()).toBe('request_refund is on (store lumio-demo, database db.example.test)');
    expect(exit).not.toHaveBeenCalled();
    await started.close();
  });

  it('off: prints why and returns no tool', () => {
    const started = startRuntime(options({ writeKeys: null }), 'stdio');
    expect(started.refundTool).toBeNull();
    expect(printed()).toBe('request_refund is off: no store write key is configured (read-only tools only)');
  });

  it('broken: prints the header and each problem, then exits with 1, without printing a secret', () => {
    expect(() => startRuntime(options({ env: { DB_HOST: 'x', DB_PASSWORD: PASSWORD } }), 'stdio')).toThrow(
      'process.exit',
    );
    expect(exit).toHaveBeenCalledWith(1);
    const lines = printed().split('\n');
    expect(lines[0]).toBe('Invalid database configuration. Check your .env file:');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith('  - '))).toBe(true);
    expect(printed()).not.toContain(PASSWORD);
    for (const secret of [READ_KEYS.key, READ_KEYS.secret, WRITE_KEYS.key, WRITE_KEYS.secret]) {
      expect(printed()).not.toContain(secret);
    }
  });
});