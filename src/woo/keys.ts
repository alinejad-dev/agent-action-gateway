// Rules for WooCommerce REST API keys. Pure functions (no .env, no network), unit-tested.
// Messages name the variable and the rule, never a value (values are secrets).

export type WooKeyPair = { key: string; secret: string };

// WooCommerce generates "ck_" / "cs_" followed by 40 hex characters (43 in total).
// This strict form is only used where a person enters a key (set-woo-write-key.ts).
// The server itself only checks the prefix, so a format change in WooCommerce
// cannot stop it from starting.
const STRICT = /^c[ks]_[0-9a-f]{40}$/;

export type KeyPart = 'key' | 'secret';

// Returns null when the value looks like a real key, otherwise what is wrong with it.
export function describeKeyProblem(part: KeyPart, value: string): string | null {
  const prefix = part === 'key' ? 'ck_' : 'cs_';
  const otherPrefix = part === 'key' ? 'cs_' : 'ck_';
  const name = part === 'key' ? 'consumer key' : 'consumer secret';

  if (value.length === 0) {
    return 'nothing was entered';
  }
  if (value.startsWith(otherPrefix)) {
    const otherName = part === 'key' ? 'consumer secret' : 'consumer key';
    return `this starts with ${otherPrefix}, so it is the ${otherName}, not the ${name}`;
  }
  if (!value.startsWith(prefix)) {
    return `a ${name} starts with ${prefix} (got ${value.length} characters with another start)`;
  }
  if (!STRICT.test(value)) {
    return `expected ${prefix} plus 40 characters 0-9 a-f = 43 characters (got ${value.length} characters)`;
  }
  return null;
}

export type WriteKeysResult =
  | { ok: true; keys: WooKeyPair | null }
  | { ok: false; problems: string[] };

// The optional write key from the environment.
//   both empty or missing -> ok, keys: null (read-only setup, action tools have no store access)
//   both set and valid    -> ok, keys: { key, secret }
//   anything else         -> not ok, with one line per problem
export function resolveWriteKeys(env: Record<string, string | undefined>): WriteKeysResult {
  const key = env.WOO_WRITE_CONSUMER_KEY ?? '';
  const secret = env.WOO_WRITE_CONSUMER_SECRET ?? '';

  if (key === '' && secret === '') {
    return { ok: true, keys: null };
  }

  const problems: string[] = [];
  if (key === '') {
    problems.push('WOO_WRITE_CONSUMER_KEY: empty, but WOO_WRITE_CONSUMER_SECRET is set (set both or neither)');
  } else if (!key.startsWith('ck_')) {
    problems.push('WOO_WRITE_CONSUMER_KEY: must start with ck_');
  } else if (key === env.WOO_CONSUMER_KEY) {
    problems.push('WOO_WRITE_CONSUMER_KEY: is the same as WOO_CONSUMER_KEY (the read key)');
  }
  if (secret === '') {
    problems.push('WOO_WRITE_CONSUMER_SECRET: empty, but WOO_WRITE_CONSUMER_KEY is set (set both or neither)');
  } else if (!secret.startsWith('cs_')) {
    problems.push('WOO_WRITE_CONSUMER_SECRET: must start with cs_');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, keys: { key, secret } };
}