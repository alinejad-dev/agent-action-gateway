import { describe, expect, it } from 'vitest';
import { formatCents, parseMoneyToCents, refundTotalToCents } from '../src/woo/money.js';

describe('parseMoneyToCents', () => {
  it.each([
    ['18.00', 1800],
    ['18.5', 1850],
    ['7', 700],
    ['0.05', 5],
    ['10.01', 1001],
    ['-18.00', -1800],
    ['0.00', 0],
    ['-0.00', 0],
    ['999999999999.99', 99999999999999],
  ])('reads %j as %i cents', (value, cents) => {
    expect(parseMoneyToCents(value)).toBe(cents);
  });

  it.each([
    ['empty', ''],
    ['text', 'abc'],
    ['comma decimal (WooCommerce saved "1,50" as 150.00)', '1,50'],
    ['three decimals', '10.005'],
    ['no digit before the dot', '.5'],
    ['no digit after the dot', '5.'],
    ['exponent', '1e3'],
    ['leading space', ' 18.00'],
    ['trailing space', '18.00 '],
    ['plus sign', '+5'],
    ['double minus', '--5'],
    ['13 digits', '1234567890123'],
    ['Arabic-Indic digits', '\u0661\u0668'],
    ['a dash alone', '-'],
  ])('refuses %s', (_label, value) => {
    expect(parseMoneyToCents(value)).toBeNull();
  });
});

describe('formatCents', () => {
  it.each([
    [1800, '18.00'],
    [5, '0.05'],
    [0, '0.00'],
    [123456, '1234.56'],
  ])('writes %i cents as %j', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it.each([
    ['negative', -1],
    ['not whole', 1.5],
    ['NaN', Number.NaN],
    ['too large to be exact', Number.MAX_SAFE_INTEGER + 1],
  ])('refuses a %s amount', (_label, cents) => {
    expect(() => formatCents(cents)).toThrow('cents');
  });

  it('round-trips with parseMoneyToCents', () => {
    for (const text of ['0.00', '0.01', '18.00', '89.99', '1234.56']) {
      expect(formatCents(parseMoneyToCents(text) ?? -1)).toBe(text);
    }
  });
});

describe('refundTotalToCents', () => {
  it('reads a WooCommerce refund total as positive cents', () => {
    expect(refundTotalToCents('-18.00')).toBe(1800);
    expect(refundTotalToCents('-25.00')).toBe(2500);
  });

  it('reads "-" (a refund created without an amount) as 0', () => {
    expect(refundTotalToCents('-')).toBe(0);
  });

  it('returns null for anything that is not money', () => {
    expect(refundTotalToCents('abc')).toBeNull();
    expect(refundTotalToCents('-1,50')).toBeNull();
    expect(refundTotalToCents('')).toBeNull();
  });
});