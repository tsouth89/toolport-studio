import type { OrchestrationEvent } from "@toolport-studio/contracts";

/**
 * Event types the per-thread detail subscription forwards to clients.
 *
 * Anything the client thread reducer projects into thread detail state must be
 * listed here, otherwise the client only learns about it on the next snapshot
 * refetch. Queued turns were missing (SOU): the composer queue banner reads
 * `thread.queuedTurns`, so queue/discard events that never reached the client
 * left a queued chip on screen that Send now / Remove / Clear queue could not
 * clear — the server had already drained the queue.
 */
const THREAD_DETAIL_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.message-sent",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
  "thread.turn-queued",
  "thread.turn-queue-discarded",
]);

export function isThreadDetailEvent(event: OrchestrationEvent): boolean {
  return THREAD_DETAIL_EVENT_TYPES.has(event.type);
}
