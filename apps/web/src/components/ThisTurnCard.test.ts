import { describe, expect, it } from "vite-plus/test";

import { shouldShowThisTurnCard } from "./ThisTurnCard";
import type { AgentRun } from "../agentRuns";
import type { ThreadActivityViewModel } from "../threadActivityViewModel";

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
