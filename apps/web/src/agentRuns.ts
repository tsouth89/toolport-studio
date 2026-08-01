import type { OrchestrationThreadActivity } from "@toolport-studio/contracts";

export type AgentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "unknown";

export interface AgentRunActivity {
  id: string;
  summary: string;
  kind: string;
  createdAt: string;
  tone: OrchestrationThreadActivity["tone"];
}

export interface AgentRun {
  id: string;
  parentId: string | null;
  providerThreadId: string | null;
  label: string;
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  message: string | null;
  status: AgentRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  canInspectThread: boolean;
  depth: number;
  activities: AgentRunActivity[];
}

const AGENT_STATUSES = new Set<AgentRunStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "unknown",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function status(value: unknown): AgentRunStatus {
  return typeof value === "string" && AGENT_STATUSES.has(value as AgentRunStatus)
    ? (value as AgentRunStatus)
    : "unknown";
}

function activityOrder(left: OrchestrationThreadActivity, right: OrchestrationThreadActivity) {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function deriveAgentRuns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<AgentRun> {
  const runs = new Map<string, AgentRun>();
  const orderedActivities = [...activities].sort(activityOrder);

  for (const activity of orderedActivities) {
    if (!activity.kind.startsWith("agent.")) continue;
    const payload = asRecord(activity.payload);
    const id = text(payload?.agentRunId);
    if (!payload || !id) continue;
    const previous = runs.get(id);
    const nextStatus = status(payload.status);
    runs.set(id, {
      id,
      parentId: text(payload.parentAgentRunId) ?? previous?.parentId ?? null,
      providerThreadId: text(payload.providerThreadId) ?? previous?.providerThreadId ?? null,
      label: text(payload.label) ?? previous?.label ?? "Agent",
      prompt: text(payload.prompt) ?? previous?.prompt ?? null,
      model: text(payload.model) ?? previous?.model ?? null,
      reasoningEffort: text(payload.reasoningEffort) ?? previous?.reasoningEffort ?? null,
      message: text(payload.message) ?? previous?.message ?? null,
      status: nextStatus,
      startedAt: previous?.startedAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
      completedAt:
        activity.kind === "agent.completed" ? activity.createdAt : (previous?.completedAt ?? null),
      canInspectThread:
        typeof payload.canInspectThread === "boolean"
          ? payload.canInspectThread
          : (previous?.canInspectThread ?? false),
      depth: 0,
      activities: previous?.activities ?? [],
    });
  }

  for (const activity of orderedActivities) {
    const payload = asRecord(activity.payload);
    const agentRunId = text(payload?.agentRunId);
    if (!agentRunId) continue;
    const run = runs.get(agentRunId);
    if (!run) continue;
    run.activities.push({
      id: String(activity.id),
      summary: activity.summary,
      kind: activity.kind,
      createdAt: activity.createdAt,
      tone: activity.tone,
    });
  }

  const children = new Map<string | null, AgentRun[]>();
  for (const run of runs.values()) {
    const parentId = run.parentId && runs.has(run.parentId) ? run.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(run);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  const flattened: AgentRun[] = [];
  const visit = (run: AgentRun, depth: number) => {
    run.depth = depth;
    flattened.push(run);
    for (const child of children.get(run.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return flattened;
}
