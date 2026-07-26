/**
 * Shared Activity projection for timeline Working row + right-panel Activity.
 * Pure: no React, no store writes. SOU-386 PR2.
 */
import type { TurnId } from "@t3tools/contracts";

import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "./session-logic";

export type ThreadActivityStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "info";

export interface ThreadActivityStep {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: ThreadActivityStepStatus;
  readonly createdAt: string;
  readonly turnId?: TurnId | null;
  readonly tone: WorkLogEntry["tone"];
  readonly isToolLike: boolean;
}

export interface ThreadActivityCurrentStep {
  readonly label: string;
  readonly detail?: string;
  readonly startedAt: string | null;
  readonly source: "tool" | "thinking" | "working" | "approval" | "user-input" | "error";
}

export interface ThreadActivityViewModel {
  readonly isWorking: boolean;
  readonly elapsedStartedAt: string | null;
  readonly current: ThreadActivityCurrentStep | null;
  readonly recentSteps: ReadonlyArray<ThreadActivityStep>;
  readonly attention:
    | { readonly kind: "approval"; readonly label: string }
    | { readonly kind: "user-input"; readonly label: string }
    | { readonly kind: "error"; readonly label: string }
    | null;
  readonly hasAuthoritativeMcpStatus: false;
}

const MAX_RECENT_STEPS = 24;
const MAX_ACTIVITY_DETAIL_CHARS = 140;

/** Compact detail for the Activity panel: single line, hard-capped, no wall of text. */
function formatActivityDetail(detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= MAX_ACTIVITY_DETAIL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ACTIVITY_DETAIL_CHARS - 1).trimEnd()}…`;
}

function stepStatusFromWorkEntry(
  entry: WorkLogEntry,
  options: { turnActive: boolean },
): ThreadActivityStepStatus {
  if (entry.tone === "error" || workEntryIndicatesToolFailure(entry)) {
    return "failed";
  }
  // Only explicit in-progress lifecycle may spin — and only while the turn is
  // still active. Settled turns must never leave zombie loaders.
  if (entry.toolLifecycleStatus === "inProgress") {
    return options.turnActive ? "running" : "completed";
  }
  if (entry.toolLifecycleStatus === "stopped") {
    return "interrupted";
  }
  if (entry.toolLifecycleStatus === "completed" || workEntryIndicatesToolSuccess(entry)) {
    return "completed";
  }
  if (entry.tone === "thinking" || workEntryIndicatesToolNeutralStatus(entry)) {
    return "info";
  }
  return "info";
}

function toActivityStep(entry: WorkLogEntry, options: { turnActive: boolean }): ThreadActivityStep {
  const detail = formatActivityDetail(entry.detail);
  return {
    id: entry.id,
    label: (entry.toolTitle ?? entry.label).trim() || "Step",
    ...(detail ? { detail } : {}),
    status: stepStatusFromWorkEntry(entry, options),
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    tone: entry.tone,
    isToolLike: workLogEntryIsToolLike(entry),
  };
}

function collectWorkEntries(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unsettledTurnId: TurnId | null,
): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "work") continue;
    const entry = timelineEntry.entry;
    if (unsettledTurnId !== null && entry.turnId != null && entry.turnId !== unsettledTurnId) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

export function deriveThreadActivityViewModel(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly activeTurnStartedAt: string | null;
  readonly unsettledTurnId?: TurnId | null;
  readonly activeToolLabel?: string | null;
  readonly hasPendingApproval?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly threadError?: string | null;
}): ThreadActivityViewModel {
  const unsettledTurnId = input.unsettledTurnId ?? null;
  const turnActive = input.isWorking;
  const workEntries = collectWorkEntries(input.timelineEntries, unsettledTurnId);
  const recentSteps = workEntries
    .slice(-MAX_RECENT_STEPS)
    .map((entry) => toActivityStep(entry, { turnActive }));

  let current: ThreadActivityCurrentStep | null = null;
  if (input.isWorking) {
    const runningTool = [...workEntries]
      .reverse()
      .find((entry) => workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "inProgress");
    const thinking = [...workEntries]
      .reverse()
      .find((entry) => entry.tone === "thinking" || entry.sourceActivityKind === "task.progress");

    // Only an explicit in-progress tool is Current. Do not promote the last
    // finished tool (activeToolLabel fallback) — that left Searched/Read rows
    // spinning in Current after they had already completed.
    if (runningTool) {
      const detail = formatActivityDetail(runningTool.detail);
      current = {
        label: (runningTool.toolTitle ?? runningTool.label ?? "Working").trim(),
        ...(detail ? { detail } : {}),
        startedAt: runningTool.createdAt ?? input.activeTurnStartedAt,
        source: "tool",
      };
    } else if (thinking) {
      const detail = formatActivityDetail(thinking.detail);
      current = {
        label: thinking.label.trim() || "Thinking",
        ...(detail ? { detail } : {}),
        startedAt: thinking.createdAt,
        source: "thinking",
      };
    } else {
      current = {
        label: "Working",
        startedAt: input.activeTurnStartedAt,
        source: "working",
      };
    }
  }

  let attention: ThreadActivityViewModel["attention"] = null;
  if (input.hasPendingApproval) {
    attention = { kind: "approval", label: "Approval required" };
  } else if (input.hasPendingUserInput) {
    attention = { kind: "user-input", label: "Input required" };
  } else if (input.threadError?.trim()) {
    attention = { kind: "error", label: input.threadError.trim() };
  }

  return {
    isWorking: input.isWorking,
    elapsedStartedAt: input.isWorking ? input.activeTurnStartedAt : null,
    current,
    recentSteps,
    attention,
    hasAuthoritativeMcpStatus: false,
  };
}
