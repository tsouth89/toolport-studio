import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRun } from "../agentRuns";
import type { BackgroundTask } from "../backgroundTasks";
import { AgentsPanel } from "./AgentsPanel";

const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: "task-1",
  turnId: null,
  label: "Watching CI",
  kind: "shell",
  command: "gh run watch",
  status: "running",
  backgrounded: true,
  error: null,
  startedAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:01.000Z",
  skipTranscript: false,
  ...overrides,
});

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: "agent-1",
  turnId: null,
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

    expect(markup).toContain("1 working · 2 total");
    expect(markup).toContain("Inspect the protocol");
    expect(markup).toContain("gpt-5.6-codex");
    expect(markup).toContain("high reasoning");
  });

  it("renders an honest empty state before any native lifecycle is observed", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel runs={[]} selectedAgentRunId={null} onSelectAgent={() => {}} />,
    );
    expect(markup).toContain("Nothing running");
  });

  it("renders background tasks alongside subagents", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        runs={[run()]}
        backgroundTasks={[task()]}
        selectedAgentRunId="agent-1"
        onSelectAgent={() => {}}
      />,
    );

    expect(markup).toContain("Background work");
    expect(markup).toContain("Watching CI");
    expect(markup).toContain("gh run watch");
    // Backgrounded + running reads as "Watching", not a generic "Running".
    expect(markup).toContain("Watching");
    expect(markup).toContain("1 running · 1 total");
    // Subagents keep their own section.
    expect(markup).toContain("Inspect the protocol");
  });

  it("gives the roster the full panel when there are no subagents", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        runs={[]}
        backgroundTasks={[task()]}
        selectedAgentRunId={null}
        onSelectAgent={() => {}}
      />,
    );

    expect(markup).toContain("Background work");
    expect(markup).not.toContain(">Agents<");
    expect(markup).not.toContain("Nothing running");
  });

  it("surfaces a failed task's error", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        runs={[]}
        backgroundTasks={[task({ status: "failed", error: "exit 1", backgrounded: true })]}
        selectedAgentRunId={null}
        onSelectAgent={() => {}}
      />,
    );

    expect(markup).toContain("Failed");
    expect(markup).toContain("exit 1");
    // Settled work still lists, but stops counting as running.
    expect(markup).toContain("1 total");
    expect(markup).not.toContain("running ·");
  });
});
