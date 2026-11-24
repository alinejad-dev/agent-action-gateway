import { describe, expect, it } from 'vitest';
import {
  isKnownTimeZone,
  loadPolicy,
  parsePolicyFile,
  PolicyFileError,
} from '../src/policy/policyFile.js';

// A valid file; each invalid case below changes exactly one thing.
function validFile(): Record<string, any> {
  return {
    policyVersion: 'test-1',
    refund: {
      currency: 'USD',
      autoApproveMaxCents: 2500,
      returnWindowDays: 30,
      timeZone: 'UTC',
      refundableStatuses: ['completed'],
      allowPartialRefunds: true,
    },
    store: {
      deliveredMetaKey: 'lumio_delivered_date',
      apiRefund: false,
      apiRestock: false,
    },
  };
}

function problemsOf(text: string): readonly string[] {
  try {
    parsePolicyFile(text);
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyFileError);
    return (error as PolicyFileError).problems;
  }
  throw new Error('expected PolicyFileError');
}

describe('the committed config/policy.json', () => {
  it('loads with the agreed rules', () => {
    const policy = loadPolicy();
    expect(policy.refund).toMatchObject({
      currency: 'USD',
      autoApproveMaxCents: 2500,
      returnWindowDays: 30,
      timeZone: 'UTC', // the store's WordPress setting is UTC+0 (checked Nov 24)
      refundableStatuses: ['completed'],
      allowPartialRefunds: true,
    });
    expect(policy.refund.policyVersion).toMatch(/^2026-11-24\.1\+[0-9a-f]{12}$/);
    expect(policy.store).toEqual({
      deliveredMetaKey: 'lumio_delivered_date',
      apiRefund: false,
      apiRestock: false,
    });
  });
});

