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

function stepStatusFromWorkEntry(entry: WorkLogEntry): ThreadActivityStepStatus {
  if (entry.tone === "error" || workEntryIndicatesToolFailure(entry)) {
    return "failed";
  }
  if (entry.toolLifecycleStatus === "inProgress" || workEntryIndicatesToolNeutralStatus(entry)) {
    return "running";
  }
  if (entry.toolLifecycleStatus === "completed" || workEntryIndicatesToolSuccess(entry)) {
    return "completed";
  }
  if (entry.tone === "thinking") {
    return "info";
  }
  return "info";
}

function toActivityStep(entry: WorkLogEntry): ThreadActivityStep {
  return {
    id: entry.id,
    label: (entry.toolTitle ?? entry.label).trim() || "Step",
    ...(entry.detail?.trim() ? { detail: entry.detail.trim() } : {}),
    status: stepStatusFromWorkEntry(entry),
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
  const workEntries = collectWorkEntries(input.timelineEntries, unsettledTurnId);
  const recentSteps = workEntries.slice(-MAX_RECENT_STEPS).map(toActivityStep);

  let current: ThreadActivityCurrentStep | null = null;
  if (input.isWorking) {
    const runningTool = [...workEntries]
      .reverse()
      .find(
        (entry) =>
          workLogEntryIsToolLike(entry) &&
          (entry.toolLifecycleStatus === "inProgress" ||
            workEntryIndicatesToolNeutralStatus(entry)),
      );
    const thinking = [...workEntries]
      .reverse()
      .find((entry) => entry.tone === "thinking" || entry.sourceActivityKind === "task.progress");
    const toolLabel = input.activeToolLabel?.trim() || null;

    if (runningTool || toolLabel) {
      current = {
        label: toolLabel || (runningTool?.toolTitle ?? runningTool?.label ?? "Working").trim(),
        ...(runningTool?.detail?.trim() ? { detail: runningTool.detail.trim() } : {}),
        startedAt: runningTool?.createdAt ?? input.activeTurnStartedAt,
        source: "tool",
      };
    } else if (thinking) {
      current = {
        label: thinking.label.trim() || "Thinking",
        ...(thinking.detail?.trim() ? { detail: thinking.detail.trim() } : {}),
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
