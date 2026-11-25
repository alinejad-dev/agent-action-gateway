import { createInterface } from 'node:readline/promises';
import { pool } from '../db/pool.js';
import { cancelPendingRefund, listPendingRefunds } from '../db/refundRequests.js';
import { loadPolicy } from '../policy/policyFile.js';
import { formatCents } from '../woo/money.js';

// Cancels this store's refund requests that wait for a person (status pending_approval), after "yes".
// Until Phase 3 (Slack approval) nothing else can finish them, and each one locks its order.
// Runs as the app role from .env. Each request is cancelled in its own transaction together with its
// audit entry. Nothing is sent to the store: a pending request never reached it.
// Run: npm run requests:cancel-pending
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const { storeId } = loadPolicy().store;
  const pending = await listPendingRefunds(pool, storeId);
  if (pending.length === 0) {
    console.log(`No refund requests waiting for approval in store ${storeId}. Nothing to do.`);
    return 0;
  }

  console.log(`Refund requests waiting for approval in store ${storeId}:`);
  for (const request of pending) {
    const amount = `${formatCents(request.amountCents)} ${request.currency}`;
    console.log(`  ${request.id}  order ${request.orderId}  ${amount}  created ${request.createdAt.toISOString()}`);
  }
  const answer = await ask(`Type yes to cancel ${pending.length} request(s): `);
  if (answer !== 'yes') {
    console.log('Nothing was changed.');
    return 0;
  }

  let cancelled = 0;
  let errors = 0;
  for (const request of pending) {
    try {
      const result = await cancelPendingRefund(pool, { id: request.id, storeId });
      if (result.outcome === 'cancelled') {
        cancelled += 1;
        console.log(`  cancelled  ${request.id}  order ${request.orderId}`);
      } else {
        console.log(`  skipped (no longer pending)  ${request.id}  order ${request.orderId}`);
      }
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`  ERROR  ${request.id}  order ${request.orderId}: ${message}`);
    }
  }
  console.log(`Cancelled ${cancelled} of ${pending.length}. Nothing was sent to the store.`);
  return errors === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Only the message: the database settings (with the password) are never printed.
    console.error('cancel-pending failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());