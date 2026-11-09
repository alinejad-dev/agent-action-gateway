import { Pool } from 'pg';
import { dbConfig } from './dbConfig.js';

// One shared pool for the whole process. Creating it does not connect yet:
// connections open on the first query and are reused after that.
export const pool = new Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  password: dbConfig.password,
  // TLS with full verification: the server certificate must be signed by
  // Supabase's CA (verify-full). rejectUnauthorized stays true (the default).
  ssl: { ca: dbConfig.ca },
  max: 5, // the free plan's pooler has a small connection limit
  connectionTimeoutMillis: 10_000, // same 10s budget as the WooCommerce client
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000, // no query may hang forever
});

// An idle connection can fail in the background (network drop, DB restart).
// Without this handler Node would crash the whole server. Log to stderr only.
pool.on('error', (err) => {
  console.error('Database pool error (idle client):', err.message);
});