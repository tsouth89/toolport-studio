import { describe, expect, it } from "vite-plus/test";

import { hasRunningTask } from "./RunningTaskCloseGuard";

const thread = (
  status: "ready" | "running" | "starting",
  latestTurn?: {
    state: "completed" | "running";
    startedAt: string;
    completedAt: string | null;
    turnId: string;
  },
) =>
  ({
    session: {
      status,
      activeTurnId: latestTurn?.turnId ?? null,
    },
    latestTurn: latestTurn ?? null,
  }) as Parameters<typeof hasRunningTask>[0][number];

describe("hasRunningTask", () => {
  it("guards close while a task is starting or running", () => {
    expect(hasRunningTask([thread("starting")])).toBe(true);
    expect(
      hasRunningTask([
        thread("running", {
          state: "running",
          startedAt: "2026-07-30T12:00:00.000Z",
          completedAt: null,
          turnId: "turn-running",
        }),
      ]),
    ).toBe(true);
  });

  it("does not guard close for idle or stale completed sessions", () => {
    expect(hasRunningTask([thread("ready")])).toBe(false);
    expect(
      hasRunningTask([
        thread("running", {
          state: "completed",
          startedAt: "2026-07-30T12:00:00.000Z",
          completedAt: "2026-07-30T12:01:00.000Z",
          turnId: "turn-complete",
        }),
      ]),
    ).toBe(false);
  });
});
