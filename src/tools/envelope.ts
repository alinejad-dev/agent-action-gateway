import { WooError } from '../woo/errors.js';

export type ErrorCode = 'INVALID_INPUT' | 'ORDER_NOT_FOUND' | 'STORE_UNAVAILABLE' | 'INTERNAL_ERROR';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Success envelope: { ok: true, data } */
export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }],
  };
}

/** Failure envelope: { ok: false, error: { code, message } }. isError tells the model the call failed. */
export function fail(code: ErrorCode, message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message } }, null, 2) }],
    isError: true,
  };
}

/**
 * Turns any thrown error into a safe failure envelope.
 * Technical details go to stderr for the operator — never to the model.
 */
export function failFromError(error: unknown): ToolResult {
  if (error instanceof WooError) {
    if (error.kind === 'NOT_FOUND') {
      return fail('ORDER_NOT_FOUND', 'No order exists with this ID.');
    }
    console.error(`[woo] ${error.kind}: ${error.message}`);
    return fail('STORE_UNAVAILABLE', 'The store is temporarily unavailable. Try again later.');
  }
  console.error('[internal]', error);
  return fail('INTERNAL_ERROR', 'Unexpected error while handling the request.');
}