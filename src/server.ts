import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { registerGetOrderTool } from './tools/getOrder.js';
import { registerRequestRefundTool, type RefundToolDeps } from './tools/requestRefund.js';
import { registerSearchOrdersTool } from './tools/searchOrders.js';

/**
 * Builds a fresh MCP server with all tools registered.
 * Shared by both entry points: stdio (index.ts) and HTTP (http.ts).
 * Over HTTP this runs once per request, so it must stay cheap and side-effect free:
 * the refund tool's pool, adapter and policy are built once per process (runtime.ts) and passed in.
 * refund = null: request_refund is not offered at all (no write key or no database).
 */
export function createServer(refund: RefundToolDeps | null): McpServer {
  const server = new McpServer({ name: 'agent-action-gateway', version: '0.1.0' });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
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
  if (refund !== null) {
    registerRequestRefundTool(server, refund);
  }

  return server;
}