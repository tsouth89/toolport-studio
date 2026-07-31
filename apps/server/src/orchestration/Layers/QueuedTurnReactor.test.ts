import { MessageId, TurnId } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasUnadoptedTurnStart } from "./QueuedTurnReactor.ts";

describe("hasUnadoptedTurnStart", () => {
  it("blocks the next queued drain until the previous user message is adopted", () => {
    expect(
      hasUnadoptedTurnStart({
        messages: [
          {
            id: MessageId.make("queued-one"),
            role: "user",
            text: "first",
            turnId: null,
            streaming: false,
            createdAt: "2026-07-31T12:01:00.000Z",
            updatedAt: "2026-07-31T12:01:00.000Z",
          },
        ],
        latestTurn: {
          turnId: TurnId.make("active-turn"),
          state: "completed",
          requestedAt: "2026-07-31T12:00:00.000Z",
          startedAt: "2026-07-31T12:00:00.000Z",
          completedAt: "2026-07-31T12:00:30.000Z",
          assistantMessageId: null,
        },
      }),
    ).toBe(true);
  });

  it("allows the next drain after the provider adopts the previous message", () => {
    expect(
      hasUnadoptedTurnStart({
        messages: [
          {
            id: MessageId.make("queued-one"),
            role: "user",
            text: "first",
            turnId: null,
            streaming: false,
            createdAt: "2026-07-31T12:01:00.000Z",
            updatedAt: "2026-07-31T12:01:00.000Z",
          },
        ],
        latestTurn: {
          turnId: TurnId.make("queued-turn"),
          state: "completed",
          requestedAt: "2026-07-31T12:01:01.000Z",
          startedAt: "2026-07-31T12:01:01.000Z",
          completedAt: "2026-07-31T12:02:00.000Z",
          assistantMessageId: null,
        },
      }),
    ).toBe(false);
  });
});
