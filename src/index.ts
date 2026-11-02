import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config } from './config.js';
import { createServer } from './server.js';

// stdio entry point (Claude Code / Claude Desktop launch this as a child process).
void serveStdio(createServer);
console.error('agent-action-gateway MCP server running on stdio');
console.error(`WooCommerce store: ${config.WOO_BASE_URL}`);