describe('parsePolicyFile', () => {
  it('returns the rules, with the store settings kept apart', () => {
    const policy = parsePolicyFile(JSON.stringify(validFile()));
    expect(policy.refund.currency).toBe('USD');
    expect(policy.refund.refundableStatuses).toEqual(['completed']);
    expect(policy.store.deliveredMetaKey).toBe('lumio_delivered_date');
    expect('deliveredMetaKey' in policy.refund).toBe(false);
    expect('apiRefund' in policy.refund).toBe(false);
  });

  it('freezes the result so the rules cannot be changed at runtime', () => {
    const policy = parsePolicyFile(JSON.stringify(validFile()));
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.refund)).toBe(true);
    expect(Object.isFrozen(policy.refund.refundableStatuses)).toBe(true);
    expect(Object.isFrozen(policy.store)).toBe(true);
  });

  it('builds the version from the label and the file hash', () => {
    const text = JSON.stringify(validFile());
    const a = parsePolicyFile(text).refund.policyVersion;
    expect(a).toMatch(/^test-1\+[0-9a-f]{12}$/);
    expect(parsePolicyFile(text).refund.policyVersion).toBe(a);
  });

  it('gives a new version when a rule changes but the label does not', () => {
    const changed = validFile();
    changed.refund.autoApproveMaxCents = 2501;
    const before = parsePolicyFile(JSON.stringify(validFile())).refund.policyVersion;
    const after = parsePolicyFile(JSON.stringify(changed)).refund.policyVersion;
    expect(after.startsWith('test-1+')).toBe(true);
    expect(after).not.toBe(before);
  });

  it('gives the same version for CRLF, BOM and LF copies of the same file', () => {
    const lf = JSON.stringify(validFile(), null, 2);
    const crlf = lf.replace(/\n/g, '\r\n');
    const bom = `\uFEFF${lf}`;
    const version = parsePolicyFile(lf).refund.policyVersion;
    expect(parsePolicyFile(crlf).refund.policyVersion).toBe(version);
    expect(parsePolicyFile(bom).refund.policyVersion).toBe(version);
  });

  it.each(['Europe/Istanbul', 'UTC', 'Etc/UTC', '+03:00'])('accepts the time zone %j', (timeZone) => {
    const file = validFile();
    file.refund.timeZone = timeZone;
    expect(parsePolicyFile(JSON.stringify(file)).refund.timeZone).toBe(timeZone);
  });

  it('accepts several statuses and partial refunds switched off', () => {
    const file = validFile();
    file.refund.refundableStatuses = ['completed', 'processing'];
    file.refund.allowPartialRefunds = false;
    const policy = parsePolicyFile(JSON.stringify(file));
    expect(policy.refund.refundableStatuses).toEqual(['completed', 'processing']);
    expect(policy.refund.allowPartialRefunds).toBe(false);
  });

  it('refuses text that is not JSON', () => {
    expect(problemsOf('{ "policyVersion": ')).toEqual(['the file is not valid JSON']);
  });

  it('refuses a JSON array', () => {
    expect(problemsOf('[]')[0]).toMatch(/^\(top level\): /);
  });

  // [name, change, path that must be named in the problem]
  const invalid: Array<[string, (file: Record<string, any>) => void, string]> = [
    ['unknown top-level field', (f) => { f.extra = 1; }, '(top level)'],
    ['unknown field in refund', (f) => { f.refund.maxRefund = 1; }, 'refund'],
    ['unknown field in store', (f) => { f.store.apiKey = 'x'; }, 'store'],
    ['missing refund section', (f) => { delete f.refund; }, 'refund'],
    ['missing store section', (f) => { delete f.store; }, 'store'],
    ['missing policyVersion', (f) => { delete f.policyVersion; }, 'policyVersion'],
    ['empty policyVersion', (f) => { f.policyVersion = ''; }, 'policyVersion'],
    ['policyVersion with a space', (f) => { f.policyVersion = 'v 1'; }, 'policyVersion'],
    ['policyVersion longer than 40', (f) => { f.policyVersion = 'a'.repeat(41); }, 'policyVersion'],
    ['lowercase currency', (f) => { f.refund.currency = 'usd'; }, 'refund.currency'],
    ['2-letter currency', (f) => { f.refund.currency = 'US'; }, 'refund.currency'],
    ['currency symbol', (f) => { f.refund.currency = '$'; }, 'refund.currency'],
    ['missing currency', (f) => { delete f.refund.currency; }, 'refund.currency'],
    ['negative cap', (f) => { f.refund.autoApproveMaxCents = -1; }, 'refund.autoApproveMaxCents'],
    ['cap with a fraction', (f) => { f.refund.autoApproveMaxCents = 25.5; }, 'refund.autoApproveMaxCents'],
    ['cap as a string', (f) => { f.refund.autoApproveMaxCents = '2500'; }, 'refund.autoApproveMaxCents'],
    ['cap above the safe integer range', (f) => { f.refund.autoApproveMaxCents = 2 ** 53; }, 'refund.autoApproveMaxCents'],
    ['negative window', (f) => { f.refund.returnWindowDays = -1; }, 'refund.returnWindowDays'],
    ['window above 365', (f) => { f.refund.returnWindowDays = 366; }, 'refund.returnWindowDays'],
    ['window with a fraction', (f) => { f.refund.returnWindowDays = 1.5; }, 'refund.returnWindowDays'],
    ['unknown time zone', (f) => { f.refund.timeZone = 'Mars/Base'; }, 'refund.timeZone'],
    ['city without region', (f) => { f.refund.timeZone = 'Istanbul'; }, 'refund.timeZone'],
    ['WordPress-style offset', (f) => { f.refund.timeZone = 'UTC+3'; }, 'refund.timeZone'],
    ['empty time zone', (f) => { f.refund.timeZone = ''; }, 'refund.timeZone'],
    ['empty status list', (f) => { f.refund.refundableStatuses = []; }, 'refund.refundableStatuses'],
    ['status "other"', (f) => { f.refund.refundableStatuses = ['other']; }, 'refund.refundableStatuses.0'],
    ['WooCommerce spelling "on-hold"', (f) => { f.refund.refundableStatuses = ['on-hold']; }, 'refund.refundableStatuses.0'],
    ['status listed twice', (f) => { f.refund.refundableStatuses = ['completed', 'completed']; }, 'refund.refundableStatuses'],
    ['partial flag as a string', (f) => { f.refund.allowPartialRefunds = 'yes'; }, 'refund.allowPartialRefunds'],
    ['meta key with a space', (f) => { f.store.deliveredMetaKey = 'delivered date'; }, 'store.deliveredMetaKey'],
    ['empty meta key', (f) => { f.store.deliveredMetaKey = ''; }, 'store.deliveredMetaKey'],
    ['apiRefund as a string', (f) => { f.store.apiRefund = 'false'; }, 'store.apiRefund'],
    ['missing apiRestock', (f) => { delete f.store.apiRestock; }, 'store.apiRestock'],
  ];

  it.each(invalid)('refuses: %s', (_name, change, path) => {
    const file = validFile();
    change(file);
    const problems = problemsOf(JSON.stringify(file));
    expect(problems.some((problem) => problem.startsWith(`${path}: `))).toBe(true);
  });

  it('lists every problem, not only the first', () => {
    const file = validFile();
    file.refund.currency = 'usd';
    file.store.apiRefund = 'no';
    const problems = problemsOf(JSON.stringify(file));
    expect(problems).toHaveLength(2);
  });
});

describe('loadPolicy', () => {
  it('refuses a missing file with a clear message', () => {
    expect(() => loadPolicy('/no/such/folder/policy.json')).toThrow(
      /cannot read the policy file at \/no\/such\/folder\/policy\.json/,
    );
  });
});

describe('isKnownTimeZone', () => {
  it('knows real zones and refuses made-up ones', () => {
    expect(isKnownTimeZone('Europe/Istanbul')).toBe(true);
    expect(isKnownTimeZone('Mars/Base')).toBe(false);
  });
});