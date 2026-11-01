import { getOrder } from '../woo/orders.js';
import { WooError } from '../woo/client.js';

// Diagnostic: read one real order and one that does not exist.
for (const orderId of [20, 999]) {
  try {
    const order = await getOrder(orderId);
    console.log(`Order ${orderId}:`, order);
  } catch (error) {
    if (error instanceof WooError) {
      console.log(`Order ${orderId}: ${error.kind} (${error.message})`);
    } else {
      throw error;
    }
  }
}