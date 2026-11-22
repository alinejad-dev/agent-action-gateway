// Money as integer cents. Pure functions: no imports, no floating-point arithmetic.

// Optional minus, 1-12 digits, optional dot with 1-2 digits. Nothing else:
// no spaces, no "+", no comma ("1,50" was saved as 150.00 by WooCommerce), no "1e3".
const MONEY = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "18.00" -> 1800, "-18.5" -> -1850, "7" -> 700. Anything else -> null. */
export function parseMoneyToCents(value: string): number | null {
  const match = MONEY.exec(value);
  if (match === null) {
    return null;
  }
  const negative = match[1] === '-';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0');
  // At most 12 digits: the result stays far below Number.MAX_SAFE_INTEGER.
  const cents = Number(whole) * 100 + Number(fraction);
  if (cents === 0) {
    return 0; // never -0
  }
  return negative ? -cents : cents;
}

/** 1800 -> "18.00", 5 -> "0.05". The format WooCommerce expects for an amount. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('formatCents: the amount must be a whole, non-negative number of cents');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * A refund total from WooCommerce as positive cents: "-18.00" -> 1800.
 * A refund created without an amount shows "-" (measured on WooCommerce 11.1.2) -> 0.
 * Anything else that is not money -> null, so the caller can refuse to guess.
 */
export function refundTotalToCents(total: string): number | null {
  if (total === '-') {
    return 0;
  }
  const cents = parseMoneyToCents(total);
  return cents === null ? null : Math.abs(cents);
}