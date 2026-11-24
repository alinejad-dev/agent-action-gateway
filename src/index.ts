import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { config, wooWriteKeys } from './config.js';
import { startRuntime } from './runtime.js';
import { createServer } from './server.js';

// stdio entry point (Claude Code / Claude Desktop launch this as a child process).
// Built once per process: policy, store adapter, database pool. Exits on a broken configuration.
const { refundTool } = startRuntime(
  {
    baseUrl: config.WOO_BASE_URL,
    readKeys: { key: config.WOO_CONSUMER_KEY, secret: config.WOO_CONSUMER_SECRET },
    writeKeys: wooWriteKeys,
    env: process.env,
  },
  'stdio',
);

// When the client closes stdin, the process ends by itself: idle database connections
// do not keep it alive (allowExitOnIdle in poolOptions), and a request in flight still finishes.
void serveStdio(() => createServer(refundTool));
console.error('agent-action-gateway MCP server running on stdio');
console.error(`WooCommerce store: ${config.WOO_BASE_URL}`);