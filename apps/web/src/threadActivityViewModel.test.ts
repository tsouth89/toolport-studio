import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "./session-logic";
import {
  deriveThreadActivityViewModel,
  isActivityRecentMilestone,
} from "./threadActivityViewModel";

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

describe("isActivityRecentMilestone", () => {
  it("keeps tools and session start, drops thinking and plan noise", () => {
    expect(
      isActivityRecentMilestone(
        workEntry({ id: "t", label: "Read files", toolLifecycleStatus: "completed" }),
      ),
    ).toBe(true);
    expect(
      isActivityRecentMilestone(workEntry({ id: "s", label: "Session started", tone: "info" })),
    ).toBe(true);
    expect(
      isActivityRecentMilestone(
        workEntry({ id: "th", label: "Planning next steps", tone: "thinking" }),
      ),
    ).toBe(false);
    expect(
      isActivityRecentMilestone(workEntry({ id: "p", label: "Plan updated", tone: "info" })),
    ).toBe(false);
    expect(
      isActivityRecentMilestone(workEntry({ id: "c", label: "Changed files", tone: "info" })),
    ).toBe(false);
  });
});

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
          detail: "exit code 1",
          createdAt: "2026-07-26T12:00:10.000Z",
        }),
      ]),
    });

    expect(model.current).toBeNull();
    expect(model.recentSteps.map((step) => step.status)).toEqual(["completed", "failed"]);
    expect(model.recentSteps[0]?.detail).toBeUndefined();
    expect(model.recentSteps[1]?.detail).toBe("exit code 1");
  });

  it("filters thinking and plan noise out of recent steps", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline([
        workEntry({
          id: "done-implicit",
          label: "grep",
          createdAt: "2026-07-26T12:00:00.000Z",
        }),
        workEntry({
          id: "stopped",
          label: "shell",
          toolLifecycleStatus: "stopped",
          detail: "interrupted by user",
          createdAt: "2026-07-26T12:00:05.000Z",
        }),
        workEntry({
          id: "think",
          label: "Planning",
          tone: "thinking",
          createdAt: "2026-07-26T12:00:08.000Z",
        }),
        workEntry({
          id: "plan",
          label: "Plan updated",
          tone: "info",
          createdAt: "2026-07-26T12:00:09.000Z",
        }),
        workEntry({
          id: "files",
          label: "Changed files",
          tone: "info",
          createdAt: "2026-07-26T12:00:10.000Z",
        }),
      ]),
    });

    expect(model.recentSteps.map((step) => step.label)).toEqual(["grep", "shell"]);
    expect(model.recentSteps.map((step) => step.status)).toEqual(["completed", "interrupted"]);
    expect(model.recentSteps[1]?.detail).toBe("interrupted by user");
  });

  it("caps recent steps at mockup-scale length", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      workEntry({
        id: `tool-${index}`,
        label: `Tool ${index}`,
        toolLifecycleStatus: "completed",
        createdAt: `2026-07-26T12:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline(entries),
    });

    expect(model.recentSteps).toHaveLength(8);
    expect(model.recentSteps[0]?.label).toBe("Tool 4");
    expect(model.recentSteps[7]?.label).toBe("Tool 11");
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
          label: "Still thinking about a long chain of private thoughts",
          tone: "thinking",
          turnId,
          sourceActivityKind: "task.progress",
          createdAt: "2026-07-26T12:00:02.000Z",
        }),
      ]),
    });

    expect(model.recentSteps.map((step) => step.label)).toEqual(["Linear · list issues"]);
    expect(model.recentSteps[0]?.status).toBe("interrupted");
    expect(model.current?.source).toBe("thinking");
    // Quiet current: no thought dump in the panel.
    expect(model.current?.label).toBe("Thinking");
    expect(model.current?.detail).toBeUndefined();
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
    expect(model.current?.label).toBe("Thinking");
    expect(model.recentSteps).toHaveLength(0);
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
    // Quiet completed rows: no dump under the label.
    expect(model.recentSteps[0]?.detail).toBeUndefined();
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

  it("prefers command over raw detail for current tool subtitle", () => {
    const turnId = TurnId.make("turn-4");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      timelineEntries: workTimeline([
        workEntry({
          id: "cmd",
          label: "Terminal",
          toolTitle: "Terminal",
          turnId,
          toolLifecycleStatus: "inProgress",
          command: "vp test run apps/web/src/threadActivityViewModel.test.ts",
          detail: '{"stdout":"very long raw blob"}',
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
      ]),
    });

    expect(model.current?.label).toBe("Terminal");
    expect(model.current?.detail).toContain("vp test run");
    expect(model.current?.detail).not.toContain("stdout");
  });
});
