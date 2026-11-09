// Loads .env and validates the WooCommerce settings first (shared with stdio).
import '../config.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';

// Database settings (Supabase Postgres via the session pooler).
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

const parsed = DbEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid database configuration. Check your .env file:');
  for (const issue of parsed.error.issues) {
    // Print only the variable name and the rule — never the value (it may be a secret).
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Resolve the certificate path from the project root, not the current working directory
// (same reason as .env: MCP clients may start the server from another folder).
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function readCaCertificate(): string {
  try {
    const pem = readFileSync(resolve(projectRoot, env.DB_CA_CERT), 'utf8');
    if (pem.includes('-----BEGIN CERTIFICATE-----')) {
      return pem;
    }
  } catch {
    // Fall through to the error below.
  }
  console.error('Invalid database configuration. Check your .env file:');
  console.error('  - DB_CA_CERT: file not found, not readable, or not a PEM certificate');
  process.exit(1);
}

// Field names match pg's connection options, so this can be passed to the pool directly.
export const dbConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ca: readCaCertificate(),
};