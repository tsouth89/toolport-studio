import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "./session-logic";
import type { TurnDiffSummary } from "./types";
import {
  deriveActivityArtifacts,
  deriveActivityChangedFiles,
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
          toolTitle: "grep",
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
    // Quiet current: no thought dump; real last-tool context is OK.
    expect(model.current?.label).toBe("Thinking");
    expect(model.current?.detail).toBe("After Linear · list issues");
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
    expect(model.current?.detail).toBe("After Searched files");
    expect(model.recentSteps[0]?.status).toBe("completed");
    // Dumps stay out; short real context is allowed.
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
          itemType: "command_execution",
          turnId,
          toolLifecycleStatus: "inProgress",
          command: "vp test run apps/web/src/threadActivityViewModel.test.ts",
          detail: '{"stdout":"very long raw blob"}',
          createdAt: "2026-07-26T12:00:01.000Z",
        }),
      ]),
    });

    expect(model.current?.label).toBe("Ran command");
    expect(model.current?.detail).toContain("vp test run");
    expect(model.current?.detail).not.toContain("stdout");
  });

  it("replaces generic Tool labels with itemType and short context", () => {
    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      timelineEntries: workTimeline([
        workEntry({
          id: "a",
          label: "Tool",
          toolTitle: "Tool",
          itemType: "web_search",
          toolLifecycleStatus: "completed",
          detail: "patternX",
        }),
        workEntry({
          id: "b",
          label: "Tool",
          toolTitle: "Tool",
          itemType: "dynamic_tool_call",
          toolLifecycleStatus: "completed",
          changedFiles: ["apps/web/src/threadActivityViewModel.ts"],
        }),
      ]),
    });

    expect(model.recentSteps.map((step) => step.label)).toEqual(["Searched files", "Tool call"]);
    expect(model.recentSteps[0]?.detail).toBe("patternX");
    expect(model.recentSteps[1]?.detail).toBe("apps/web/src/threadActivityViewModel.ts");
  });

  it("surfaces checkpoint changed files with stats and preview cap", () => {
    const turnId = TurnId.make("turn-files");
    const summary: TurnDiffSummary = {
      turnId,
      checkpointTurnCount: 3,
      checkpointRef: "ckpt-3" as never,
      status: "ready",
      assistantMessageId: null,
      completedAt: "2026-07-26T12:05:00.000Z",
      files: [
        { path: "docs/a.md", kind: "modified", additions: 10, deletions: 1 },
        { path: "src/b.ts", kind: "modified", additions: 5, deletions: 2 },
        { path: "src/c.ts", kind: "added", additions: 20, deletions: 0 },
        { path: "tests/d.ts", kind: "modified", additions: 3, deletions: 1 },
        { path: "package.json", kind: "modified", additions: 1, deletions: 0 },
        { path: "extra.ts", kind: "modified", additions: 2, deletions: 0 },
      ],
    };

    const model = deriveThreadActivityViewModel({
      isWorking: false,
      activeTurnStartedAt: null,
      latestTurnId: turnId,
      turnDiffSummaries: [summary],
      timelineEntries: [],
    });

    expect(model.changedFiles).toMatchObject({
      turnId,
      fileCount: 6,
      additions: 41,
      deletions: 4,
      hasStats: true,
      source: "checkpoint",
    });
    expect(model.changedFiles?.files).toHaveLength(5);
    expect(model.changedFiles?.files[0]?.path).toBe("docs/a.md");
  });

  it("falls back to work-log paths when no checkpoint exists", () => {
    const turnId = TurnId.make("turn-wip");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      latestTurnId: turnId,
      turnDiffSummaries: [],
      timelineEntries: workTimeline([
        workEntry({
          id: "edit",
          label: "Edit file",
          turnId,
          toolLifecycleStatus: "completed",
          changedFiles: ["src/foo.ts", "src\\foo.ts", "docs/bar.md"],
        }),
      ]),
    });

    expect(model.changedFiles).toMatchObject({
      turnId,
      fileCount: 2,
      hasStats: false,
      source: "work-log",
    });
    expect(model.changedFiles?.files.map((file) => file.path)).toEqual([
      "src/foo.ts",
      "docs/bar.md",
    ]);
  });

  it("surfaces Changed files section from edit tool detail path when locations were lost", () => {
    const turnId = TurnId.make("turn-detail-path");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      latestTurnId: turnId,
      turnDiffSummaries: [],
      timelineEntries: workTimeline([
        workEntry({
          id: "edit-a",
          label: "Changed files",
          toolTitle: "Changed files",
          itemType: "file_change",
          turnId,
          toolLifecycleStatus: "completed",
          detail: "apps/web/src/threadActivityViewModel.ts",
        }),
        workEntry({
          id: "edit-b",
          label: "Changed files",
          toolTitle: "Changed files",
          itemType: "file_change",
          turnId,
          toolLifecycleStatus: "completed",
          detail: "apps/web/src/components/ActivityPanel.tsx",
        }),
      ]),
    });

    expect(model.changedFiles?.source).toBe("work-log");
    expect(model.changedFiles?.fileCount).toBe(2);
    expect(model.changedFiles?.files.map((file) => file.path)).toEqual([
      "apps/web/src/threadActivityViewModel.ts",
      "apps/web/src/components/ActivityPanel.tsx",
    ]);
  });

  it("rejects prose, directories, and junk from work-log Changed files", () => {
    const turnId = TurnId.make("turn-junk");
    const model = deriveThreadActivityViewModel({
      isWorking: true,
      activeTurnStartedAt: "2026-07-26T12:00:00.000Z",
      unsettledTurnId: turnId,
      latestTurnId: turnId,
      turnDiffSummaries: [],
      timelineEntries: workTimeline([
        workEntry({
          id: "noise",
          label: "Changed files",
          toolTitle: "Changed files",
          itemType: "file_change",
          turnId,
          toolLifecycleStatus: "completed",
          changedFiles: [
            "The user is asking about Rate1 gaps/improvements",
            "C:/projects/personal/toolport",
            "C:/projects/personal/toolport/docs",
            "C:/projects/personal/toolport/docs/drafts",
            "C:/projects/personal/toolport/docs/COMPETITIVE.md",
            "apps/web/src/real-file.ts",
          ],
          detail: "The user is asking about Rate1 gaps/improvements",
        }),
      ]),
    });

    expect(model.changedFiles?.source).toBe("work-log");
    expect(model.changedFiles?.hasStats).toBe(false);
    expect(model.changedFiles?.files.map((file) => file.path)).toEqual([
      "docs/COMPETITIVE.md",
      "apps/web/src/real-file.ts",
    ]);
  });
});

