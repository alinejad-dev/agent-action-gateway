// The business rules for actions, read from config/policy.json (committed and reviewed like code).
// The file is checked strictly at start-up: an unknown field, a wrong type or an unknown time zone
// stops the server instead of running with rules nobody meant.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import type { OrderStatus } from '../store/adapter.js';

/** Default location: <repo>/config/policy.json (works from src/ with tsx and from dist/). */
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../config/policy.json', import.meta.url));

// Every known order status except 'other': an unknown store status can never be made refundable.
const KNOWN_STATUSES = [
  'pending',
  'processing',
  'on_hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const satisfies readonly OrderStatus[];

/** True if Intl knows this time zone (IANA name like "Europe/Istanbul", "UTC", or an offset like "+03:00"). */
export function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const RefundRulesSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code like "USD"'),
  autoApproveMaxCents: z.int().min(0),
  returnWindowDays: z.int().min(0).max(365),
  // Must match the store's own time zone setting (WordPress: Settings > General > Timezone).
  timeZone: z.string().max(64).refine(isKnownTimeZone, 'unknown time zone'),
  refundableStatuses: z
    .array(z.enum(KNOWN_STATUSES))
    .min(1)
    .refine((list) => new Set(list).size === list.length, 'a status is listed twice'),
  allowPartialRefunds: z.boolean(),
});

const StoreSettingsSchema = z.strictObject({
  // Which store this server acts on. Saved as store_id in every database row, so it uses the same
  // pattern as the database CHECK in migrations/001_init.sql.
  storeId: z.string().regex(/^[a-z0-9_-]{1,64}$/, 'lowercase letters, digits, "_" or "-" (1-64)'),
  deliveredMetaKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "_" or "-" (1-64)'),
  apiRefund: z.boolean(),
  apiRestock: z.boolean(),
});

const PolicyFileSchema = z.strictObject({
  policyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'letters, digits, ".", "_" or "-" (1-40)'),
  refund: RefundRulesSchema,
  store: StoreSettingsSchema,
});

/** What the refund policy sees. policyVersion = label from the file + "+" + 12 hex of the file's sha256. */
export type RefundPolicy = Readonly<
  Omit<z.infer<typeof RefundRulesSchema>, 'refundableStatuses'> & {
    refundableStatuses: readonly OrderStatus[];
    policyVersion: string;
  }
>;

/** Store settings for the adapter (not business rules: the policy never sees them). */
export type StoreSettings = Readonly<z.infer<typeof StoreSettingsSchema>>;

export type LoadedPolicy = Readonly<{ refund: RefundPolicy; store: StoreSettings }>;

export class PolicyFileError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid policy file:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'PolicyFileError';
  }
}

/** Checks the text of a policy file and returns frozen rules. Throws PolicyFileError. */
export function parsePolicyFile(text: string): LoadedPolicy {
  // Same file on Windows (CRLF, BOM) and Linux (LF) = same version.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let json: unknown;
  try {
    json = JSON.parse(normalized);
  } catch {
    throw new PolicyFileError(['the file is not valid JSON']);
  }
  const parsed = PolicyFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new PolicyFileError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(top level)'}: ${issue.message}`),
    );
  }
  // The hash changes with every edit, so an audit row can't point to rules that were changed
  // without a new label.
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  const { policyVersion, refund, store } = parsed.data;
  return Object.freeze({
    refund: Object.freeze({
      ...refund,
      refundableStatuses: Object.freeze([...refund.refundableStatuses]),
      policyVersion: `${policyVersion}+${hash}`,
    }),
    store: Object.freeze({ ...store }),
  });
}

/** Reads and checks the policy file. Throws PolicyFileError if it is missing or invalid. */
export function loadPolicy(path: string = DEFAULT_POLICY_PATH): LoadedPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new PolicyFileError([`cannot read the policy file at ${path}`]);
  }
  return parsePolicyFile(text);
}