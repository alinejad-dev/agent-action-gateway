import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildScramVerifier, generatePassword, SCRAM_VERIFIER } from '../src/db/scram.js';

// Splits "SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>" into its parts.
function parts(verifier: string): { iterations: string; salt: Buffer; storedKey: Buffer; serverKey: Buffer } {
  const [scheme, info = '', keys = ''] = verifier.split('$');
  const [iterations = '', salt = ''] = info.split(':');
  const [storedKey = '', serverKey = ''] = keys.split(':');
  expect(scheme).toBe('SCRAM-SHA-256');
  return {
    iterations,
    salt: Buffer.from(salt, 'base64'),
    storedKey: Buffer.from(storedKey, 'base64'),
    serverKey: Buffer.from(serverKey, 'base64'),
  };
}

describe('buildScramVerifier', () => {
  // Expected value produced by PostgreSQL 16 itself, not by our code:
  //   create role scram_vec password 'Test-Only_Password.123';
  //   select rolpassword from pg_authid where rolname = 'scram_vec';
  // (A fake password, used only in this test.)
  it('reproduces the verifier PostgreSQL generated for the same password and salt', () => {
    const fromPostgres =
      'SCRAM-SHA-256$4096:ojJIHrs3hTagrGVCnOiU+Q==' +
      '$URYVcLYUlBRPqW1GtXW62WaTQWklydiRuLd0deI3LvE=:JYqmz+DpFpQDrYsr8QihB+SYIGycimeabioe3FTi5Ho=';
    const salt = Buffer.from('ojJIHrs3hTagrGVCnOiU+Q==', 'base64');
    expect(buildScramVerifier('Test-Only_Password.123', salt, 4096)).toBe(fromPostgres);
  });

  // Published example exchange from RFC 7677, section 3 (user "user", password "pencil").
  // The RFC gives the client proof and the server signature; both must follow from our keys.
  it('agrees with the RFC 7677 example exchange', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const { storedKey, serverKey } = parts(buildScramVerifier('pencil', salt, 4096));

    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;

    // ServerSignature = HMAC(ServerKey, AuthMessage)
    const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');

    // ClientKey = ClientProof XOR HMAC(StoredKey, AuthMessage), and StoredKey = SHA256(ClientKey)
    const clientProof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(clientProof.map((byte, i) => byte ^ (clientSignature[i] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest('base64')).toBe(storedKey.toString('base64'));
  });

  it('uses the PostgreSQL defaults: 4096 iterations, 16-byte salt, 32-byte keys', () => {
    const verifier = buildScramVerifier(generatePassword());
    const p = parts(verifier);
    expect(verifier).toMatch(SCRAM_VERIFIER);
    expect(p.iterations).toBe('4096');
    expect(p.salt).toHaveLength(16);
    expect(p.storedKey).toHaveLength(32);
    expect(p.serverKey).toHaveLength(32);
  });

  it('uses a fresh random salt every time', () => {
    expect(buildScramVerifier('same-password')).not.toBe(buildScramVerifier('same-password'));
  });

  it('never contains the password, a quote or a backslash', () => {
    const password = generatePassword();
    const verifier = buildScramVerifier(password);
    expect(verifier).not.toContain(password);
    expect(verifier).not.toMatch(/['\\]/);
  });

  it('rejects passwords that would need SASLprep or are empty', () => {
    expect(() => buildScramVerifier('')).toThrow();
    expect(() => buildScramVerifier('with space')).toThrow();
    expect(() => buildScramVerifier('p\u00e4ssword')).toThrow();
  });

  it('rejects an empty salt and a bad iteration count', () => {
    expect(() => buildScramVerifier('pencil', Buffer.alloc(0))).toThrow();
    expect(() => buildScramVerifier('pencil', Buffer.alloc(16), 0)).toThrow();
    expect(() => buildScramVerifier('pencil', Buffer.alloc(16), 1.5)).toThrow();
  });
});

describe('generatePassword', () => {
  it('returns 43 URL-safe characters (256 bits)', () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('returns a different value every time', () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});