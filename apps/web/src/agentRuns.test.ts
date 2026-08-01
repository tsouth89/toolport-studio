import { EventId, RuntimeAgentId, TurnId } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentRuns } from "./agentRuns";

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
});
