import type { OrchestrationThreadActivity } from "@toolport-studio/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  countRunningBackgroundTasks,
  deriveBackgroundTasks,
  formatRunningBackgroundTaskLabel,
  isBackgroundTaskInFlight,
  summarizeBackgroundTasks,
} from "./backgroundTasks";

let sequence = 0;
const activity = (
  kind: string,
  payload: Record<string, unknown>,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity =>
  ({
    id: `event-${(sequence += 1)}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    sequence,
    createdAt: new Date(1_760_000_000_000 + sequence * 1_000).toISOString(),
    ...overrides,
  }) as OrchestrationThreadActivity;

describe("deriveBackgroundTasks", () => {
  it("returns nothing when no task activities exist", () => {
    assert.deepEqual(deriveBackgroundTasks([activity("agent.started", { agentRunId: "a1" })]), []);
  });

  it("folds the task lifecycle into one roster entry", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", taskType: "shell", detail: "Watch CI" }),
      activity("task.updated", {
        taskId: "t1",
        status: "running",
        backgrounded: true,
        command: "gh run watch",
      }),
    ]);

    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    assert.equal(task.id, "t1");
    // The patch carries no title, so the started description must survive.
    assert.equal(task.label, "Watch CI");
    assert.equal(task.kind, "shell");
    assert.equal(task.command, "gh run watch");
    assert.equal(task.backgrounded, true);
    assert.equal(isBackgroundTaskInFlight(task), true);
  });

  it("keeps a task backgrounded once the terminal row drops the flag", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Watch CI" }),
      activity("task.updated", { taskId: "t1", backgrounded: true, status: "running" }),
      activity("task.completed", { taskId: "t1", status: "completed", title: "Watch CI" }),
    ]);

    assert.equal(tasks[0]?.backgrounded, true);
    assert.equal(tasks[0]?.status, "completed");
    // Settled work is not in flight even though it stays flagged backgrounded.
    assert.equal(isBackgroundTaskInFlight(tasks[0]!), false);
  });

  it("does not count foreground tasks as in flight", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Run tests" }),
    ]);
    assert.equal(tasks[0]?.status, "running");
    assert.equal(isBackgroundTaskInFlight(tasks[0]!), false);
  });

  it("records an error only on failure rows, not from a completion summary", () => {
    const settled = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Watch CI" }),
      activity("task.completed", {
        taskId: "t1",
        status: "completed",
        title: "Watch CI",
        detail: "all green",
      }),
    ]);
    assert.equal(settled[0]?.error, null);

    const failed = deriveBackgroundTasks([
      activity("task.started", { taskId: "t2", detail: "Watch CI" }),
      activity(
        "task.updated",
        { taskId: "t2", status: "failed", backgrounded: true, detail: "exit 1" },
        { tone: "error" },
      ),
    ]);
    assert.equal(failed[0]?.error, "exit 1");
  });

  it("sorts in-flight tasks ahead of settled ones", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "done", detail: "Old" }),
      activity("task.completed", { taskId: "done", status: "completed", title: "Old" }),
      activity("task.started", { taskId: "live", detail: "New" }),
      activity("task.updated", { taskId: "live", backgrounded: true, status: "running" }),
    ]);

    assert.deepEqual(
      tasks.map((task) => task.id),
      ["live", "done"],
    );
  });

  it("carries skipTranscript so ambient work stays out of the transcript", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Housekeeping", skipTranscript: true }),
    ]);
    assert.equal(tasks[0]?.skipTranscript, true);
  });
});

describe("summarizeBackgroundTasks", () => {
  it("is empty when nothing is running or failed", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Watch CI" }),
      activity("task.completed", { taskId: "t1", status: "completed", title: "Watch CI" }),
    ]);
    assert.equal(summarizeBackgroundTasks(tasks).label, "");
  });

  it("prefers the running count and singularizes it", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Watch CI" }),
      activity("task.updated", { taskId: "t1", backgrounded: true, status: "running" }),
    ]);
    const summary = summarizeBackgroundTasks(tasks);
    assert.equal(summary.runningCount, 1);
    assert.equal(summary.label, "1 running task");
  });

  it("falls back to failures when nothing is still running", () => {
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Watch CI" }),
      activity("task.updated", { taskId: "t1", backgrounded: true, status: "running" }),
      activity(
        "task.completed",
        { taskId: "t1", status: "failed", title: "Watch CI" },
        { tone: "error" },
      ),
    ]);
    assert.equal(summarizeBackgroundTasks(tasks).label, "1 failed task");
  });

  it("ignores foreground failures in a chip that says background", () => {
    // The roster holds foreground tasks too. Counting their failures here
    // would surface an inline task's failure as background work.
    const tasks = deriveBackgroundTasks([
      activity("task.started", { taskId: "t1", detail: "Inline work" }),
      activity("task.updated", { taskId: "t1", backgrounded: false, status: "running" }),
      activity(
        "task.completed",
        { taskId: "t1", status: "failed", title: "Inline work" },
        { tone: "error" },
      ),
    ]);
    const summary = summarizeBackgroundTasks(tasks);
    assert.equal(summary.failedCount, 0);
    assert.equal(summary.label, "");
  });
});

describe("countRunningBackgroundTasks", () => {
  it("sums the shell projection across threads and tolerates older servers", () => {
    assert.equal(
      countRunningBackgroundTasks([
        { runningBackgroundTaskCount: 2 },
        { runningBackgroundTaskCount: 0 },
        // Absent on servers predating background-task tracking.
        {},
        { runningBackgroundTaskCount: 1 },
      ]),
      3,
    );
  });
});

describe("formatRunningBackgroundTaskLabel", () => {
  it("pluralizes", () => {
    assert.equal(formatRunningBackgroundTaskLabel(1), "1 running task");
    assert.equal(formatRunningBackgroundTaskLabel(3), "3 running tasks");
  });
});
