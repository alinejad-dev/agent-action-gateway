import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, failFromError, ok } from '../src/tools/envelope.js';
import { WooError } from '../src/woo/errors.js';

type Result = ReturnType<typeof ok>;

// Parses the JSON text that the model actually receives.
function body(result: Result): unknown {
  return JSON.parse(result.content[0]?.text ?? '');
}

describe('ok()', () => {
  it('wraps data in { ok: true, data } and is not marked as an error', () => {
    const result = ok({ id: 20 });
    expect(body(result)).toEqual({ ok: true, data: { id: 20 } });
    expect(result.isError).toBeUndefined();
  });
});

describe('fail()', () => {
  it('wraps the error in { ok: false, error } and sets isError', () => {
    const result = fail('INVALID_INPUT', 'Bad input');
    expect(body(result)).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'Bad input' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('failFromError()', () => {
  // failFromError logs technical details to stderr. Silence and observe it in tests.
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('maps a WooCommerce 404 to ORDER_NOT_FOUND', () => {
    const result = failFromError(new WooError('NOT_FOUND', 'Resource not found', 404));
    expect(body(result)).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND' } });
  });

  it('maps store auth errors to STORE_UNAVAILABLE without leaking details to the model', () => {
    const result = failFromError(new WooError('AUTH', 'Store rejected our credentials', 401));
    expect(body(result)).toMatchObject({ ok: false, error: { code: 'STORE_UNAVAILABLE' } });
    expect(result.content[0]?.text).not.toContain('credentials');
    expect(logSpy).toHaveBeenCalled(); // details go to stderr for the operator instead
  });

  it('hides unexpected internal errors behind INTERNAL_ERROR', () => {
    const result = failFromError(new Error('db password=hunter2'));
    expect(body(result)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(result.content[0]?.text).not.toContain('hunter2');
    expect(result.isError).toBe(true);
  });
});