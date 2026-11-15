import { describe, expect, it } from 'vitest';
import { describeKeyProblem, resolveWriteKeys } from '../src/woo/keys.js';

// Fake keys used only in tests (same shape as real ones: prefix + 40 hex characters).
const READ_KEY = `ck_${'a1'.repeat(20)}`;
const READ_SECRET = `cs_${'b2'.repeat(20)}`;
const WRITE_KEY = `ck_${'c3'.repeat(20)}`;
const WRITE_SECRET = `cs_${'d4'.repeat(20)}`;

describe('describeKeyProblem', () => {
  it('accepts a key and a secret in the WooCommerce format', () => {
    expect(describeKeyProblem('key', WRITE_KEY)).toBeNull();
    expect(describeKeyProblem('secret', WRITE_SECRET)).toBeNull();
  });

  it('reports an empty value', () => {
    expect(describeKeyProblem('key', '')).toMatch(/nothing was entered/);
  });

  it('notices the key and the secret being swapped', () => {
    expect(describeKeyProblem('key', WRITE_SECRET)).toMatch(/it is the consumer secret/);
    expect(describeKeyProblem('secret', WRITE_KEY)).toMatch(/it is the consumer key/);
  });

  it('reports a wrong start, a wrong length and wrong characters', () => {
    expect(describeKeyProblem('key', 'something-else-from-the-clipboard')).toMatch(/starts with ck_/);
    expect(describeKeyProblem('key', WRITE_KEY.slice(0, 42))).toMatch(/got 42 characters/);
    expect(describeKeyProblem('key', `${WRITE_KEY}0`)).toMatch(/got 44 characters/);
    expect(describeKeyProblem('key', `ck_${'G'.repeat(40)}`)).toMatch(/0-9 a-f/);
    expect(describeKeyProblem('key', WRITE_KEY.toUpperCase())).not.toBeNull();
  });

  it('never puts the value in the message', () => {
    for (const bad of ['my-secret-clipboard-text', WRITE_SECRET, WRITE_KEY.slice(0, 30)]) {
      expect(describeKeyProblem('key', bad)).not.toContain(bad);
      expect(describeKeyProblem('key', bad)).not.toContain(bad.slice(3, 12));
    }
  });
});

describe('resolveWriteKeys', () => {
  const read = { WOO_CONSUMER_KEY: READ_KEY, WOO_CONSUMER_SECRET: READ_SECRET };

  it('returns null when both variables are missing or empty (read-only setup)', () => {
    expect(resolveWriteKeys({ ...read })).toEqual({ ok: true, keys: null });
    expect(resolveWriteKeys({ ...read, WOO_WRITE_CONSUMER_KEY: '', WOO_WRITE_CONSUMER_SECRET: '' })).toEqual({
      ok: true,
      keys: null,
    });
  });

  it('returns the pair when both are set', () => {
    const result = resolveWriteKeys({
      ...read,
      WOO_WRITE_CONSUMER_KEY: WRITE_KEY,
      WOO_WRITE_CONSUMER_SECRET: WRITE_SECRET,
    });
    expect(result).toEqual({ ok: true, keys: { key: WRITE_KEY, secret: WRITE_SECRET } });
  });

  it('rejects one without the other', () => {
    const onlyKey = resolveWriteKeys({ ...read, WOO_WRITE_CONSUMER_KEY: WRITE_KEY });
    expect(onlyKey.ok).toBe(false);
    expect(JSON.stringify(onlyKey)).toMatch(/WOO_WRITE_CONSUMER_SECRET: empty/);

    const onlySecret = resolveWriteKeys({ ...read, WOO_WRITE_CONSUMER_KEY: '', WOO_WRITE_CONSUMER_SECRET: WRITE_SECRET });
    expect(onlySecret.ok).toBe(false);
    expect(JSON.stringify(onlySecret)).toMatch(/WOO_WRITE_CONSUMER_KEY: empty/);
  });

  it('rejects wrong prefixes (for example key and secret swapped)', () => {
    const swapped = resolveWriteKeys({
      ...read,
      WOO_WRITE_CONSUMER_KEY: WRITE_SECRET,
      WOO_WRITE_CONSUMER_SECRET: WRITE_KEY,
    });
    expect(swapped).toEqual({
      ok: false,
      problems: ['WOO_WRITE_CONSUMER_KEY: must start with ck_', 'WOO_WRITE_CONSUMER_SECRET: must start with cs_'],
    });
  });

  it('rejects the read key used as the write key', () => {
    const same = resolveWriteKeys({
      ...read,
      WOO_WRITE_CONSUMER_KEY: READ_KEY,
      WOO_WRITE_CONSUMER_SECRET: READ_SECRET,
    });
    expect(same.ok).toBe(false);
    expect(JSON.stringify(same)).toMatch(/same as WOO_CONSUMER_KEY/);
  });

  it('never puts a value in a problem message', () => {
    const result = resolveWriteKeys({
      ...read,
      WOO_WRITE_CONSUMER_KEY: 'wrong-value-one',
      WOO_WRITE_CONSUMER_SECRET: 'wrong-value-two',
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/wrong-value/);
  });
});