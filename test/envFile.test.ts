import { describe, expect, it } from 'vitest';
import { EnvFileError, replaceEnvValues } from '../src/scripts/envFile.js';

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