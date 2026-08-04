import type { OrchestrationThreadActivity } from "@toolport-studio/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  backgroundTaskProjectionFromActivity,
  isInFlightBackgroundTaskStatus,
} from "./backgroundTasks.ts";

const activity = (overrides: Partial<OrchestrationThreadActivity>): OrchestrationThreadActivity =>
  ({
    id: "event-1",
    tone: "info",
    kind: "task.started",
    summary: "Task started",
    payload: {},
    turnId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  }) as OrchestrationThreadActivity;

describe("backgroundTaskProjectionFromActivity", () => {
  it("ignores activities that are not task lifecycle rows", () => {
    assert.equal(
      backgroundTaskProjectionFromActivity(
        activity({ kind: "agent.started", payload: { agentRunId: "a1" } }),
      ),
      null,
    );
  });

  it("ignores task rows without a task id", () => {
    assert.equal(
      backgroundTaskProjectionFromActivity(activity({ kind: "task.updated", payload: {} })),
      null,
    );
  });

  it("seeds task.started as foreground work, reading the description from detail", () => {
    const projection = backgroundTaskProjectionFromActivity(
      activity({
        kind: "task.started",
        payload: { taskId: "t1", taskType: "shell", detail: "gh run watch" },
      }),
    );

    assert.deepEqual(projection, {
      taskId: "t1",
      taskType: "shell",
      description: "gh run watch",
      command: null,
      status: "running",
      backgrounded: false,
    });
  });

  it("marks task.updated as backgrounded and carries the command line", () => {
    const projection = backgroundTaskProjectionFromActivity(
      activity({
        kind: "task.updated",
        payload: {
          taskId: "t1",
          status: "running",
          backgrounded: true,
          title: "Watching CI",
          command: "gh run watch",
        },
      }),
    );

    assert.deepEqual(projection, {
      taskId: "t1",
      taskType: null,
      description: "Watching CI",
      command: "gh run watch",
      status: "running",
      backgrounded: true,
    });
  });

  it("falls back to running when a patch omits status", () => {
    const projection = backgroundTaskProjectionFromActivity(
      activity({ kind: "task.updated", payload: { taskId: "t1", backgrounded: true } }),
    );
    assert.equal(projection?.status, "running");
  });

  it("rejects a status outside the neutral vocabulary", () => {
    const projection = backgroundTaskProjectionFromActivity(
      activity({ kind: "task.updated", payload: { taskId: "t1", status: "killed" } }),
    );
    // `killed` is Claude's spelling; the adapter maps it before this point, so
    // an unmapped value must not leak into the roster.
    assert.equal(projection?.status, "running");
  });

  it("settles task.completed and never reports it as in flight", () => {
    const projection = backgroundTaskProjectionFromActivity(
      activity({
        kind: "task.completed",
        tone: "error",
        payload: { taskId: "t1", status: "failed", title: "Watching CI" },
      }),
    );

    assert.equal(projection?.status, "failed");
    assert.equal(projection?.backgrounded, false);
  });
});

describe("isInFlightBackgroundTaskStatus", () => {
  it("treats pending, running and paused as in flight", () => {
    assert.deepEqual(
      ["pending", "running", "paused", "completed", "failed", "stopped", "bogus"].map(
        isInFlightBackgroundTaskStatus,
      ),
      [true, true, true, false, false, false, false],
    );
  });
});
