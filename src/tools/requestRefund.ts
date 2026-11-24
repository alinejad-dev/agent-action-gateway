import type { McpServer } from '@modelcontextprotocol/server';
import { runRefund, type Actor, type RefundFlowDeps } from '../actions/refundFlow.js';
import { RefundInputSchema } from '../actions/refundInput.js';
import { fail, failFromError, ok } from './envelope.js';

/** Built once per process (runtime.ts); the actor is the transport of the entry point. */
export type RefundToolDeps = Readonly<{ flow: RefundFlowDeps; actor: Actor }>;

export const REQUEST_REFUND_DESCRIPTION =
  'Request a refund for one order. The gateway reads the order again, applies the store\'s refund policy, ' +
  'and then records the refund in the store, rejects it, or sends it to a person for approval. ' +
  'Send amount as a string like "18.00" and always send an idempotency_key. ' +
  'Read status and next_step in the answer: they say whether a retry is allowed.';

export function registerRequestRefundTool(server: McpServer, deps: RefundToolDeps): void {
  server.registerTool(
    'request_refund',
    {
      title: 'Request refund',
      description: REQUEST_REFUND_DESCRIPTION,
      inputSchema: RefundInputSchema, // strict: an extra field is refused before this code runs
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // it can record a refund in the store
        idempotentHint: true, // the same idempotency_key and values return the first answer
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const answer = await runRefund(deps.flow, input, deps.actor);
        return answer.ok ? ok(answer.data) : fail(answer.code, answer.message);
      } catch (error) {
        // Database errors and bugs: details to stderr, INTERNAL_ERROR to the model.
        return failFromError(error);
      }
    },
  );
}