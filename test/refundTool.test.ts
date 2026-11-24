import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RefundFlowDeps } from '../src/actions/refundFlow.js';
import { RefundInputSchema, type RefundInput } from '../src/actions/refundInput.js';
import type { RequestsDb } from '../src/db/refundRequests.js';
import { loadPolicy } from '../src/policy/policyFile.js';
import type { StoreAdapter } from '../src/store/adapter.js';
import {
  REQUEST_REFUND_DESCRIPTION,
  registerRequestRefundTool,
  type RefundToolDeps,
} from '../src/tools/requestRefund.js';

// The tool file only connects the MCP SDK to the flow: these tests capture what it registers
// and check how flow answers and thrown errors become the { ok, ... } envelope.
// The flow itself is tested in refundFlow.test.ts / refundFlow.db.test.ts.

type Registered = {
  name: string;
  config: Record<string, unknown>;
  handler: (input: RefundInput) => Promise<unknown>;
};

function register(deps: RefundToolDeps): Registered {
  let registered: Registered | undefined;
  const server = {
    registerTool: (name: string, config: Record<string, unknown>, handler: Registered['handler']) => {
      registered = { name, config, handler };
    },
  } as unknown as McpServer;
  registerRequestRefundTool(server, deps);
  if (registered === undefined) throw new Error('nothing registered');
  return registered;
}

const ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const HASH = 'fd98f7054726b71c9b31fde2955bf322c25a627824bdf337c20d5a30362176af'; // store lumio-demo, #20, 1800 USD
const INPUT: RefundInput = { order_id: 20, amount: '18.00', currency: 'USD', idempotency_key: 'agent-key-0001' };

const ADAPTER = {
  platform: 'woocommerce',
  getOrder: async () => {
    throw new Error('the store must not be called in these tests');
  },
} as unknown as StoreAdapter;

/** A pool that answers the claim with "this key is already used" and then the given stored row. */
function dbWithStoredRow(row: Record<string, unknown> | null, params: unknown[][] = []): RequestsDb {
  const answers: (Record<string, unknown> | Error)[] = [
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'action_requests_idempotency_key',
      table: 'action_requests',
      schema: 'gateway',
    }),
    { rows: row === null ? [] : [row] },
    { rows: [], rowCount: 1 }, // replay audit
  ];
  return {
    query: async (_sql: string, values: unknown[]) => {
      params.push(values);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    connect: async () => {
      throw new Error('no transaction expected');
    },
  } as unknown as RequestsDb;
}

function deps(db: RequestsDb, actor: 'stdio' | 'http' = 'stdio'): RefundToolDeps {
  const flow: RefundFlowDeps = {
    db,
    adapter: ADAPTER,
    policy: loadPolicy().refund,
    storeId: 'lumio-demo',
    now: () => new Date('2026-11-24T12:00:00Z'),
  };
  return { flow, actor };
}

const SUCCEEDED_ROW = {
  id: ID,
  request_hash: HASH,
  action: 'refund',
  status: 'succeeded',
  decision: 'AUTO_APPROVE',
  reason_code: 'WITHIN_AUTO_LIMIT',
  amount_cents: 1800,
  currency: 'USD',
  store_refund_id: '37',
};

function envelope(result: unknown): { isError: boolean; body: unknown } {
  const { content, isError } = result as { content: { type: string; text: string }[]; isError?: boolean };
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return { isError: isError === true, body: JSON.parse(String(content[0]?.text)) };
}

let stderr: MockInstance;
beforeEach(() => {
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
});

describe('request_refund tool registration', () => {
  it('registers the strict input schema, the description and the agreed annotations', () => {
    const tool = register(deps(dbWithStoredRow(null)));
    expect(tool.name).toBe('request_refund');
    expect(tool.config).toEqual({
      title: 'Request refund',
      description: REQUEST_REFUND_DESCRIPTION,
      inputSchema: RefundInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    });
  });

  it('the description promises a record in the store, never money', () => {
    expect(REQUEST_REFUND_DESCRIPTION).toContain('records the refund in the store');
    expect(REQUEST_REFUND_DESCRIPTION).toContain('idempotency_key');
    expect(REQUEST_REFUND_DESCRIPTION.toLowerCase()).not.toMatch(/money|returned|paid back/);
  });
});

describe('request_refund tool answers', () => {
  it('an ok answer becomes { ok: true, data } without isError, and the caller transport is the actor', async () => {
    const params: unknown[][] = [];
    const tool = register(deps(dbWithStoredRow(SUCCEEDED_ROW, params), 'http'));
    const { isError, body } = envelope(await tool.handler(INPUT));
    expect(isError).toBe(false);
    expect(body).toEqual({
      ok: true,
      data: {
        request_id: ID,
        status: 'succeeded',
        decision: 'AUTO_APPROVE',
        reason_code: 'WITHIN_AUTO_LIMIT',
        amount: '18.00',
        currency: 'USD',
        store_refund_id: '37',
        replayed: true,
        next_step: 'The refund is recorded in the store. Do not request it again.',
      },
    });
    expect(params[0]?.at(-1)).toBe('http'); // claim: actor
    expect(params[2]?.[4]).toBe('http'); // replay audit: actor
  });

  it('a refusal by the gateway becomes { ok: false, error } with isError', async () => {
    const tool = register(deps(dbWithStoredRow({ ...SUCCEEDED_ROW, request_hash: 'a'.repeat(64) })));
    const { isError, body } = envelope(await tool.handler(INPUT));
    expect(isError).toBe(true);
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This idempotency_key was already used for a different request. Use a new key for a new request.',
      },
    });
  });

  it('a thrown error becomes INTERNAL_ERROR; the details go to stderr only', async () => {
    const db = {
      query: async () => {
        throw new Error('connection to db.example.test refused');
      },
      connect: async () => {
        throw new Error('no');
      },
    } as unknown as RequestsDb;
    const tool = register(deps(db));
    const { isError, body } = envelope(await tool.handler(INPUT));
    expect(isError).toBe(true);
    expect(body).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected error while handling the request.' },
    });
    expect(JSON.stringify(body)).not.toContain('db.example.test');
    expect(stderr).toHaveBeenCalled();
  });
});