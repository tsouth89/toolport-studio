/**
 * Projection of `task.*` thread activities onto the background-task roster.
 *
 * Pure so the SQL pipeline stays a thin writer: given one activity, decide the
 * row it implies (or none). Only Claude emits these today, but nothing here is
 * Claude-specific — the activity payloads are the provider-neutral shapes from
 * ProviderRuntimeIngestion.
 */
import type { OrchestrationThreadActivity, RuntimeTaskStatus } from "@toolport-studio/contracts";

export interface BackgroundTaskProjection {
  readonly taskId: string;
  readonly taskType: string | null;
  readonly description: string | null;
  readonly command: string | null;
  readonly status: RuntimeTaskStatus;
  readonly backgrounded: boolean;
}

/** Statuses that mean the task is still doing work. */
const IN_FLIGHT_STATUSES = new Set<RuntimeTaskStatus>(["pending", "running", "paused"]);

export function isInFlightBackgroundTaskStatus(status: string): boolean {
  return IN_FLIGHT_STATUSES.has(status as RuntimeTaskStatus);
}

const KNOWN_STATUSES = new Set<RuntimeTaskStatus>([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "stopped",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function taskStatus(value: unknown): RuntimeTaskStatus | null {
  return typeof value === "string" && KNOWN_STATUSES.has(value as RuntimeTaskStatus)
    ? (value as RuntimeTaskStatus)
    : null;
}

export function backgroundTaskProjectionFromActivity(
  activity: OrchestrationThreadActivity,
): BackgroundTaskProjection | null {
  const payload = asRecord(activity.payload);
  const taskId = text(payload?.taskId);
  if (!payload || !taskId) {
    return null;
  }

  switch (activity.kind) {
    case "task.started":
      return {
        taskId,
        taskType: text(payload.taskType),
        // Ingestion puts task.started's description in `detail`.
        description: text(payload.detail) ?? text(payload.title),
        command: null,
        status: "running",
        // Foreground until something says otherwise; a task.updated patch or a
        // roster snapshot is what flips this.
        backgrounded: false,
      };

    case "task.updated":
      return {
        taskId,
        taskType: text(payload.taskType),
        description: text(payload.title),
        command: text(payload.command),
        status: taskStatus(payload.status) ?? "running",
        backgrounded: payload.backgrounded === true,
      };

    case "task.completed":
      return {
        taskId,
        taskType: text(payload.taskType),
        description: text(payload.title),
        command: null,
        status: taskStatus(payload.status) ?? "completed",
        // Settled work is never in flight; the count filters on status anyway,
        // and the upsert keeps whichever backgrounded flag was already stored.
        backgrounded: false,
      };

    default:
      return null;
  }
}
