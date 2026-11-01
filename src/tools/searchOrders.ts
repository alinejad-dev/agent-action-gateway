import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { searchOrders } from '../woo/orders.js';
import { failFromError, ok } from './envelope.js';

export function registerSearchOrdersTool(server: McpServer): void {
  server.registerTool(
    'search_orders',
    {
      title: 'Search orders',
      description:
        'Find orders by customer name or email when the order ID is unknown. ' +
        'Returns up to 10 matching orders, newest first. Read-only.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .describe('Customer name or email, e.g. "Daniel"'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const orders = await searchOrders(query);
        return ok({ count: orders.length, orders });
      } catch (error) {
        return failFromError(error);
      }
    },
  );
}