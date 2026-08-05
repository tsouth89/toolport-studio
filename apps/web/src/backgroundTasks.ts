/**
 * Background-task roster derived from `task.*` thread activities.
 *
 * Mirrors agentRuns.ts: activities are the replayable source of truth, so the
 * panel and the chips both read one pure projection instead of holding
 * their own state. A task is "in flight" only once it has been backgrounded —
 * foreground shell/subagent work is already covered by the running turn.
 */
import type { OrchestrationThreadActivity, TurnId } from "@toolport-studio/contracts";

export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

/**
 * Claude's `BackgroundTaskSummary.type`. Unknown values pass through so a new
 * task type shows its raw label rather than being dropped.
 */
export type BackgroundTaskKind = "shell" | "subagent" | "monitor" | "workflow" | string;

export interface BackgroundTask {
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly label: string;
  readonly kind: BackgroundTaskKind | null;
  /** Shell command line; only present for shell-backed tasks. */
  readonly command: string | null;
  readonly status: BackgroundTaskStatus;
  readonly backgrounded: boolean;
  readonly error: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** Ambient/housekeeping work — hidden from the transcript, shown in the roster. */
  readonly skipTranscript: boolean;
}

const TASK_STATUSES = new Set<BackgroundTaskStatus>([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
]);

const IN_FLIGHT_STATUSES = new Set<BackgroundTaskStatus>(["pending", "running", "paused"]);

export function isBackgroundTaskInFlight(task: BackgroundTask): boolean {
  return task.backgrounded && IN_FLIGHT_STATUSES.has(task.status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function status(value: unknown, fallback: BackgroundTaskStatus): BackgroundTaskStatus {
  return typeof value === "string" && TASK_STATUSES.has(value as BackgroundTaskStatus)
    ? (value as BackgroundTaskStatus)
    : fallback;
}

function activityOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function deriveBackgroundTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<BackgroundTask> {
  const tasks = new Map<string, BackgroundTask>();
  const ordered = [...activities].sort(activityOrder);

  for (const activity of ordered) {
    if (!activity.kind.startsWith("task.")) continue;
    const payload = asRecord(activity.payload);
    const id = text(payload?.taskId);
    if (!payload || !id) continue;

    const previous = tasks.get(id);
    // task.started carries the description in `detail`; the later kinds put it
    // in `title`. Never let a patch without one blank out what we already have.
    const label =
      text(payload.title) ?? text(payload.detail) ?? previous?.label ?? "Background task";

    const nextStatus = status(payload.status, previous?.status ?? "running");
    // `detail` is overloaded across the task kinds (description, summary, error
    // text), so only read it as an error when the row is actually a failure.
    const failed = nextStatus === "failed" || activity.tone === "error";

    const next: BackgroundTask = {
      id,
      turnId: previous?.turnId ?? activity.turnId,
      label,
      kind: text(payload.taskType) ?? previous?.kind ?? null,
      command: text(payload.command) ?? previous?.command ?? null,
      status: nextStatus,
      // Once backgrounded, a task stays backgrounded — the terminal
      // task.completed row does not repeat the flag.
      backgrounded: payload.backgrounded === true || (previous?.backgrounded ?? false),
      error: failed ? (text(payload.detail) ?? previous?.error ?? null) : (previous?.error ?? null),
      startedAt: previous?.startedAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
      skipTranscript: payload.skipTranscript === true || (previous?.skipTranscript ?? false),
    };
    tasks.set(id, next);
  }

  return [...tasks.values()].sort((left, right) => {
    // In-flight first, then most recently touched — the roster is a "what is
    // happening now" list, not a history.
    const leftLive = isBackgroundTaskInFlight(left) ? 0 : 1;
    const rightLive = isBackgroundTaskInFlight(right) ? 0 : 1;
    if (leftLive !== rightLive) return leftLive - rightLive;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export interface BackgroundTaskSummary {
  readonly totalCount: number;
  readonly runningCount: number;
  readonly failedCount: number;
  /** Chip text, e.g. "2 running tasks". Empty when there is nothing to show. */
  readonly label: string;
}

function pluralizedTask(count: number): string {
  return count === 1 ? "task" : "tasks";
}

export function summarizeBackgroundTasks(
  tasks: ReadonlyArray<BackgroundTask>,
): BackgroundTaskSummary {
  const runningCount = tasks.filter(isBackgroundTaskInFlight).length;
  // Must filter on `backgrounded` the same way the running count does. The
  // roster holds foreground tasks too, so counting every failure here would
  // report a failed inline task in a chip that says "background".
  const failedCount = tasks.filter((task) => task.backgrounded && task.status === "failed").length;

  const label =
    runningCount > 0
      ? `${runningCount} running ${pluralizedTask(runningCount)}`
      : failedCount > 0
        ? `${failedCount} failed ${pluralizedTask(failedCount)}`
        : "";

  return {
    totalCount: tasks.length,
    runningCount,
    failedCount,
    label,
  };
}

/**
 * App-level count for the sidebar chip. Reads the shell projection rather than
 * activities so threads the client has never opened still contribute.
 */
export function countRunningBackgroundTasks(
  threads: ReadonlyArray<{ readonly runningBackgroundTaskCount?: number | undefined }>,
): number {
  let total = 0;
  for (const thread of threads) {
    total += thread.runningBackgroundTaskCount ?? 0;
  }
  return total;
}

export function formatRunningBackgroundTaskLabel(count: number): string {
  return `${count} running ${pluralizedTask(count)}`;
}
