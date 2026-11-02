// Loads .env and validates the WooCommerce settings first (shared with stdio).
import '../config.js';
import * as z from 'zod/v4';

// Settings needed ONLY by the HTTP entry point.
// stdio (Claude Code) never imports this file, so it doesn't need a token.
const HttpEnvSchema = z.object({
  MCP_HTTP_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  MCP_HTTP_PORT: z.coerce.number().int().min(1024).max(65535).default(3333),
  MCP_HTTP_HOST: z.ipv4().default('127.0.0.1'),
});

const parsed = HttpEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid HTTP configuration. Check your .env file:');
  for (const issue of parsed.error.issues) {
    // Print only the variable name and the rule — never the value (it may be a secret).
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const httpConfig = parsed.data;