/**
 * Shared Activity projection for timeline Working row + right-panel Activity.
 * Pure: no React, no store writes. SOU-386 PR2+ (mockup-shaped recent list).
 */
import type { TurnId } from "@t3tools/contracts";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";

import { summarizeTurnDiffStats } from "./lib/turnDiffTree";
import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "./session-logic";
import type { TurnDiffFileChange, TurnDiffSummary } from "./types";

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
  /** Short subtitle only when useful (failures). Prefer empty for quiet mockup rows. */
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

export interface ThreadActivityChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ThreadActivityChangedFiles {
  readonly turnId: TurnId;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  /** Preview rows for the panel (capped). Full set lives in Diff panel. */
  readonly files: ReadonlyArray<ThreadActivityChangedFile>;
  readonly hasStats: boolean;
  readonly source: "checkpoint" | "work-log";
}

export interface ThreadActivityViewModel {
  readonly isWorking: boolean;
  readonly elapsedStartedAt: string | null;
  readonly current: ThreadActivityCurrentStep | null;
  readonly recentSteps: ReadonlyArray<ThreadActivityStep>;
  readonly changedFiles: ThreadActivityChangedFiles | null;
  readonly attention:
    | { readonly kind: "approval"; readonly label: string }
    | { readonly kind: "user-input"; readonly label: string }
    | { readonly kind: "error"; readonly label: string }
    | null;
  readonly hasAuthoritativeMcpStatus: false;
}

/** Mockup-scale: short instrument list, not a transcript. */
const MAX_RECENT_STEPS = 8;
const MAX_ACTIVITY_DETAIL_CHARS = 96;
const MAX_CHANGED_FILE_PREVIEW = 5;

/** Compact detail: single line, hard-capped. */
export function formatActivityDetail(detail: string | undefined): string | undefined {
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

/**
 * Recent steps keep tools + hard milestones only.
 * Thinking spam, plan thrash, and "Changed files" noise belong elsewhere
 * (or only as Current while live).
 */
export function isActivityRecentMilestone(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  if (workLogEntryIsToolLike(entry)) {
    return true;
  }
  const label = entry.label.trim();
  if (/^session started$/i.test(label)) {
    return true;
  }
  return false;
}

function stepStatusFromWorkEntry(
  entry: WorkLogEntry,
  options: { turnActive: boolean },
): ThreadActivityStepStatus {
  if (entry.tone === "error" || workEntryIndicatesToolFailure(entry)) {
    return "failed";
  }
  if (entry.toolLifecycleStatus === "inProgress") {
    return options.turnActive ? "running" : "completed";
  }
  if (entry.toolLifecycleStatus === "stopped") {
    return "interrupted";
  }
  if (entry.toolLifecycleStatus === "completed" || workEntryIndicatesToolSuccess(entry)) {
    return "completed";
  }
  if (
    entry.tone === "thinking" ||
    entry.tone === "info" ||
    workEntryIndicatesToolNeutralStatus(entry)
  ) {
    return "info";
  }
  return "info";
}

function isGenericActivityLabel(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:complete|completed|started|updated)\s*$/u, "")
    .trim();
  return (
    normalized.length === 0 ||
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "toolcall" ||
    normalized === "step" ||
    normalized === "terminal"
  );
}

function looksLikeRawDump(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("{") || trimmed.includes("\n") || /["']\s*:\s*["']/.test(trimmed)) {
    return true;
  }
  if (trimmed.length > 96) {
    return true;
  }
  // Long camelCase / jammed identifiers without path separators are dumps, not subtitles.
  if (
    trimmed.length > 36 &&
    !trimmed.includes(" ") &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  ) {
    return true;
  }
  return false;
}

/** Best human tool name from real entry fields — never invent free text. */
function stepLabel(entry: WorkLogEntry): string {
  const raw = (entry.toolTitle ?? entry.label).trim();
  if (!workLogEntryIsToolLike(entry)) {
    return raw || "Step";
  }
  // Keep specific provider titles (Linear · list issues, bash, grep).
  if (!isGenericActivityLabel(raw)) {
    return raw;
  }

  const presentation = deriveToolActivityPresentation({
    itemType: entry.itemType,
    title: entry.toolTitle ?? entry.label,
    detail: entry.detail,
    data: {
      ...(entry.toolData && typeof entry.toolData === "object" ? { item: entry.toolData } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.changedFiles && entry.changedFiles.length > 0
        ? { locations: entry.changedFiles.map((path) => ({ path })) }
        : {}),
    },
    fallbackSummary: entry.label,
  });

  const summary = presentation.summary.trim();
  if (!isGenericActivityLabel(summary)) {
    return summary;
  }
  return "Tool call";
}

