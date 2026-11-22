// Read-only diagnostic: what the platform-neutral adapter sees for the demo orders.
//   npx tsx src/scripts/check-adapter.ts            (orders 20 to 26)
//   npx tsx src/scripts/check-adapter.ts 20 22      (only these orders)
// Uses ONLY the read key (the adapter gets no write key), so it can never change the store.
// Prints the snapshot the policy will see (no customer data) and checks that findRefund
// answers 'absent' for a request id that was never used.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createWooAdapter } from '../woo/adapter.js';
import { WooError } from '../woo/errors.js';
import { formatCents } from '../woo/money.js';

const DEMO_ORDER_IDS = ['20', '21', '22', '23', '24', '25', '26'];
// The demo store's delivery date meta key. It moves into the policy config in P2-3.
const DELIVERED_META_KEY = 'lumio_delivered_date';

const adapter = createWooAdapter({
  baseUrl: config.WOO_BASE_URL,
  readKeys: { key: config.WOO_CONSUMER_KEY, secret: config.WOO_CONSUMER_SECRET },
  writeKeys: null, // read-only on purpose
  deliveredMetaKey: DELIVERED_META_KEY,
  refundFlags: { apiRefund: false, apiRestock: false }, // not used: no write key
});

const orderIds = process.argv.length > 2 ? process.argv.slice(2) : DEMO_ORDER_IDS;
console.log(`Store: ${config.WOO_BASE_URL} (read key only)`);

for (const orderId of orderIds) {
  try {
    const order = await adapter.getOrder(orderId);
    const refund = await adapter.findRefund({ orderId, requestId: randomUUID() });
    console.log(
      `#${order.orderId}  ${order.status.padEnd(10)} ${order.paid ? 'paid    ' : 'not paid'}  ` +
        `${order.currency} ${formatCents(order.totalCents).padStart(8)}  ` +
        `refunded ${formatCents(order.refundedCents).padStart(8)}  ` +
        `delivered ${order.deliveredOn ?? 'unknown'}  ` +
        `unused request id: ${refund.outcome}`,
    );
  } catch (error) {
    if (error instanceof WooError) {
      console.log(`#${orderId}  ${error.kind}`);
    } else {
      throw error;
    }
  }
}