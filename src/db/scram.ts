// SCRAM-SHA-256 password verifier, built on the client (the same idea as psql's \password).
// PostgreSQL stores a string in this format as-is, so the plain password never has to be
// sent to the server. Format (PostgreSQL docs: pg_authid.rolpassword, RFC 5803):
//   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
// Pure functions with no project imports, so the tests run without .env.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

// The same values PostgreSQL uses when it hashes a password itself.
const DEFAULT_ITERATIONS = 4096;
const SALT_BYTES = 16;
const KEY_BYTES = 32; // size of a SHA-256 hash

// Printable ASCII without spaces. SCRAM needs extra normalization (SASLprep) for
// non-ASCII passwords; refusing them avoids that whole class of mismatch.
const ASCII_PASSWORD = /^[\x21-\x7e]+$/;

// Shape of a verifier built here. Its alphabet has no quote and no backslash,
// so a string that matches can be placed inside a single-quoted SQL literal.
export const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$[1-9]\d*:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

// 32 random bytes (256 bits) as 43 URL-safe characters: A-Z a-z 0-9 - _
export function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

export function buildScramVerifier(
  password: string,
  salt: Buffer = randomBytes(SALT_BYTES),
  iterations: number = DEFAULT_ITERATIONS,
): string {
  if (!ASCII_PASSWORD.test(password)) {
    throw new Error('password must be printable ASCII without spaces');
  }
  if (salt.length === 0 || !Number.isInteger(iterations) || iterations < 1) {
    throw new Error('invalid salt or iteration count');
  }

  // RFC 5802, section 3:
  //   SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, iterations)
  //   ClientKey      = HMAC(SaltedPassword, "Client Key")
  //   StoredKey      = SHA256(ClientKey)
  //   ServerKey      = HMAC(SaltedPassword, "Server Key")
  const saltedPassword = pbkdf2Sync(password, salt, iterations, KEY_BYTES, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();

  const b64 = (bytes: Buffer): string => bytes.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}