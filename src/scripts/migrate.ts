// Database migration runner (admin tool, never imported by the server).
//   npm run migrate:status  -> read-only: shows applied and pending migrations
//   npm run migrate:apply   -> applies all pending migrations in ONE transaction
// Admin credentials come from .env.admin, which the server never loads.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as z from 'zod/v4';
import { dbConfig } from '../db/dbConfig.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = resolve(projectRoot, 'migrations');

// Any fixed number works; every runner just has to use the same one.
const LOCK_ID = 7340001;

// File names: 001_init.sql, 002_add_something.sql, ...
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

// The runner owns the transaction, so files must not control it.
// (A plpgsql "BEGIN" has no semicolon on its line, so function bodies are fine.)
const TX_CONTROL = /^\s*(begin|start\s+transaction|commit|rollback|abort)\b[^\n]*;/im;

// Created by the runner itself, before any migration runs.
const BOOTSTRAP_SQL = `
create schema if not exists gateway;
create table if not exists gateway.schema_migrations (
  version    text primary key,
  file       text not null,
  checksum   text not null,
  applied_at timestamptz not null default now()
);`;

type Migration = { version: string; file: string; sql: string; checksum: string };
type AppliedRow = { version: string; file: string; checksum: string; applied_at: Date };

class MigrationError extends Error {}

// ---------- 1. Arguments and admin credentials ----------

const mode = process.argv[2];
if (mode !== 'status' && mode !== 'apply') {
  console.error('Usage: tsx src/scripts/migrate.ts <status|apply>');
  process.exit(1);
}

try {
  process.loadEnvFile(resolve(projectRoot, '.env.admin'));
} catch {
  console.error('Missing .env.admin (admin credentials for migrations). See docs/database.md.');
  process.exit(1);
}

const AdminEnvSchema = z.object({
  DB_ADMIN_USER: z.string().min(1),
  DB_ADMIN_PASSWORD: z.string().min(1),
});

const adminParsed = AdminEnvSchema.safeParse(process.env);
if (!adminParsed.success) {
  console.error('Invalid admin configuration. Check your .env.admin file:');
  for (const issue of adminParsed.error.issues) {
    // Only the variable name and the rule, never the value.
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const admin = adminParsed.data;

// ---------- 2. Migration files ----------

function loadMigrations(): Migration[] {
  let names: string[];
  try {
    names = readdirSync(migrationsDir);
  } catch {
    return []; // No migrations/ folder yet.
  }

  const migrations: Migration[] = [];
  for (const file of names.filter((n) => n.endsWith('.sql')).sort()) {
    const match = FILE_NAME.exec(file);
    if (!match?.[1]) {
      throw new MigrationError(`${file}: invalid name (expected e.g. 001_init.sql)`);
    }
    // Normalize BOM and Windows line endings, so the checksum is the same on every OS.
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
    if (TX_CONTROL.test(sql)) {
      throw new MigrationError(`${file}: must not contain BEGIN/COMMIT/ROLLBACK (the runner owns the transaction)`);
    }
    if (migrations.some((m) => m.version === match[1])) {
      throw new MigrationError(`${file}: version ${match[1]} is used twice`);
    }
    const checksum = createHash('sha256').update(sql).digest('hex');
    migrations.push({ version: match[1], file, sql, checksum });
  }
  return migrations;
}

// Applied migrations must still exist and be unchanged. Returns the pending ones.
function plan(local: Migration[], applied: Map<string, AppliedRow>): Migration[] {
  for (const row of applied.values()) {
    const m = local.find((l) => l.version === row.version);
    if (!m) {
      throw new MigrationError(`${row.file} is applied in the database but missing in migrations/`);
    }
    if (m.checksum !== row.checksum) {
      throw new MigrationError(`${m.file} was changed after it was applied. Write a new migration instead.`);
    }
  }
  return local.filter((m) => !applied.has(m.version));
}

// ---------- 3. Database ----------

const client = new pg.Client({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: admin.DB_ADMIN_USER,
  password: admin.DB_ADMIN_PASSWORD,
  ssl: { ca: dbConfig.ca }, // verify-full, same as the app pool
  application_name: 'gateway-migrate',
  connectionTimeoutMillis: 10_000,
  statement_timeout: 60_000,
});

async function readApplied(): Promise<Map<string, AppliedRow>> {
  const exists = await client.query<{ t: string | null }>(
    "select to_regclass('gateway.schema_migrations')::text as t",
  );
  if (!exists.rows[0]?.t) {
    return new Map(); // Never applied anything yet.
  }
  const res = await client.query<AppliedRow>(
    'select version, file, checksum, applied_at from gateway.schema_migrations order by version',
  );
  return new Map(res.rows.map((r) => [r.version, r]));
}

async function showStatus(local: Migration[]): Promise<void> {
  const applied = await readApplied();
  const pending = plan(local, applied);
  if (local.length === 0) {
    console.log('No migration files in migrations/.');
  }
  for (const m of local) {
    const row = applied.get(m.version);
    console.log(`  ${m.file.padEnd(32)} ${row ? `applied ${row.applied_at.toISOString()}` : 'PENDING'}`);
  }
  console.log(`Applied: ${applied.size}, pending: ${pending.length}.`);
  if (pending.length > 0) {
    console.log('Run "npm run migrate:apply" to apply the pending migrations.');
  }
}

let current: Migration | undefined; // For error messages.

async function apply(local: Migration[]): Promise<void> {
  await client.query('BEGIN');
  try {
    // Two runners at the same time: the second one waits here.
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(BOOTSTRAP_SQL);
    const pending = plan(local, await readApplied());

    for (const m of pending) {
      current = m;
      console.log(`  applying ${m.file} ...`);
      await client.query(m.sql);
      await client.query(
        'insert into gateway.schema_migrations (version, file, checksum) values ($1, $2, $3)',
        [m.version, m.file, m.checksum],
      );
    }
    current = undefined;

    await client.query('COMMIT');
    console.log(pending.length > 0 ? `Done: applied ${pending.length} migration(s).` : 'Nothing to apply.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Rolled back: nothing was changed.');
    throw error;
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error instanceof MigrationError) {
    return error.message;
  }
  const pgError = error as Error & { code?: string; position?: string };
  let text = pgError.message;
  if (pgError.code) {
    text += ` (code ${pgError.code})`;
  }
  if (pgError.position && current) {
    const line = current.sql.slice(0, Number(pgError.position) - 1).split('\n').length;
    text += ` in ${current.file}, line ${line}`;
  }
  return text;
}

async function main(): Promise<void> {
  const local = loadMigrations();
  console.log(`Connecting to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database} as ${admin.DB_ADMIN_USER} (TLS verify-full)`);
  await client.connect();
  try {
    if (mode === 'status') {
      await showStatus(local);
    } else {
      await apply(local);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${describe(error)}`);
  process.exitCode = 1;
});