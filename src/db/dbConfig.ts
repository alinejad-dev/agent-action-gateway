// Loads .env and validates the WooCommerce settings first (shared with stdio).
import '../config.js';
import { resolveDbSettings, type DbSettings } from './dbSettings.js';

// For the scripts (migrate, app password, self-test, check-db): they need the database, so anything
// but complete, valid settings stops them here. The server does not import this file: it calls
// resolveDbSettings itself and can run read-only without a database.
const result = resolveDbSettings(process.env);

if (!result.ok || result.settings === null) {
  const problems = result.ok ? ['no DB_* variables are set (the database is not configured)'] : result.problems;
  console.error('Invalid database configuration. Check your .env file:');
  for (const problem of problems) {
    // The problem text names the variable and the rule, never the value (it may be a secret).
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

export const dbConfig: DbSettings = result.settings;