describe("deriveActivityArtifacts", () => {
  it("prefers proposed plans for the preferred turn", () => {
    const turnA = TurnId.make("turn-a");
    const turnB = TurnId.make("turn-b");
    const artifacts = deriveActivityArtifacts({
      preferredTurnId: turnB,
      proposedPlans: [
        {
          id: "plan-a" as never,
          turnId: turnA,
          planMarkdown: "# Older plan\n\nDo A.",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-07-26T11:00:00.000Z",
          updatedAt: "2026-07-26T11:00:00.000Z",
        },
        {
          id: "plan-b" as never,
          turnId: turnB,
          planMarkdown: "# Native MCP Resource Subscriptions\n\nDo B.",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-07-26T12:00:00.000Z",
          updatedAt: "2026-07-26T12:05:00.000Z",
        },
      ],
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: "plan-b",
      label: "Native MCP Resource Subscriptions",
      kind: "proposed-plan",
      implemented: false,
    });
  });

  it("falls back to recent unimplemented plans when no turn match", () => {
    const artifacts = deriveActivityArtifacts({
      preferredTurnId: TurnId.make("turn-missing"),
      proposedPlans: [
        {
          id: "plan-done" as never,
          turnId: TurnId.make("turn-old"),
          planMarkdown: "# Done plan",
          implementedAt: "2026-07-26T10:00:00.000Z",
          implementationThreadId: null,
          createdAt: "2026-07-26T09:00:00.000Z",
          updatedAt: "2026-07-26T10:00:00.000Z",
        },
        {
          id: "plan-open" as never,
          turnId: TurnId.make("turn-open"),
          planMarkdown: "# Open plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-07-26T11:00:00.000Z",
          updatedAt: "2026-07-26T12:00:00.000Z",
        },
      ],
    });

    expect(artifacts.map((item) => item.id)).toEqual(["plan-open"]);
  });
});

describe("deriveActivityChangedFiles", () => {
  it("prefers the matching turn checkpoint over an older one", () => {
    const older = TurnId.make("turn-old");
    const newer = TurnId.make("turn-new");
    const result = deriveActivityChangedFiles({
      preferredTurnId: newer,
      workEntries: [],
      turnDiffSummaries: [
        {
          turnId: older,
          checkpointTurnCount: 1,
          checkpointRef: "ckpt-1" as never,
          status: "ready",
          assistantMessageId: null,
          completedAt: "2026-07-26T11:00:00.000Z",
          files: [{ path: "old.ts", kind: "modified", additions: 1, deletions: 0 }],
        },
        {
          turnId: newer,
          checkpointTurnCount: 2,
          checkpointRef: "ckpt-2" as never,
          status: "ready",
          assistantMessageId: null,
          completedAt: "2026-07-26T12:00:00.000Z",
          files: [{ path: "new.ts", kind: "modified", additions: 9, deletions: 3 }],
        },
      ],
    });

    expect(result?.turnId).toBe(newer);
    expect(result?.files[0]?.path).toBe("new.ts");
    expect(result?.additions).toBe(9);
  });
});
