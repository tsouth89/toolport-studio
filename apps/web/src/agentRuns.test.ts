import { EventId, RuntimeAgentId, TurnId } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentRunsForTurn,
  deriveAgentRuns,
  latestMessageTurnId,
  preferredAgentRun,
  summarizeAgentRuns,
} from "./agentRuns";

const activity = (
  id: string,
  kind: string,
  createdAt: string,
  payload: Record<string, unknown>,
  summary = kind,
) => ({
  id: EventId.make(id),
  kind,
  createdAt,
  payload,
  summary,
  tone: "tool" as const,
  turnId: TurnId.make("turn-1"),
});

describe("deriveAgentRuns", () => {
  it("projects lifecycle state, nests child agents, and attaches their work", () => {
    const parent = RuntimeAgentId.make("agent-parent");
    const child = RuntimeAgentId.make("agent-child");
    const runs = deriveAgentRuns([
      activity("1", "agent.started", "2026-08-01T10:00:00.000Z", {
        agentRunId: parent,
        providerThreadId: "agent-parent",
        status: "running",
        label: "Researcher",
        prompt: "Inspect the protocol",
        canInspectThread: true,
      }),
      activity(
        "2",
        "tool.completed",
        "2026-08-01T10:00:01.000Z",
        {
          agentRunId: parent,
          itemType: "command_execution",
        },
        "Ran rg",
      ),
      activity("3", "agent.started", "2026-08-01T10:00:02.000Z", {
        agentRunId: child,
        parentAgentRunId: parent,
        status: "pending",
      }),
      activity("4", "agent.completed", "2026-08-01T10:00:03.000Z", {
        agentRunId: parent,
        status: "completed",
        message: "Found the event mapping",
      }),
    ]);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      id: "agent-parent",
      turnId: "turn-1",
      depth: 0,
      status: "completed",
      message: "Found the event mapping",
      completedAt: "2026-08-01T10:00:03.000Z",
    });
    expect(runs[0]?.activities.map((entry) => entry.summary)).toEqual([
      "agent.started",
      "Ran rg",
      "agent.completed",
    ]);
    expect(runs[1]).toMatchObject({ id: "agent-child", parentId: "agent-parent", depth: 1 });
  });

  it("filters and summarizes the agents for one turn", () => {
    const firstTurnRuns = deriveAgentRuns([
      activity("1", "agent.started", "2026-08-01T10:00:00.000Z", {
        agentRunId: "agent-running",
        status: "running",
      }),
      activity("2", "agent.started", "2026-08-01T10:00:01.000Z", {
        agentRunId: "agent-done",
        status: "running",
      }),
      activity("3", "agent.completed", "2026-08-01T10:00:02.000Z", {
        agentRunId: "agent-done",
        status: "completed",
      }),
    ]);

    expect(agentRunsForTurn(firstTurnRuns, TurnId.make("turn-1"))).toHaveLength(2);
    expect(agentRunsForTurn(firstTurnRuns, TurnId.make("turn-2"))).toEqual([]);
    expect(summarizeAgentRuns(firstTurnRuns)).toEqual({
      totalCount: 2,
      activeCount: 1,
      failedCount: 0,
      completedCount: 1,
      label: "1 subagent running",
    });
    expect(
      summarizeAgentRuns(firstTurnRuns.map((run) => ({ ...run, status: "completed" as const })))
        .label,
    ).toBe("2 subagents completed");
  });

  it("prioritizes failed then active agents for attention and selection", () => {
    const runs = deriveAgentRuns([
      activity("1", "agent.started", "2026-08-01T10:00:00.000Z", {
        agentRunId: "agent-completed",
        status: "completed",
      }),
      activity("2", "agent.started", "2026-08-01T10:00:01.000Z", {
        agentRunId: "agent-running",
        status: "running",
      }),
      activity("3", "agent.started", "2026-08-01T10:00:02.000Z", {
        agentRunId: "agent-failed",
        status: "failed",
      }),
    ]);

    expect(summarizeAgentRuns(runs).label).toBe("1 failed · 1 running");
    expect(preferredAgentRun(runs)?.id).toBe("agent-failed");
    expect(preferredAgentRun(runs.filter((run) => run.status !== "failed"))?.id).toBe(
      "agent-running",
    );
    expect(preferredAgentRun(runs.filter((run) => run.status === "completed"))?.id).toBe(
      "agent-completed",
    );
  });

  it("ignores malformed and unrelated activities", () => {
    expect(
      deriveAgentRuns([
        activity("1", "tool.completed", "2026-08-01T10:00:00.000Z", {
          agentRunId: "missing-lifecycle",
        }),
        activity("2", "agent.started", "2026-08-01T10:00:01.000Z", { status: "running" }),
      ]),
    ).toEqual([]);
  });

  it("uses the latest turn-stamped message when settled user messages have no turn id", () => {
    expect(
      latestMessageTurnId([
        { turnId: TurnId.make("turn-1") },
        { turnId: null },
        { turnId: TurnId.make("turn-2") },
        { turnId: null },
      ]),
    ).toBe("turn-2");
  });
});
