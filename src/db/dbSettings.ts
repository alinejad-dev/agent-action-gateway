// Database settings from the environment, checked by pure functions: no .env loading,
// no process.exit, no network. The CA file is read through a function that can be passed in,
// so the tests need neither a .env file nor a certificate on disk.
//   no DB_* variable set (missing or empty) -> ok, settings: null (database not configured)
//   all required set and valid, CA readable -> ok, settings
//   anything else                           -> not ok, with one line per problem
// Scripts stop on anything but valid settings (dbConfig.ts). The server can run read-only
// without a database, but refuses to start on a broken configuration (src/runtime.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolConfig } from 'pg';
import * as z from 'zod/v4';

const DB_VARIABLES = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_CA_CERT'] as const;

// Separate fields instead of one URL: a password with special characters
// can't break the connection string, and it never has to be URL-encoded.
const DbEnvSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1).default('postgres'),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_CA_CERT: z.string().min(1),
});

/** Field names match pg's connection options. */
export type DbSettings = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ca: string;
}>;

export type DbSettingsResult =
  | { ok: true; settings: DbSettings | null }
  | { ok: false; problems: string[] };

export type DbSettingsOptions = {
  /** DB_CA_CERT is resolved from here, not from the current working directory. */
  projectRoot?: string;
  readTextFile?: (path: string) => string;
};

// MCP clients may start the server from another folder, so paths start at the project root.
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const CA_PROBLEM = 'DB_CA_CERT: file not found, not readable, or not a PEM certificate';

export function resolveDbSettings(
  env: Readonly<Record<string, string | undefined>>,
  options: DbSettingsOptions = {},
): DbSettingsResult {
  if (DB_VARIABLES.every((name) => (env[name] ?? '') === '')) {
    return { ok: true, settings: null };
  }

  const parsed = DbEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only the variable name and the rule, never the value (it may be a secret).
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }
  const values = parsed.data;

  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let ca: string;
  try {
    ca = readTextFile(resolve(options.projectRoot ?? PROJECT_ROOT, values.DB_CA_CERT));
  } catch {
    return { ok: false, problems: [CA_PROBLEM] };
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    return { ok: false, problems: [CA_PROBLEM] };
  }

  return {
    ok: true,
    settings: Object.freeze({
      host: values.DB_HOST,
      port: values.DB_PORT,
      database: values.DB_NAME,
      user: values.DB_USER,
      password: values.DB_PASSWORD,
      ca,
    }),
  };
}

/** All pool options in one place, shared by the scripts and the server. */
export function poolOptions(settings: DbSettings): PoolConfig {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    // TLS with full verification: the server certificate must be signed by
    // Supabase's CA (verify-full). rejectUnauthorized stays true (the default).
    ssl: { ca: settings.ca },
    max: 5, // the free plan's pooler has a small connection limit
    connectionTimeoutMillis: 10_000, // same 10s budget as the WooCommerce client
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, // no query may hang forever
    // Idle connections do not keep the process alive. Measured: a stdio server whose client closed
    // stdin exited after 30 s without this, at once with it. Scripts still call pool.end() themselves.
    allowExitOnIdle: true,
  };
}

/** Creates a pool. This does not connect yet: connections open on the first query. */
export function createPool(settings: DbSettings): Pool {
  const pool = new Pool(poolOptions(settings));
  // An idle connection can fail in the background (network drop, DB restart).
  // Without this handler Node would crash the whole process. Log to stderr only.
  pool.on('error', (err) => {
    console.error('Database pool error (idle client):', err.message);
  });
  return pool;
}