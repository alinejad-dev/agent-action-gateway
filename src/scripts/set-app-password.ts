// Sets (or rotates) the password of the app role "gateway_app" (admin tool, never imported by the server).
//   npm run app-password:status  -> read-only: shows the role and whether .env is ready
//   npm run app-password:rotate  -> new random password: role gets LOGIN, .env gets the new login
// The plain password is generated here and never leaves this machine: the database only
// receives a SCRAM-SHA-256 verifier (like psql's \password). It is never printed.
// Admin credentials come from .env.admin, which the server never loads.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as z from 'zod/v4';
import { dbConfig } from '../db/dbConfig.js';
import { buildScramVerifier, generatePassword, SCRAM_VERIFIER } from '../db/scram.js';
import { replaceEnvValues } from './envFile.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const envPath = resolve(projectRoot, '.env');
const envTempPath = resolve(projectRoot, '.env.tmp'); // gitignored by ".env.*"

// Fixed in code, never taken from input (it is placed inside the SQL statement).
const APP_ROLE = 'gateway_app';

// After a password change the Supabase pooler may reject the new password for a
// few seconds (cached credentials). Few attempts on purpose: many failed logins
// in a row can trip the pooler's circuit breaker.
const LOGIN_ATTEMPTS = 4;
const LOGIN_RETRY_MS = 5_000;

class ScriptError extends Error {}

type RoleRow = { rolcanlogin: boolean; rolconnlimit: number; rolsuper: boolean; rolbypassrls: boolean };

// ---------- 1. Arguments and admin credentials ----------

const mode = process.argv[2];
if (mode !== 'status' && mode !== 'rotate') {
  console.error('Usage: tsx src/scripts/set-app-password.ts <status|rotate>');
  process.exit(1);
}

