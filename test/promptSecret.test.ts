import { describe, expect, it } from 'vitest';
import { cleanSecretInput, feedSecretInput } from '../src/scripts/promptSecret.js';

describe('feedSecretInput', () => {
  it('collects a paste that arrives as one chunk and waits for Enter', () => {
    expect(feedSecretInput('', 'ck_abc123')).toEqual({ state: 'more', buffer: 'ck_abc123' });
  });

  it('collects typing that arrives one character at a time', () => {
    let buffer = '';
    for (const char of 'cs_9f') {
      buffer = feedSecretInput(buffer, char).buffer;
    }
    expect(buffer).toBe('cs_9f');
  });

  it('finishes on Enter (CR on Windows, LF on Linux) and drops what follows', () => {
    expect(feedSecretInput('ck_abc', '\r')).toEqual({ state: 'done', buffer: 'ck_abc' });
    expect(feedSecretInput('ck_abc', '\n')).toEqual({ state: 'done', buffer: 'ck_abc' });
    expect(feedSecretInput('', 'ck_abc\r\nsecond line')).toEqual({ state: 'done', buffer: 'ck_abc' });
  });

  it('cancels on Ctrl+C and Ctrl+D and forgets what was entered', () => {
    expect(feedSecretInput('ck_abc', '\u0003')).toEqual({ state: 'cancelled', buffer: '' });
    expect(feedSecretInput('ck_abc', '\u0004')).toEqual({ state: 'cancelled', buffer: '' });
  });

  it('handles Backspace', () => {
    expect(feedSecretInput('ck_abcX', '\u007f')).toEqual({ state: 'more', buffer: 'ck_abc' });
    expect(feedSecretInput('ck_abcX', '\b')).toEqual({ state: 'more', buffer: 'ck_abc' });
    expect(feedSecretInput('', '\u007f')).toEqual({ state: 'more', buffer: '' });
  });
});

describe('cleanSecretInput', () => {
  it('keeps a normal value unchanged', () => {
    expect(cleanSecretInput('ck_0123456789abcdef')).toBe('ck_0123456789abcdef');
  });

  it('removes spaces and tabs around the value', () => {
    expect(cleanSecretInput('  ck_abc \t')).toBe('ck_abc');
  });

  it('removes bracketed-paste markers and other escape sequences', () => {
    expect(cleanSecretInput('\u001b[200~ck_abc\u001b[201~')).toBe('ck_abc');
    expect(cleanSecretInput('ck_\u001b[Aabc')).toBe('ck_abc');
  });

  it('removes stray control characters', () => {
    expect(cleanSecretInput('\u0016ck_abc\u0000')).toBe('ck_abc');
  });
});