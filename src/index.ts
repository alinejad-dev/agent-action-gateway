import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { config } from './config.js';
import { registerGetOrderTool } from './tools/getOrder.js';
import { registerSearchOrdersTool } from './tools/searchOrders.js';

function createServer(): McpServer {
  const server = new McpServer({ name: 'agent-action-gateway', version: '0.1.0' });

  server.registerTool(
    'ping',
    {
      description: 'Health check. Returns "pong", optionally echoing a short message.',
      inputSchema: z.object({
        message: z.string().max(200).optional().describe('Optional text to echo back'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: message ? `pong: ${message}` : 'pong' }],
    }),
  );

  registerGetOrderTool(server);
  registerSearchOrdersTool(server);

  return server;
}

void serveStdio(createServer);
console.error('agent-action-gateway MCP server running on stdio');
console.error(`WooCommerce store: ${config.WOO_BASE_URL}`);