try {
  process.loadEnvFile(resolve(projectRoot, '.env.admin'));
} catch {
  console.error('Missing .env.admin (admin credentials). See docs/database.md.');
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

// Supabase's shared pooler wants "<role>.<project-ref>" as the user name.
// Reuse the suffix of the admin user: "postgres.abc" -> "gateway_app.abc".
// A plain "postgres" (direct connection, local Postgres) gives plain "gateway_app".
const dot = admin.DB_ADMIN_USER.indexOf('.');
const appUser = dot === -1 ? APP_ROLE : `${APP_ROLE}${admin.DB_ADMIN_USER.slice(dot)}`;

// ---------- 2. The .env file ----------

function readEnvFile(): string {
  try {
    return readFileSync(envPath, 'utf8');
  } catch {
    throw new ScriptError('Cannot read .env in the project root.');
  }
}

// Throws if .env does not have exactly one DB_USER line and one DB_PASSWORD line.
function withAppLogin(envText: string, password: string): string {
  return replaceEnvValues(envText, { DB_USER: appUser, DB_PASSWORD: password });
}

// Write a temporary file first, then rename it over .env: a crash in the middle
// can never leave a half-written .env (it also holds the WooCommerce keys).
function writeEnvFile(text: string): void {
  try {
    writeFileSync(envTempPath, text, 'utf8');
    renameSync(envTempPath, envPath);
  } catch (error) {
    try {
      rmSync(envTempPath, { force: true });
    } catch {
      // Keep the original error; a leftover .env.tmp is gitignored.
    }
    throw error;
  }
}

// ---------- 3. Database ----------

const client = new pg.Client({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: admin.DB_ADMIN_USER,
  password: admin.DB_ADMIN_PASSWORD,
  ssl: { ca: dbConfig.ca }, // verify-full, same as the app pool
  application_name: 'gateway-set-app-password',
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

async function readRole(): Promise<RoleRow> {
  const res = await client.query<RoleRow>(
    'select rolcanlogin, rolconnlimit, rolsuper, rolbypassrls from pg_roles where rolname = $1',
    [APP_ROLE],
  );
  const row = res.rows[0];
  if (!row) {
    throw new ScriptError(`Role ${APP_ROLE} does not exist. Run "npm run migrate:apply" first.`);
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new ScriptError(`Role ${APP_ROLE} is superuser or bypasses RLS. Refusing to give it a login.`);
  }
  return row;
}

function describeRole(row: RoleRow): string {
  return `login ${row.rolcanlogin ? 'enabled' : 'disabled'}, connection limit ${row.rolconnlimit}`;
}

// One login as the app user with the new password, over the same host and TLS settings.
async function loginOnce(password: string): Promise<string> {
  const app = new pg.Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: appUser,
    password,
    ssl: { ca: dbConfig.ca },
    application_name: 'gateway-set-app-password-check',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  // A failed login can also be reported as an 'error' event; without a listener Node would crash.
  app.on('error', () => {});
  try {
    await app.connect();
    const res = await app.query<{ usr: string }>('select current_user as usr');
    return res.rows[0]?.usr ?? '';
  } finally {
    await app.end().catch(() => {});
  }
}

// Returns true when the login worked. Retries only "wrong password" (28P01), a few times.
async function checkLogin(password: string): Promise<boolean> {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    try {
      const usr = await loginOnce(password);
      console.log(`Login check as ${appUser}: OK (current_user = ${usr})`);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      console.log(`Login check ${attempt}/${LOGIN_ATTEMPTS} failed: ${describe(error)}`);
      if (code !== '28P01' || attempt === LOGIN_ATTEMPTS) {
        return false;
      }
      console.log(`  The pooler may still cache the old credentials. Waiting ${LOGIN_RETRY_MS / 1000}s ...`);
      await new Promise((done) => setTimeout(done, LOGIN_RETRY_MS));
    }
  }
  return false;
}

// ---------- 4. The two modes ----------

async function showStatus(): Promise<void> {
  const role = await readRole();
  console.log(`Role ${APP_ROLE}: ${describeRole(role)}`);
  console.log(`App login user: ${appUser}`);

  const envText = readEnvFile();
  withAppLogin(envText, 'placeholder'); // Throws if .env is not ready. Nothing is written.
  const usesAppUser = envText.split(/\r?\n/).includes(`DB_USER=${appUser}`);
  console.log(`.env: DB_USER and DB_PASSWORD lines found. DB_USER is ${usesAppUser ? '' : 'NOT yet '}the app user.`);
  console.log('Run "npm run app-password:rotate" to set a new password and update .env.');
}

async function rotate(): Promise<void> {
  // Everything that can fail without touching the database comes first.
  const envText = readEnvFile();
  withAppLogin(envText, 'placeholder');
  const role = await readRole();
  console.log(`Role ${APP_ROLE} before: ${describeRole(role)}`);

  const password = generatePassword();
  const verifier = buildScramVerifier(password);
  if (!SCRAM_VERIFIER.test(verifier)) {
    throw new ScriptError('Internal error: verifier has an unexpected format. Nothing was changed.');
  }

  // One transaction: the database only keeps the new password if .env was written too.
  await client.query('BEGIN');
  let envWritten = false;
  try {
    // ALTER ROLE takes no bind parameters. The role name is a constant, and the verifier
    // was just checked against a pattern without quotes or backslashes.
    await client.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${verifier}'`);
    writeEnvFile(withAppLogin(envText, password));
    envWritten = true;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (envWritten) {
      throw new ScriptError(
        '.env was updated, but the database did not confirm the change. ' +
          'Run "npm run app-password:rotate" again.',
      );
    }
    console.error('Rolled back: the database password and .env were not changed.');
    throw error;
  }
  console.log(`Role ${APP_ROLE}: LOGIN enabled, new password set (only a SCRAM verifier was sent).`);
  console.log(`.env updated: DB_USER=${appUser}, DB_PASSWORD=<${password.length} characters, not shown>`);

  if (await checkLogin(password)) {
    console.log('Done. Restart any running server so it uses the new password.');
    console.log('Next: npx tsx src/scripts/check-db.ts');
  } else {
    console.log('The password is set and saved in .env, but the login check did not pass.');
    console.log('Do NOT rotate again right away. Wait 2 minutes, then run: npx tsx src/scripts/check-db.ts');
    process.exitCode = 1;
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = (error as Error & { code?: string }).code;
  return code ? `${error.message} (code ${code})` : error.message;
}

async function main(): Promise<void> {
  console.log(`Connecting to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database} as ${admin.DB_ADMIN_USER} (TLS verify-full)`);
  await client.connect();
  try {
    if (mode === 'status') {
      await showStatus();
    } else {
      await rotate();
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Failed: ${describe(error)}`);
  process.exitCode = 1;
});