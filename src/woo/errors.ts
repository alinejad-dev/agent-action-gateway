// Error types for the WooCommerce client.
// Kept in their own module with NO imports, so code that only needs the error
// type (e.g. envelope.ts, tests) does not load config.ts or require a .env file.

export type WooErrorKind = 'NOT_FOUND' | 'AUTH' | 'UNAVAILABLE' | 'BAD_RESPONSE';

/** The only error type the WooCommerce client throws. Messages never contain secrets. */
export class WooError extends Error {
  readonly kind: WooErrorKind;
  readonly status: number | undefined;

  constructor(kind: WooErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'WooError';
    this.kind = kind;
    this.status = status;
  }
}