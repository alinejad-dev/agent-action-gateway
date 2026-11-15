import { describe, expect, it } from 'vitest';
import { judgeMissingOrder, judgeRead, judgeWrite } from '../src/woo/keyProbe.js';

// Answers seen on a real WooCommerce 11.1.2 store.
const REFUSED_BY_KEY = { status: 401, code: 'woocommerce_rest_authentication_error' };
const MISSING_ORDER_PUT = { status: 400, code: 'woocommerce_rest_shop_order_invalid_id' };
const MISSING_ORDER_GET = { status: 404, code: 'woocommerce_rest_shop_order_invalid_id' };

describe('judgeRead', () => {
  it('passes on HTTP 200', () => {
    expect(judgeRead({ status: 200, code: '' }).ok).toBe(true);
  });

  it('fails when the store rejects the key or secret', () => {
    const check = judgeRead(REFUSED_BY_KEY);
    expect(check.ok).toBe(false);
    expect(check.text).toMatch(/rejected the key or secret/);
  });

  it('fails when the store does not respond or answers something else', () => {
    expect(judgeRead(null)).toEqual({ ok: false, text: 'the store did not respond' });
    expect(judgeRead({ status: 500, code: '' }).ok).toBe(false);
    expect(judgeRead({ status: 301, code: '' }).ok).toBe(false);
  });
});

describe('judgeMissingOrder', () => {
  it('passes only on HTTP 404', () => {
    expect(judgeMissingOrder(MISSING_ORDER_GET).ok).toBe(true);
  });

  it('fails when the order exists or the answer is unclear, so no write is sent', () => {
    expect(judgeMissingOrder({ status: 200, code: '' }).text).toMatch(/write probe not sent/);
    expect(judgeMissingOrder(REFUSED_BY_KEY).ok).toBe(false);
    expect(judgeMissingOrder(null).ok).toBe(false);
  });
});

describe('judgeWrite for the read key', () => {
  it('passes when the key itself refuses the write', () => {
    expect(judgeWrite('read', REFUSED_BY_KEY).ok).toBe(true);
  });

  it('fails when the key is allowed to write', () => {
    const check = judgeWrite('read', MISSING_ORDER_PUT);
    expect(check.ok).toBe(false);
    expect(check.text).toMatch(/may WRITE/);
    expect(judgeWrite('read', MISSING_ORDER_GET).ok).toBe(false);
  });

  it('fails on a 401 with another code, an unexpected success or no answer', () => {
    expect(judgeWrite('read', { status: 401, code: 'rest_forbidden' }).ok).toBe(false);
    expect(judgeWrite('read', { status: 200, code: '' }).ok).toBe(false);
    expect(judgeWrite('read', null).ok).toBe(false);
  });
});

describe('judgeWrite for the write key', () => {
  it('passes when the request gets past the key and stops at the missing order', () => {
    expect(judgeWrite('read_write', MISSING_ORDER_PUT).ok).toBe(true);
    expect(judgeWrite('read_write', MISSING_ORDER_GET).ok).toBe(true);
  });

  it('fails when the key refuses the write', () => {
    const check = judgeWrite('read_write', REFUSED_BY_KEY);
    expect(check.ok).toBe(false);
    expect(check.text).toMatch(/may not write/);
  });

  it('fails when the WordPress user may not edit orders', () => {
    expect(judgeWrite('read_write', { status: 403, code: 'woocommerce_rest_cannot_edit' }).text).toMatch(/user may not edit/);
  });

  it('fails on an unexpected success, a server error or no answer', () => {
    expect(judgeWrite('read_write', { status: 200, code: '' }).ok).toBe(false);
    expect(judgeWrite('read_write', { status: 500, code: '' }).ok).toBe(false);
    expect(judgeWrite('read_write', null).ok).toBe(false);
  });
});

describe('error codes from the store', () => {
  it('are only printed when they look like a normal code', () => {
    expect(judgeRead({ status: 418, code: 'some_code_1' }).text).toContain('HTTP 418 some_code_1');
    const odd = judgeRead({ status: 418, code: 'Bad Code <script>' });
    expect(odd.text).toContain('HTTP 418');
    expect(odd.text).not.toContain('script');
  });
});