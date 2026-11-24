// The refund policy: a pure function. Same order, same request, same policy, same clock = same answer.
// No database, no store, no network: everything it needs is passed in, so every path can be tested.
// Rules are checked in a fixed order and the first rule that matches decides.

import type { OrderSnapshot } from '../store/adapter.js';
import type { RefundPolicy } from './policyFile.js';

export type RefundRejectCode =
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'ALREADY_REFUNDED'
  | 'NOT_DELIVERED'
  | 'STATUS_NOT_ALLOWED'
  | 'NOT_PAID'
  | 'OUTSIDE_RETURN_WINDOW'
  | 'AMOUNT_EXCEEDS_REMAINING'
  | 'PARTIAL_NOT_ALLOWED';

// Fits gateway.action_requests: decision, reason_code, policy_version.
// A REJECT can only carry a reject code (matches the rejected_means_reject constraint).
export type RefundDecision =
  | { decision: 'AUTO_APPROVE'; reasonCode: 'WITHIN_AUTO_LIMIT'; policyVersion: string }
  | { decision: 'NEEDS_APPROVAL'; reasonCode: 'ABOVE_AUTO_LIMIT'; policyVersion: string }
  | { decision: 'REJECT'; reasonCode: RefundRejectCode; policyVersion: string };

export type RefundAsk = {
  amountCents: number;
  currency: string; // what the caller believes the order is in; must equal the order's currency
};

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" -> days since 1970-01-01, or null if it is not a real calendar date. */
function dayNumber(date: string): number | null {
  const match = CALENDAR_DATE.exec(date);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null; // e.g. 2026-02-30
  }
  return utc / DAY_MS;
}

/** The calendar date ("YYYY-MM-DD") that the clock shows at this moment in this time zone. */
export function calendarDateIn(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function decideRefund(
  order: OrderSnapshot,
  request: RefundAsk,
  policy: RefundPolicy,
  now: Date,
): RefundDecision {
  // Broken inputs are our bug, not a business answer: stop loudly.
  if (Number.isNaN(now.getTime())) {
    throw new Error('decideRefund: invalid clock');
  }
  if (!isCents(order.totalCents) || !isCents(order.refundedCents)) {
    throw new Error('decideRefund: order amounts must be whole, non-negative cents');
  }

  const policyVersion = policy.policyVersion;
  const reject = (reasonCode: RefundRejectCode): RefundDecision => ({
    decision: 'REJECT',
    reasonCode,
    policyVersion,
  });

  // 1. The limits are in the policy's currency; the caller must mean the order's currency.
  if (order.currency !== policy.currency || request.currency !== order.currency) {
    return reject('CURRENCY_MISMATCH');
  }
  // 2. Whole, positive cents only.
  if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
    return reject('INVALID_AMOUNT');
  }
  // 3. Before "not paid": a refunded order has no payment date in WooCommerce (order #24).
  if (order.status === 'refunded' || order.refundedCents >= order.totalCents) {
    return reject('ALREADY_REFUNDED');
  }
  // 4. Before the status rule, so an order on its way (processing) gets the useful answer.
  // Days are counted in the store's time zone; the delivery date has no time.
  const today = dayNumber(calendarDateIn(now, policy.timeZone));
  const delivered = order.deliveredOn === null ? null : dayNumber(order.deliveredOn);
  if (today === null) {
    throw new Error('decideRefund: could not read today in the policy time zone');
  }
  if (delivered === null || delivered > today) {
    return reject('NOT_DELIVERED');
  }
  // 5. Only statuses the policy lists. WooCommerce itself refunds any status.
  if (!policy.refundableStatuses.includes(order.status)) {
    return reject('STATUS_NOT_ALLOWED');
  }
  // 6. WooCommerce refunds unpaid orders too, so we check it ourselves.
  if (!order.paid) {
    return reject('NOT_PAID');
  }
  // 7. Day 0 (delivered today) up to and including returnWindowDays is allowed.
  if (today - delivered > policy.returnWindowDays) {
    return reject('OUTSIDE_RETURN_WINDOW');
  }
  // 8. In cents, on our side: WooCommerce saved "1,50" as 150.00.
  const remainingCents = order.totalCents - order.refundedCents;
  if (request.amountCents > remainingCents) {
    return reject('AMOUNT_EXCEEDS_REMAINING');
  }
  // 9. Partial = less than what is left to refund.
  if (!policy.allowPartialRefunds && request.amountCents < remainingCents) {
    return reject('PARTIAL_NOT_ALLOWED');
  }
  // 10. The cap counts everything refunded on this order, so a large refund
  // can't be split into small automatic ones.
  if (order.refundedCents + request.amountCents > policy.autoApproveMaxCents) {
    return { decision: 'NEEDS_APPROVAL', reasonCode: 'ABOVE_AUTO_LIMIT', policyVersion };
  }
  // 11.
  return { decision: 'AUTO_APPROVE', reasonCode: 'WITHIN_AUTO_LIMIT', policyVersion };
}