/** Prefer a short command / path over raw tool dumps for Current subtitle. */
function currentStepDetail(entry: WorkLogEntry): string | undefined {
  const command = formatActivityDetail(entry.command);
  if (command) {
    return command;
  }
  if (entry.changedFiles?.[0]) {
    const first = entry.changedFiles[0]!;
    const extra = entry.changedFiles.length - 1;
    return formatActivityDetail(extra > 0 ? `${first} +${extra} more` : first);
  }
  const detail = entry.detail?.trim();
  if (!detail || looksLikeRawDump(detail) || isGenericActivityLabel(detail)) {
    return undefined;
  }
  return formatActivityDetail(detail);
}

/**
 * Recent rows: label + optional short real context (path/command/query).
 * Failures keep a one-line reason. No JSON dumps.
 */
function recentStepDetail(
  entry: WorkLogEntry,
  status: ThreadActivityStepStatus,
): string | undefined {
  if (status === "failed" || status === "interrupted") {
    return formatActivityDetail(entry.detail ?? entry.command);
  }
  if (entry.command) {
    return formatActivityDetail(entry.command);
  }
  if (entry.changedFiles?.[0]) {
    const first = entry.changedFiles[0]!;
    const extra = entry.changedFiles.length - 1;
    return formatActivityDetail(extra > 0 ? `${first} +${extra} more` : first);
  }
  const detail = entry.detail?.trim();
  if (!detail || looksLikeRawDump(detail) || isGenericActivityLabel(detail)) {
    return undefined;
  }
  return formatActivityDetail(detail);
}

function toActivityStep(entry: WorkLogEntry, options: { turnActive: boolean }): ThreadActivityStep {
  const status = stepStatusFromWorkEntry(entry, options);
  const detail = recentStepDetail(entry, status);
  return {
    id: entry.id,
    label: stepLabel(entry),
    ...(detail ? { detail } : {}),
    status,
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

function selectRecentMilestones(workEntries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const milestones = workEntries.filter(isActivityRecentMilestone);
  if (milestones.length <= MAX_RECENT_STEPS) {
    return milestones;
  }
  return milestones.slice(-MAX_RECENT_STEPS);
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .trim();
}

function toChangedFileRow(file: TurnDiffFileChange): ThreadActivityChangedFile {
  return {
    path: normalizeRelativePath(file.path) || file.path,
    additions: typeof file.additions === "number" ? file.additions : 0,
    deletions: typeof file.deletions === "number" ? file.deletions : 0,
  };
}

function pickCheckpointSummary(
  summaries: ReadonlyArray<TurnDiffSummary>,
  preferredTurnId: TurnId | null,
): TurnDiffSummary | null {
  const withFiles = summaries.filter((summary) => summary.files.length > 0);
  if (withFiles.length === 0) {
    return null;
  }
  if (preferredTurnId != null) {
    const match = withFiles.find((summary) => summary.turnId === preferredTurnId);
    if (match) {
      return match;
    }
  }
  // Prefer highest checkpoint turn count, then latest completedAt.
  return [...withFiles].toSorted((left, right) => {
    if (left.checkpointTurnCount !== right.checkpointTurnCount) {
      return right.checkpointTurnCount - left.checkpointTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  })[0]!;
}

function looksLikeActivityFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return false;
  }
  if (trimmed.includes("\n") || trimmed.includes("{")) {
    return false;
  }
  return (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.startsWith(".") ||
    /\.[a-z0-9]{1,12}$/i.test(trimmed)
  );
}

function collectWorkLogChangedPaths(
  workEntries: ReadonlyArray<WorkLogEntry>,
  preferredTurnId: TurnId | null,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) {
      return;
    }
    const path = normalizeRelativePath(raw);
    if (path.length === 0 || seen.has(path) || !looksLikeActivityFilePath(path)) {
      return;
    }
    seen.add(path);
    paths.push(path);
  };

  for (const entry of workEntries) {
    if (preferredTurnId != null && entry.turnId != null && entry.turnId !== preferredTurnId) {
      continue;
    }
    for (const raw of entry.changedFiles ?? []) {
      push(raw);
    }
    // Fallback: presentation often puts the primary path in detail when the
    // provider only sent ACP locations (and older clients omitted changedFiles).
    const label = (entry.toolTitle ?? entry.label).trim().toLowerCase();
    const isFileEditTool =
      entry.itemType === "file_change" ||
      label === "changed files" ||
      label === "edit file" ||
      label === "write file";
    if (isFileEditTool) {
      push(entry.detail);
    }
  }
  return paths;
}

