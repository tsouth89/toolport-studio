import type { OrchestrationEvent } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./threadDetailEvents.ts";

function eventOfType(type: OrchestrationEvent["type"]): OrchestrationEvent {
  return { type } as OrchestrationEvent;
}

describe("isThreadDetailEvent", () => {
  it("forwards the events the client thread reducer projects", () => {
    for (const type of [
      "thread.message-sent",
      "thread.proposed-plan-upserted",
      "thread.activity-appended",
      "thread.turn-diff-completed",
      "thread.reverted",
      "thread.session-set",
    ] as const) {
      expect(isThreadDetailEvent(eventOfType(type))).toBe(true);
    }
  });

  it("forwards queued turn events so the composer queue banner stays live", () => {
    // Without these the client only saw queued turns on a snapshot refetch, and
    // never saw the discard — leaving a queued chip no button could clear.
    expect(isThreadDetailEvent(eventOfType("thread.turn-queued"))).toBe(true);
    expect(isThreadDetailEvent(eventOfType("thread.turn-queue-discarded"))).toBe(true);
  });

  it("drops shell-only events", () => {
    expect(isThreadDetailEvent(eventOfType("thread.meta-updated"))).toBe(false);
    expect(isThreadDetailEvent(eventOfType("thread.archived"))).toBe(false);
  });
});
