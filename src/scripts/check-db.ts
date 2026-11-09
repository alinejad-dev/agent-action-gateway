import { pool } from '../db/pool.js';

// Manual diagnostic: connects to the database and prints non-secret facts.
// Run: npx tsx src/scripts/check-db.ts
async function main(): Promise<void> {
  const started = Date.now();
  const result = await pool.query<{ db: string; usr: string; version: string; now: Date }>(
    'select current_database() as db, current_user as usr, version() as version, now() as now',
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('query returned no rows');
  }
  console.log('Connected in', Date.now() - started, 'ms');
  console.log('database:   ', row.db);
  console.log('user:       ', row.usr);
  console.log('server:     ', row.version.split(',')[0]);
  console.log('server time:', row.now.toISOString());
}

main()
  .catch((err: unknown) => {
    // Print only the error message, never the config (it contains the password).
    console.error('Database check failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());