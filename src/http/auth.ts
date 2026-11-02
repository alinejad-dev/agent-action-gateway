import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// Hash to a fixed 32-byte length so timingSafeEqual never throws on a length
// mismatch, and the comparison time reveals nothing about the real token.
function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Returns a function that checks "Authorization: Bearer <token>" on a request.
 * Pure (no response writing), so it is easy to unit-test later with Vitest.
 */
export function createBearerCheck(expectedToken: string): (req: IncomingMessage) => boolean {
  const expected = sha256(expectedToken);

  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;

    // The scheme name is case-insensitive per RFC 7235 ("Bearer", "bearer", ...).
    const prefix = 'bearer ';
    if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;

    const token = header.slice(prefix.length).trim();
    if (token.length === 0) return false;

    return timingSafeEqual(sha256(token), expected);
  };
}