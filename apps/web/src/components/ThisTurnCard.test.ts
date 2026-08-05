import { describe, expect, it } from "vite-plus/test";

import {
  isThisTurnCardVisible,
  liveBackgroundWorkStartedAt,
  shouldShowThisTurnCard,
} from "./ThisTurnCard";
import type { AgentRun } from "../agentRuns";
import type { BackgroundTask } from "../backgroundTasks";
import type { ThreadActivityViewModel } from "../threadActivityViewModel";

function task(partial: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "t1",
    turnId: null,
    label: "Watching PR checks",
    kind: "monitor",
    command: null,
    status: "running",
    backgrounded: true,
    error: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    skipTranscript: false,
    ...partial,
  };
}

function baseModel(partial: Partial<ThreadActivityViewModel> = {}): ThreadActivityViewModel {
  return {
    isWorking: false,
    elapsedStartedAt: null,
    statusBadge: { kind: "idle" },
    current: null,
    recentSteps: [],
    changedFiles: null,
    artifacts: [],
    attention: null,
    mcp: null,
    hasAuthoritativeMcpStatus: false,
    ...partial,
  };
}

describe("shouldShowThisTurnCard", () => {
  it("shows while working", () => {
    expect(
      shouldShowThisTurnCard(
        baseModel({
          isWorking: true,
          elapsedStartedAt: "2026-07-28T00:00:00.000Z",
          statusBadge: { kind: "elapsed", startedAt: "2026-07-28T00:00:00.000Z" },
        }),
      ),
    ).toBe(true);
  });

  it("hides when idle with no history", () => {
    expect(shouldShowThisTurnCard(baseModel())).toBe(false);
  });

  it("hides after settle so the timeline owns the story", () => {
    expect(
      shouldShowThisTurnCard(
        baseModel({
          statusBadge: { kind: "done", durationLabel: "3m 10s" },
          current: {
            label: "Read session-logic.ts",
            startedAt: "2026-07-28T00:03:00.000Z",
            source: "settled",
          },
          recentSteps: [
            {
              id: "s1",
              label: "Read session-logic.ts",
              status: "completed",
              createdAt: "2026-07-28T00:03:00.000Z",
              tone: "tool",
              isToolLike: true,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("shows when attention is required even if not working", () => {
    expect(
      shouldShowThisTurnCard(
        baseModel({
          attention: { kind: "approval", label: "Approval required" },
        }),
      ),
    ).toBe(true);
  });

  it("keeps a failed subagent visible after the parent turn settles", () => {
    const failedRun = {
      status: "failed",
    } as AgentRun;
    expect(shouldShowThisTurnCard(baseModel(), [failedRun])).toBe(true);
  });

  it("retains compact access to completed subagents after settle", () => {
    const completedRun = {
      status: "completed",
    } as AgentRun;
    expect(shouldShowThisTurnCard(baseModel(), [completedRun])).toBe(true);
  });
});

describe("isThisTurnCardVisible", () => {
  const base = {
    model: baseModel(),
    dockedActivityOpen: false,
    dismissed: false,
    forcedOpen: false,
  };

  it("keeps a live watcher visible even after the user dismissed the card", () => {
    // The regression this guards: dismiss is keyed to the turn, the watcher
    // outlives it, and the sidebar chip kept counting work the session hid.
    expect(isThisTurnCardVisible({ ...base, dismissed: true, backgroundTasks: [task()] })).toBe(
      true,
    );
  });

  it("still honours dismiss once the background work settles", () => {
    expect(
      isThisTurnCardVisible({
        ...base,
        dismissed: true,
        backgroundTasks: [task({ status: "completed" })],
      }),
    ).toBe(false);
  });

  it("honours dismiss for an ordinary settled turn", () => {
    expect(isThisTurnCardVisible({ ...base, dismissed: true })).toBe(false);
  });

  it("yields to the docked Activity surface, which shows the same thing", () => {
    expect(
      isThisTurnCardVisible({ ...base, dockedActivityOpen: true, backgroundTasks: [task()] }),
    ).toBe(false);
  });

  it("shows a live watcher on a settled turn without any dismiss", () => {
    expect(isThisTurnCardVisible({ ...base, backgroundTasks: [task()] })).toBe(true);
  });

  it("hides on an idle thread with nothing running", () => {
    expect(isThisTurnCardVisible(base)).toBe(false);
  });
});

describe("liveBackgroundWorkStartedAt", () => {
  it("anchors to the oldest in-flight task, not the most recently touched", () => {
    expect(
      liveBackgroundWorkStartedAt([
        task({ id: "new", startedAt: "2026-07-28T00:05:00.000Z" }),
        task({ id: "old", startedAt: "2026-07-28T00:01:00.000Z" }),
      ]),
    ).toBe("2026-07-28T00:01:00.000Z");
  });

  it("ignores settled tasks so a finished watcher stops the clock", () => {
    expect(
      liveBackgroundWorkStartedAt([
        task({ id: "done", status: "completed", startedAt: "2026-07-28T00:01:00.000Z" }),
        task({ id: "live", status: "running", startedAt: "2026-07-28T00:04:00.000Z" }),
      ]),
    ).toBe("2026-07-28T00:04:00.000Z");
  });

  it("ignores foreground work, which the running turn already covers", () => {
    expect(liveBackgroundWorkStartedAt([task({ backgrounded: false })])).toBe(null);
  });

  it("reports nothing when every task has settled", () => {
    expect(liveBackgroundWorkStartedAt([task({ status: "completed" })])).toBe(null);
    expect(liveBackgroundWorkStartedAt([])).toBe(null);
  });
});
