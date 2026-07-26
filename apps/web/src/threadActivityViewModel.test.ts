import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "./session-logic";
import { deriveThreadActivityViewModel } from "./threadActivityViewModel";

function workEntry(
  partial: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id" | "label">,
): WorkLogEntry {
  return {
    createdAt: "2026-07-26T12:00:00.000Z",
    tone: "tool",
    ...partial,
  };
}

function workTimeline(entries: WorkLogEntry[]): TimelineEntry[] {
  return entries.map((entry) => ({
    id: `tl-${entry.id}`,
    kind: "work" as const,
    createdAt: entry.createdAt,
    entry,
  }));
}

describe("deriveThreadActivityViewModel", () => {
  it("surfaces the running tool as current step while working", () => {
    const turnId = TurnId.make("turn-1");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      activeToolLabel: "Linear · list issues",
      timelineEntries: workTimeline([
        workEntry({
          id: "a",
          label: "Session started",
          tone: "info",
          turnId,
          createdAt: "2026-07-26T12:00:00.000Z",
        }),
        workEntry({
          id: "b",
          label: "list issues",
          toolTitle: "Linear · list issues",
          turnId,
          toolLifecycleStatus: "inProgress",
          createdAt: "2026-07-26T12:00:05.000Z",
        }),
      ]),
    });

    expect(model.isWorking).toBe(true);
    expect(model.current?.source).toBe("tool");
    expect(model.current?.label).toBe("Linear · list issues");
    expect(model.recentSteps).toHaveLength(2);
    expect(model.recentSteps[1]?.status).toBe("running");
  });

  it("marks completed and failed tool steps honestly", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline([
        workEntry({
          id: "ok",
          label: "Read files",
          toolLifecycleStatus: "completed",
          createdAt: "2026-07-26T12:00:00.000Z",
        }),
        workEntry({
          id: "bad",
          label: "Run tests",
          tone: "error",
          toolLifecycleStatus: "failed",
          createdAt: "2026-07-26T12:00:10.000Z",
        }),
      ]),
    });

    expect(model.current).toBeNull();
    expect(model.recentSteps.map((step) => step.status)).toEqual(["completed", "failed"]);
  });

  it("does not spin finished, stopped, or neutral tool steps", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline([
        workEntry({
          id: "done-implicit",
          label: "grep",
          // Tool-like with no lifecycle still resolves to success, not running.
          createdAt: "2026-07-26T12:00:00.000Z",
        }),
        workEntry({
          id: "stopped",
          label: "shell",
          toolLifecycleStatus: "stopped",
          createdAt: "2026-07-26T12:00:05.000Z",
        }),
        workEntry({
          id: "think",
          label: "Planning",
          tone: "thinking",
          createdAt: "2026-07-26T12:00:08.000Z",
        }),
      ]),
    });

    expect(model.recentSteps.map((step) => step.status)).toEqual([
      "completed",
      "interrupted",
      "info",
    ]);
  });

  it("only treats explicit inProgress tools as the current step", () => {
    const turnId = TurnId.make("turn-2");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      timelineEntries: workTimeline([
        workEntry({
          id: "prior",
          label: "list issues",
          toolTitle: "Linear · list issues",
          turnId,
          toolLifecycleStatus: "stopped",
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
        workEntry({
          id: "think",
          label: "Still thinking",
          tone: "thinking",
          turnId,
          sourceActivityKind: "task.progress",
          createdAt: "2026-07-26T12:00:02.000Z",
        }),
      ]),
    });

    expect(model.recentSteps[0]?.status).toBe("interrupted");
    expect(model.current?.source).toBe("thinking");
    expect(model.current?.label).toBe("Still thinking");
  });

  it("surfaces approval attention without inventing a tool", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      hasPendingApproval: true,
      timelineEntries: [],
    });

    expect(model.attention).toEqual({ kind: "approval", label: "Approval required" });
    expect(model.current?.source).toBe("working");
    expect(model.hasAuthoritativeMcpStatus).toBe(false);
  });

  it("prefers thinking label when no tool is open", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      timelineEntries: workTimeline([
        workEntry({
          id: "t",
          label: "Planning next steps",
          tone: "thinking",
          sourceActivityKind: "task.progress",
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
      ]),
    });

    expect(model.current?.source).toBe("thinking");
    expect(model.current?.label).toBe("Planning next steps");
  });

  it("does not promote a finished tool into Current via activeToolLabel", () => {
    const turnId = TurnId.make("turn-3");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      activeToolLabel: "Searched files",
      timelineEntries: workTimeline([
        workEntry({
          id: "search",
          label: "Searched files",
          toolTitle: "Searched files",
          turnId,
          toolLifecycleStatus: "completed",
          detail: "deriveThreadActivityViewModelisWorkingactiveToolLabelAct",
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
      ]),
    });

    expect(model.current?.source).toBe("working");
    expect(model.current?.label).toBe("Working");
    expect(model.recentSteps[0]?.status).toBe("completed");
    expect(model.recentSteps[0]?.detail?.length).toBeLessThanOrEqual(140);
  });

  it("clears leftover inProgress spinners once the turn is idle", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline([
        workEntry({
          id: "stuck",
          label: "Read files",
          toolTitle: "Read files",
          toolLifecycleStatus: "inProgress",
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
      ]),
    });

    expect(model.current).toBeNull();
    expect(model.recentSteps[0]?.status).toBe("completed");
  });
});
