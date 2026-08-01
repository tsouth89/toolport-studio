import { TurnId } from "@toolport-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../agentRuns";
import type { ThreadActivityViewModel } from "../threadActivityViewModel";
import { ThisTurnCard } from "./ThisTurnCard";

const model: ThreadActivityViewModel = {
  isWorking: true,
  elapsedStartedAt: "2026-08-01T10:00:00.000Z",
  statusBadge: { kind: "elapsed", startedAt: "2026-08-01T10:00:00.000Z" },
  current: { label: "Waiting for delegated work", startedAt: null, source: "working" },
  recentSteps: [],
  changedFiles: null,
  artifacts: [],
  attention: null,
  mcp: null,
  hasAuthoritativeMcpStatus: false,
};

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "agent-1",
    turnId: TurnId.make("turn-1"),
    parentId: null,
    providerThreadId: "provider-child-1",
    label: "Inspect README",
    prompt: "Find one heading",
    model: "test-model",
    reasoningEffort: null,
    message: null,
    status: "running",
    startedAt: "2026-08-01T10:00:01.000Z",
    updatedAt: "2026-08-01T10:00:02.000Z",
    completedAt: null,
    canInspectThread: true,
    depth: 0,
    activities: [],
    ...overrides,
  };
}

describe("ThisTurnCard agent runs", () => {
  it("shows live agent status and one-click Agents links", () => {
    const markup = renderToStaticMarkup(
      <ThisTurnCard
        model={model}
        agentRuns={[
          run(),
          run({
            id: "agent-2",
            label: "Check package",
            status: "completed",
            completedAt: "2026-08-01T10:00:03.000Z",
          }),
        ]}
        onDismiss={() => {}}
        onOpenAgents={() => {}}
      />,
    );

    expect(markup).toContain("1 subagent running");
    expect(markup).toContain("Open Inspect README in Agents");
    expect(markup).toContain("Open Check package in Agents");
    expect(markup).toContain("Open Agents");
    expect(markup).toContain("Completed");
  });

  it("surfaces failures ahead of concurrently running agents", () => {
    const markup = renderToStaticMarkup(
      <ThisTurnCard
        model={model}
        agentRuns={[
          run({ id: "agent-completed", status: "completed" }),
          run({ id: "agent-running" }),
          run({ id: "agent-failed", status: "failed" }),
        ]}
        onDismiss={() => {}}
        onOpenAgents={() => {}}
      />,
    );

    expect(markup).toContain("1 failed · 1 running");
  });
});
