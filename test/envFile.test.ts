import { describe, expect, it } from 'vitest';
import { EnvFileError, replaceEnvValues, upsertEnvValues } from '../src/scripts/envFile.js';

// Fake values used only in tests.
const UPDATES = { DB_USER: 'gateway_app.projectref', DB_PASSWORD: 'New-Value_123' };

describe('replaceEnvValues', () => {
  it('replaces only the requested lines and keeps everything else', () => {
    const before = [
      '# Database',
      'DB_HOST=db.example.com',
      'DB_USER=postgres.projectref',
      'DB_PASSWORD=old=value with spaces',
      '',
      'OTHER_SECRET=keep-me',
      '',
    ].join('\n');
    const after = [
      '# Database',
      'DB_HOST=db.example.com',
      'DB_USER=gateway_app.projectref',
      'DB_PASSWORD=New-Value_123',
      '',
      'OTHER_SECRET=keep-me',
      '',
    ].join('\n');
    expect(replaceEnvValues(before, UPDATES)).toBe(after);
  });

  it('keeps Windows line endings (CRLF)', () => {
    const before = 'A=1\r\nDB_USER=old\r\nDB_PASSWORD=old\r\nB=2\r\n';
    const after = 'A=1\r\nDB_USER=gateway_app.projectref\r\nDB_PASSWORD=New-Value_123\r\nB=2\r\n';
    expect(replaceEnvValues(before, UPDATES)).toBe(after);
  });

  it('works when the last line has no line ending', () => {
    expect(replaceEnvValues('DB_USER=old\nDB_PASSWORD=old', UPDATES)).toBe(
      'DB_USER=gateway_app.projectref\nDB_PASSWORD=New-Value_123',
    );
  });

  it('ignores commented-out lines and longer names', () => {
    const before = '# DB_PASSWORD=example\nDB_PASSWORD_OLD=x\nDB_USER=old\nDB_PASSWORD=old\n';
    const after = '# DB_PASSWORD=example\nDB_PASSWORD_OLD=x\nDB_USER=gateway_app.projectref\nDB_PASSWORD=New-Value_123\n';
    expect(replaceEnvValues(before, UPDATES)).toBe(after);
  });

  it('fails when a variable is missing', () => {
    expect(() => replaceEnvValues('DB_USER=old\n', UPDATES)).toThrow(EnvFileError);
    expect(() => replaceEnvValues('DB_USER=old\n', UPDATES)).toThrow(/DB_PASSWORD: expected exactly one line.*found 0/);
  });

  it('fails when a variable is set twice (even with a different spelling)', () => {
    const twice = 'DB_USER=old\nDB_PASSWORD=old\n  DB_PASSWORD = pasted-again\n';
    expect(() => replaceEnvValues(twice, UPDATES)).toThrow(/DB_PASSWORD: expected exactly one line.*found 2/);
  });

  it('fails when the only line has leading spaces or "export"', () => {
    expect(() => replaceEnvValues('DB_USER=old\n DB_PASSWORD=old\n', UPDATES)).toThrow(/must start with "DB_PASSWORD="/);
    expect(() => replaceEnvValues('DB_USER=old\nexport DB_PASSWORD=old\n', UPDATES)).toThrow(/must start with/);
  });

  it('refuses new values that would need quoting', () => {
    for (const bad of ['', 'has space', 'has#hash', 'has"quote', 'line\nbreak']) {
      expect(() => replaceEnvValues('DB_USER=old\nDB_PASSWORD=old\n', { DB_PASSWORD: bad })).toThrow(/not safe/);
    }
  });

  it('never puts a value in an error message', () => {
    const text = 'DB_USER=old\nDB_PASSWORD=current-secret\nDB_PASSWORD=second-secret\n';
    try {
      replaceEnvValues(text, UPDATES);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('secret');
      expect(message).not.toContain(UPDATES.DB_PASSWORD);
    }
  });
});

// Fake values used only in tests.
const NEW_KEYS = { WOO_WRITE_CONSUMER_KEY: 'ck_new', WOO_WRITE_CONSUMER_SECRET: 'cs_new' };