/**
 * Prefer authoritative checkpoint files (+/-). Fall back to work-log paths
 * when a turn is mid-flight and no checkpoint exists yet.
 */
export function deriveActivityChangedFiles(input: {
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  readonly preferredTurnId: TurnId | null;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
}): ThreadActivityChangedFiles | null {
  const summary = pickCheckpointSummary(input.turnDiffSummaries, input.preferredTurnId);
  if (summary) {
    const stats = summarizeTurnDiffStats(summary.files);
    const files = summary.files.slice(0, MAX_CHANGED_FILE_PREVIEW).map(toChangedFileRow);
    return {
      turnId: summary.turnId,
      fileCount: summary.files.length,
      additions: stats.additions,
      deletions: stats.deletions,
      files,
      hasStats: stats.additions > 0 || stats.deletions > 0,
      source: "checkpoint",
    };
  }

  const paths = collectWorkLogChangedPaths(input.workEntries, input.preferredTurnId);
  if (paths.length === 0) {
    return null;
  }

  // Work-log paths lack a turnId on every entry; use preferred turn when known.
  const turnId = input.preferredTurnId;
  if (turnId == null) {
    return null;
  }

  return {
    turnId,
    fileCount: paths.length,
    additions: 0,
    deletions: 0,
    files: paths.slice(0, MAX_CHANGED_FILE_PREVIEW).map((path) => ({
      path,
      additions: 0,
      deletions: 0,
    })),
    hasStats: false,
    source: "work-log",
  };
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
  readonly turnDiffSummaries?: ReadonlyArray<TurnDiffSummary>;
  /** Settled latest turn id — used when selecting checkpoint / work-log files. */
  readonly latestTurnId?: TurnId | null;
}): ThreadActivityViewModel {
  const unsettledTurnId = input.unsettledTurnId ?? null;
  const turnActive = input.isWorking;
  const workEntries = collectWorkEntries(input.timelineEntries, unsettledTurnId);
  const recentSteps = selectRecentMilestones(workEntries).map((entry) =>
    toActivityStep(entry, { turnActive }),
  );
  const preferredTurnId = unsettledTurnId ?? input.latestTurnId ?? null;
  const changedFiles = deriveActivityChangedFiles({
    turnDiffSummaries: input.turnDiffSummaries ?? [],
    preferredTurnId,
    workEntries,
  });

  let current: ThreadActivityCurrentStep | null = null;
  if (input.isWorking) {
    const runningTool = [...workEntries]
      .reverse()
      .find((entry) => workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "inProgress");
    const thinking = [...workEntries]
      .reverse()
      .find((entry) => entry.tone === "thinking" || entry.sourceActivityKind === "task.progress");
    const lastFinishedTool = [...workEntries]
      .reverse()
      .find(
        (entry) =>
          workLogEntryIsToolLike(entry) &&
          entry.toolLifecycleStatus !== "inProgress" &&
          stepLabel(entry) !== "Tool call",
      );

    // Only an explicit in-progress tool is Current as a tool. Thinking may
    // label Current while tools are quiet; it is not a Recent milestone.
    if (runningTool) {
      const detail = currentStepDetail(runningTool);
      current = {
        label: stepLabel(runningTool),
        ...(detail ? { detail } : {}),
        startedAt: runningTool.createdAt ?? input.activeTurnStartedAt,
        source: "tool",
      };
    } else if (thinking) {
      // No private CoT dump — but we can honestly note the last finished tool.
      const afterLabel = lastFinishedTool ? stepLabel(lastFinishedTool) : null;
      current = {
        label: "Thinking",
        ...(afterLabel && !isGenericActivityLabel(afterLabel)
          ? { detail: `After ${afterLabel}` }
          : {}),
        startedAt: thinking.createdAt,
        source: "thinking",
      };
    } else {
      const afterLabel = lastFinishedTool ? stepLabel(lastFinishedTool) : null;
      current = {
        label: "Working",
        ...(afterLabel && !isGenericActivityLabel(afterLabel)
          ? { detail: `After ${afterLabel}` }
          : {}),
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
    changedFiles,
    attention,
    hasAuthoritativeMcpStatus: false,
  };
}
