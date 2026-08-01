import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../agentRuns";
import { AgentsPanel } from "./AgentsPanel";

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: "agent-1",
  parentId: null,
  providerThreadId: "provider-child-1",
  label: "Agent 1",
  prompt: "Inspect the protocol",
  model: "gpt-5.6-codex",
  reasoningEffort: "high",
  message: null,
  status: "running",
  startedAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:01.000Z",
  completedAt: null,
  canInspectThread: true,
  depth: 0,
  activities: [],
  ...overrides,
});

describe("AgentsPanel", () => {
  it("summarizes active agents and renders the selected run", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        runs={[
          run(),
          run({
            id: "agent-2",
            label: "Agent 2",
            status: "completed",
            completedAt: "2026-08-01T10:00:02.000Z",
          }),
        ]}
        selectedAgentRunId="agent-1"
        onSelectAgent={() => {}}
      />,
    );

    expect(markup).toContain("1 active · 2 total");
    expect(markup).toContain("Inspect the protocol");
    expect(markup).toContain("gpt-5.6-codex");
    expect(markup).toContain("high reasoning");
  });

  it("renders an honest empty state before any native lifecycle is observed", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel runs={[]} selectedAgentRunId={null} onSelectAgent={() => {}} />,
    );
    expect(markup).toContain("No subagents yet");
  });
});