describe('upsertEnvValues', () => {
  it('adds missing variables at the end and keeps everything else', () => {
    const before = '# Store\nWOO_CONSUMER_KEY=ck_read\n\nDB_PASSWORD=keep me = as is\n';
    const after = `${before}WOO_WRITE_CONSUMER_KEY=ck_new\nWOO_WRITE_CONSUMER_SECRET=cs_new\n`;
    expect(upsertEnvValues(before, NEW_KEYS)).toBe(after);
  });

  it('adds a line ending first when the last line has none', () => {
    expect(upsertEnvValues('A=1\nB=2', NEW_KEYS)).toBe(
      'A=1\nB=2\nWOO_WRITE_CONSUMER_KEY=ck_new\nWOO_WRITE_CONSUMER_SECRET=cs_new\n',
    );
  });

  it('uses Windows line endings (CRLF) for new lines when the file uses them', () => {
    expect(upsertEnvValues('A=1\r\nB=2\r\n', NEW_KEYS)).toBe(
      'A=1\r\nB=2\r\nWOO_WRITE_CONSUMER_KEY=ck_new\r\nWOO_WRITE_CONSUMER_SECRET=cs_new\r\n',
    );
    expect(upsertEnvValues('A=1\r\nB=2', NEW_KEYS)).toBe(
      'A=1\r\nB=2\r\nWOO_WRITE_CONSUMER_KEY=ck_new\r\nWOO_WRITE_CONSUMER_SECRET=cs_new\r\n',
    );
  });

  it('works on an empty text', () => {
    expect(upsertEnvValues('', NEW_KEYS)).toBe('WOO_WRITE_CONSUMER_KEY=ck_new\nWOO_WRITE_CONSUMER_SECRET=cs_new\n');
  });

  it('replaces a line that exists (also an empty one) and adds only what is missing', () => {
    const before = 'WOO_WRITE_CONSUMER_KEY=\nOTHER=1\n';
    const after = 'WOO_WRITE_CONSUMER_KEY=ck_new\nOTHER=1\nWOO_WRITE_CONSUMER_SECRET=cs_new\n';
    expect(upsertEnvValues(before, NEW_KEYS)).toBe(after);
  });

  it('gives the same result when run twice', () => {
    const once = upsertEnvValues('A=1\n', NEW_KEYS);
    expect(upsertEnvValues(once, NEW_KEYS)).toBe(once);
  });

  it('does not treat a commented-out line or a longer name as the variable', () => {
    const before = '# WOO_WRITE_CONSUMER_KEY=example\nWOO_WRITE_CONSUMER_KEY_OLD=x\n';
    const after = `${before}WOO_WRITE_CONSUMER_KEY=ck_new\nWOO_WRITE_CONSUMER_SECRET=cs_new\n`;
    expect(upsertEnvValues(before, NEW_KEYS)).toBe(after);
  });

  it('fails when a variable is set twice or in another spelling', () => {
    const twice = 'WOO_WRITE_CONSUMER_KEY=a\nWOO_WRITE_CONSUMER_KEY=b\n';
    expect(() => upsertEnvValues(twice, NEW_KEYS)).toThrow(/WOO_WRITE_CONSUMER_KEY: expected exactly one line.*found 2/);
    expect(() => upsertEnvValues(' WOO_WRITE_CONSUMER_KEY=a\n', NEW_KEYS)).toThrow(EnvFileError);
    expect(() => upsertEnvValues('export WOO_WRITE_CONSUMER_KEY=a\n', NEW_KEYS)).toThrow(/must start with/);
  });

  it('refuses unsafe values and never puts a value in an error message', () => {
    expect(() => upsertEnvValues('A=1\n', { WOO_WRITE_CONSUMER_KEY: 'has space' })).toThrow(/not safe/);
    const text = 'WOO_WRITE_CONSUMER_KEY=current-secret\nWOO_WRITE_CONSUMER_KEY=second-secret\n';
    try {
      upsertEnvValues(text, NEW_KEYS);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('secret');
      expect(message).not.toContain('ck_new');
    }
  });
});