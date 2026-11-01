import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getOrder } from '../woo/orders.js';
import { failFromError, ok } from './envelope.js';

export function registerGetOrderTool(server: McpServer): void {
  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        'Look up one store order by its numeric ID. Returns status, total, items, ' +
        'refunded amount and the customer first name. Read-only.',
      inputSchema: z.object({
        order_id: z
          .number()
          .int()
          .positive()
          .max(1_000_000_000)
          .describe('The numeric WooCommerce order ID, e.g. 20'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ order_id }) => {
      try {
        return ok(await getOrder(order_id));
      } catch (error) {
        return failFromError(error);
      }
    },
  );
}