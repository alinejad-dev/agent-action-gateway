import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { resolveWriteKeys } from './woo/keys.js';

// Load .env from the project root (not the current working directory),
// because MCP clients like Claude Desktop may start the server from another folder.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const EnvSchema = z.object({
  WOO_BASE_URL: z.url(),
  WOO_CONSUMER_KEY: z.string().startsWith('ck_'),
  WOO_CONSUMER_SECRET: z.string().startsWith('cs_'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration. Check your .env file:');
  for (const issue of parsed.error.issues) {
    // Print only the variable name and the rule — never the value (it may be a secret).
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// Optional second key with Read/Write permissions, used only by action tools
// (least privilege: read tools keep the read-only key above).
// Both variables empty or missing = read-only setup: the server still starts.
const writeKeys = resolveWriteKeys(process.env);

if (!writeKeys.ok) {
  console.error('Invalid configuration. Check your .env file:');
  for (const problem of writeKeys.problems) {
    // The problem text names the variable and the rule, never the value.
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

export const config = parsed.data;

// null when no write key is configured. Code that needs it must handle null (fail closed).
export const wooWriteKeys = writeKeys.keys;