import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@toolport-studio/contracts";
import {
  deriveToolActivityPresentation,
  humanizeToolDisplayName,
  type ToolActivityTense,
} from "@toolport-studio/shared/toolActivity";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  // Thinking/progress rows are collapsible narration, not tool calls. Keep them
  // out of tool-count grouping and neutral-tool hiding so they stay visible
  // mid-turn (native Grok terminal parity).
  if (entry.tone === "thinking") {
    return false;
  }
  if (entry.tone === "tool" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Headlines that name no specific action — a better label may replace them. */
const GENERIC_WORK_LOG_TOOL_LABELS = new Set([
  "calling a tool",
  "calling an agent",
  "ran a command",
  "ran a tool",
  "running a command",
  "running a tool",
  "step",
  "terminal",
  "tool",
  "tool call",
  "toolcall",
]);

export function isGenericWorkLogToolLabel(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:complete|completed|started|updated)\s*$/u, "")
    .trim();
  return normalized.length === 0 || GENERIC_WORK_LOG_TOOL_LABELS.has(normalized);
}

/** Open tools narrate in the present ("Running git log"); settled ones in the past. */
export function workLogEntryTense(entry: WorkLogEntry): ToolActivityTense {
  return entry.toolLifecycleStatus === "inProgress" ? "present" : "past";
}

function looksLikeWorkLogDump(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("{") || trimmed.includes("\n") || /["']\s*:\s*["']/.test(trimmed)) {
    return true;
  }
  if (trimmed.length > 96) {
    return true;
  }
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

function truncateWorkLogContext(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function isThinkingWorkLogEntry(entry: WorkLogEntry): boolean {
  if (entry.tone === "thinking") {
    return true;
  }
  const title = (entry.toolTitle ?? "").trim().toLowerCase();
  return title === "thinking" || title === "thought";
}

/**
 * Grok Build-style thought headline. When a duration is known (next activity
 * timestamp), prefer "Thought for 3.4s"; otherwise plain "Thought".
 */
export function formatWorkLogThoughtLine(durationLabel?: string | null): string {
  const duration = durationLabel?.trim();
  if (duration && duration.length > 0) {
    return `Thought for ${duration}`;
  }
  return "Thought";
}

/**
 * Tool + thinking rows that form the live narration stack (Grok Build rail).
 * Kept expanded together so mid-turn Thought / Run lines stay scannable.
 */
export function workLogEntryIsNarrationStackEntry(entry: WorkLogEntry): boolean {
  return workLogEntryIsToolLike(entry) || isThinkingWorkLogEntry(entry);
}

/**
 * Timeline heading for work rows — always verb-first, never argv:
 * - Thinking → "Thought" (callers may append duration via formatWorkLogThoughtLine)
 * - Tools → "Ran git log +2 more" / "Read app.ts" / "Searched …"
 * Open tools narrate in the present ("Running git log").
 */
export function formatWorkLogTimelineLine(
  entry: WorkLogEntry,
  tense: ToolActivityTense = workLogEntryTense(entry),
): string {
  if (isThinkingWorkLogEntry(entry)) {
    return tense === "present" ? "Thinking" : "Thought";
  }
  return formatWorkLogToolLabel(entry, tense);
}

/**
 * Human tool name for Working row + Activity. Prefers structured presentation
 * (itemType/command/path) so wire titles and generic "Tool" never win over
 * scannable "Ran …" / "Read …" lines. Humanizes MCP wire names.
 */
export function formatWorkLogToolLabel(
  entry: WorkLogEntry,
  tense: ToolActivityTense = workLogEntryTense(entry),
): string {
  if (isThinkingWorkLogEntry(entry)) {
    return tense === "present" ? "Thinking" : "Thought";
  }

  const rawTitle = (entry.toolTitle ?? entry.label)
    .replace(/\s+(?:complete|completed|started|updated)\s*$/iu, "")
    .trim();
  const presentation = deriveToolActivityPresentation({
    itemType: entry.itemType,
    title: rawTitle || entry.toolTitle || entry.label,
    detail: entry.detail,
    tense,
    data: {
      ...(entry.toolData && typeof entry.toolData === "object" ? { item: entry.toolData } : {}),
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.changedFiles && entry.changedFiles.length > 0
        ? { locations: entry.changedFiles.map((path) => ({ path })) }
        : {}),
    },
    fallbackSummary: entry.label,
  });
  const summary = presentation.summary
    .trim()
    .replace(/\s+(?:complete|completed|started|updated)\s*$/iu, "")
    .trim();
  if (!isGenericWorkLogToolLabel(summary)) {
    return humanizeToolDisplayName(summary);
  }

  if (!isGenericWorkLogToolLabel(rawTitle)) {
    return humanizeToolDisplayName(rawTitle);
  }
  // Both are generic, but "Running a command" still says more than "a tool".
  if (summary.length > 0) {
    return summary;
  }
  return tense === "present" ? "Running a tool" : "Ran a tool";
}

/** Short real context (command / path) — never dumps. */
export function formatWorkLogToolContext(entry: WorkLogEntry): string | undefined {
  if (entry.command?.trim()) {
    return truncateWorkLogContext(entry.command);
  }
  if (entry.changedFiles?.[0]) {
    const first = entry.changedFiles[0]!;
    const extra = entry.changedFiles.length - 1;
    return truncateWorkLogContext(extra > 0 ? `${first} +${extra} more` : first);
  }
  const detail = entry.detail?.trim();
  if (!detail || looksLikeWorkLogDump(detail) || isGenericWorkLogToolLabel(detail)) {
    return undefined;
  }
  return truncateWorkLogContext(detail);
}

/**
 * Tools that legitimately stay quiet for a long time (shell, monitors, CI wait).
 * Used to suppress early "quiet" notices in the Working row.
 */
export function workEntryLooksLongRunning(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (entry.itemType === "command_execution") {
    return true;
  }
  if (entry.command?.trim()) {
    return true;
  }
  const label = formatWorkLogToolLabel(entry).toLowerCase();
  return (
    /\bmonitor\b/.test(label) ||
    /\bwatching\b/.test(label) ||
    /\bwait(?:ing)?\b/.test(label) ||
    /\bci\b/.test(label) ||
    /\bpoll\b/.test(label) ||
    label.startsWith("start monitor") ||
    label.startsWith("ran ") ||
    label.startsWith("running ")
  );
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) {
    return true;
  }
  if (t.includes("no files found")) {
    return true;
  }
  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }
  if (t.includes("cannot find path") && t.includes("because it does not exist")) {
    return true;
  }
  if (t.includes("commandnotfoundexception")) {
    return true;
  }
  if (t.includes("is not recognized as the name of a cmdlet")) {
    return true;
  }
  if (t.includes("is not recognized") && t.includes("the term '")) {
    return true;
  }
  if (t.includes("a parameter cannot be found that matches parameter name")) {
    return true;
  }
  if (t.includes("command not found")) {
    return true;
  }
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) {
    return true;
  }
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) {
    return true;
  }
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) {
    return true;
  }
  return false;
}

/** True when the row should show a failure affordance (explicit status/tone or error-shaped tool output). */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  const parts: string[] = [];
  if (entry.detail) {
    parts.push(entry.detail);
  }
  if (entry.command) {
    parts.push(entry.command);
  }
  const blob = parts.join("\n");
  if (blob.length === 0) {
    return false;
  }
  return toolDetailTextLooksLikeFailure(blob);
}

/** Tool/command row completed without failure (blue check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return false;
  }
  if (ls === "inProgress") {
    return false;
  }
  if (ls === "stopped") {
    return false;
  }
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return false;
  }
  return true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt" | "requestedAt"
>;
type SessionActivityState = Pick<
  NonNullable<Thread["session"]>,
  "status" | "activeTurnId" | "updatedAt"
>;

function firstValidIsoTimestamp(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate.length === 0) {
      continue;
    }
    if (Number.isFinite(Date.parse(candidate))) {
      return candidate;
    }
  }
  return null;
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  _session: SessionActivityState | null,
): boolean {
  // Turn timestamps are authoritative. Sticky provider session.status ===
  // "running" after completedAt used to keep Working chrome forever, block
  // queue drain, and hide plan banners even though the turn had finished.
  // Live work is tracked separately via session phase / isWorking.
  if (!latestTurn?.startedAt) return false;
  // ...but completedAt alone does not mean settled: every mid-turn checkpoint
  // diff stamps a PLACEHOLDER completedAt on a turn that is still running (see
  // the thread.session-set branch in threadReducer). Reading the timestamp
  // without the state made the first checkpoint of a turn settle it — the
  // Working row vanished while the provider kept streaming, and never came
  // back because the placeholder is retained for the rest of the turn.
  // `state` is the authoritative lifecycle signal; the timestamp is not.
  if (latestTurn.state === "running") return false;
  return latestTurn.completedAt != null;
}

/**
 * Anchor for the live "Working · 3m 42s" timer. Prefer the provider turn's
 * startedAt, then requestedAt, then local send, then session.updatedAt so the
 * total run time is almost always visible during a live turn.
 */
export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const turnAnchor = latestTurn
    ? firstValidIsoTimestamp(latestTurn.startedAt, latestTurn.requestedAt)
    : null;
  const sessionClock = firstValidIsoTimestamp(session?.updatedAt);
  const runningTurnId =
    session?.status === "running" || session?.status === "starting" ? session.activeTurnId : null;

  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return firstValidIsoTimestamp(turnAnchor, sendStartedAt, sessionClock);
    }
    // Session already moved to a new turn id before latestTurn projected.
    return firstValidIsoTimestamp(sendStartedAt, sessionClock, turnAnchor);
  }

  if (!isLatestTurnSettled(latestTurn, session)) {
    return firstValidIsoTimestamp(turnAnchor, sendStartedAt, sessionClock);
  }

  return firstValidIsoTimestamp(sendStartedAt);
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

/** Quiet notice when auto-cancel fires for unanswered approval / AskUserQuestion. */
export function isPendingRequestTimeoutWarningMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string" || message.length === 0) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timed out") &&
    (normalized.includes("permission request") ||
      normalized.includes("user input") ||
      normalized.includes("cancelled automatically"))
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({
      step: record.step,
      status,
    });
  }
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    if (activity.kind === "task.started") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return collapseDerivedWorkLogEntries(entries).map((entry) => {
    const { activityKind, collapseKey: _collapseKey, ...rest } = entry;
    return Object.assign(rest, { sourceActivityKind: activityKind });
  });
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  if (!payload) {
    return undefined;
  }
  const s = payload.status;
  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }
  return undefined;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  const payloadData = asRecord(payload?.data);
  // Codex stamps MCP as `mcp_tool_call` with `data.item.{server,tool}`.
  // Grok/ACP stamps gateway tools as `dynamic_tool_call` with `data.rawInput`
  // (wire name + args). Activity "used this turn" needs either shape — not
  // shell/command payloads (those stay command/detail only).
  if (payloadData && (itemType === "mcp_tool_call" || itemType === "dynamic_tool_call")) {
    const item = payloadData.item;
    entry.toolData =
      item !== undefined && item !== null && typeof item === "object" ? item : payloadData;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }

  // Key off what the provider sent, before any label rewrite below: a mid-stream
  // update that first carries a command would otherwise change the derived label
  // and stop collapsing into the same tool row.
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }

  // Only rewrite when the provider left a generic "Tool" label. Keep specific
  // titles (bash, grep, MCP server · tool) intact for the timeline.
  const displaySeed = title ?? activity.summary;
  if (
    !isTaskActivity &&
    (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
    isGenericWorkLogToolLabel(displaySeed)
  ) {
    const presentationData: Record<string, unknown> = {
      ...payloadData,
      ...(commandPreview.command ? { command: commandPreview.command } : {}),
      ...(changedFiles.length > 0 ? { locations: changedFiles.map((path) => ({ path })) } : {}),
    };
    const presentation = deriveToolActivityPresentation({
      itemType,
      title: displaySeed,
      detail: entry.detail,
      data: presentationData,
      fallbackSummary: activity.summary,
    });
    if (!isGenericWorkLogToolLabel(presentation.summary)) {
      entry.toolTitle = presentation.summary;
      entry.label = presentation.summary;
    }
    if (presentation.detail) {
      if (!entry.detail || isGenericWorkLogToolLabel(entry.detail) || entry.detail === title) {
        entry.detail = presentation.detail;
      }
    }
  }

  return entry;
}

function isTerminalToolLifecycleStatus(status: WorkLogToolLifecycleStatus | undefined): boolean {
  return (
    status === "completed" || status === "failed" || status === "declined" || status === "stopped"
  );
}

function isToolLifecycleActivityKind(
  kind: OrchestrationThreadActivity["kind"] | undefined,
): boolean {
  return kind === "tool.updated" || kind === "tool.completed";
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Open (non-terminal) row index per collapse key. Adjacent-only merge left
  // concurrent tools stuck inProgress when another tool updated in between.
  const openIndexByKey = new Map<string, number>();

  for (const entry of entries) {
    const key = entry.collapseKey;
    if (key && isToolLifecycleActivityKind(entry.activityKind)) {
      const openIdx = openIndexByKey.get(key);
      if (openIdx !== undefined) {
        const previous = collapsed[openIdx];
        if (
          previous &&
          isToolLifecycleActivityKind(previous.activityKind) &&
          previous.activityKind !== "tool.completed" &&
          !isTerminalToolLifecycleStatus(previous.toolLifecycleStatus)
        ) {
          const merged = mergeDerivedWorkLogEntries(previous, entry);
          collapsed[openIdx] = merged;
          if (
            entry.activityKind === "tool.completed" ||
            isTerminalToolLifecycleStatus(merged.toolLifecycleStatus)
          ) {
            openIndexByKey.delete(key);
          }
          continue;
        }
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[collapsed.length - 1] = merged;
      const prevKey = previous.collapseKey ?? merged.collapseKey;
      if (prevKey) {
        if (
          entry.activityKind === "tool.completed" ||
          isTerminalToolLifecycleStatus(merged.toolLifecycleStatus)
        ) {
          openIndexByKey.delete(prevKey);
        } else {
          openIndexByKey.set(prevKey, collapsed.length - 1);
        }
      }
      continue;
    }

    collapsed.push(entry);

    if (
      key &&
      isToolLifecycleActivityKind(entry.activityKind) &&
      entry.activityKind !== "tool.completed" &&
      !isTerminalToolLifecycleStatus(entry.toolLifecycleStatus)
    ) {
      openIndexByKey.set(key, collapsed.length - 1);
    }
  }

  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isToolLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  if (!isToolLifecycleActivityKind(next.activityKind)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (isTerminalToolLifecycleStatus(previous.toolLifecycleStatus)) {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  // The terminal update usually drops the command that an earlier update carried.
  // Prefer whichever side actually named the action so the collapsed row keeps
  // "Ran sed" instead of falling back to the provider's generic "Tool call".
  const label =
    isGenericWorkLogToolLabel(next.label) && !isGenericWorkLogToolLabel(previous.label)
      ? previous.label
      : next.label;
  const displayTitle =
    isGenericWorkLogToolLabel(toolTitle) && !isGenericWorkLogToolLabel(previous.toolTitle)
      ? previous.toolTitle
      : toolTitle;
  return {
    ...previous,
    ...next,
    label,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(displayTitle ? { toolTitle: displayTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  if (!/[\s"'`]/.test(value)) {
    return value;
  }
  // Inside double quotes a backslash only changes meaning when it precedes a
  // quote — including the closing one, so escaping just `"` lets a value
  // ending in `\` render as `"a\"` and swallow the rest of the command.
  // Doubling only those runs leaves ordinary paths like C:\Program Files\x
  // readable instead of backslash-doubling every Windows path.
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: Array<string> = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== null) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }
  const topLevel = asTrimmedString(payload.toolCallId);
  if (topLevel) {
    return topLevel;
  }
  const data = asRecord(payload.data);
  if (!data) {
    return null;
  }
  const fromData = asTrimmedString(data.toolCallId);
  if (fromData) {
    return fromData;
  }
  const item = asRecord(data.item);
  return asTrimmedString(item?.toolCallId) ?? asTrimmedString(item?.id);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: Array<string> = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = normalizeInlinePreview(rawLine);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

/**
 * True only for path-like *files*, not prose, directory roots, or shell noise.
 * Used for work-log → Activity Changed files (checkpoint stats are authoritative).
 */
export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (trimmed.length === 0 || trimmed.length > 512) {
    return false;
  }
  // Reject JSON, multi-line dumps, and sentences (slash in prose is common).
  if (trimmed.includes("\n") || trimmed.includes("{") || trimmed.includes("}")) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  // Reject obvious prose / prompt fragments that include a slash.
  if (
    /^(the|a|an|i|we|you|user|please|implement|fix|add|update)\b/i.test(trimmed) ||
    /\b(asking|about|should|would|could|gaps?)\b/i.test(trimmed)
  ) {
    return false;
  }

  const normalized = trimmed.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  const basename = segments.at(-1) ?? "";
  // Dotfiles (`.gitignore`) and files with extensions only — not bare directories.
  if (basename.startsWith(".") && basename.length > 1) {
    return true;
  }
  if (!/\.[a-z0-9]{1,16}$/i.test(basename)) {
    return false;
  }
  // Need a path-ish shape or a plain relative filename.
  return (
    normalized.includes("/") ||
    normalized.startsWith(".") ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.length === 1
  );
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized) || !looksLikeFilePath(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        pushChangedFile(target, seen, entry);
        continue;
      }
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  // ACP tool calls put paths under `locations` (and sometimes rawInput).
  // Missing `locations` left Activity "Changed files" empty while Recent
  // still showed "Changed files" tool rows from kind/title presentation.
  for (const nestedKey of [
    "locations",
    "rawInput",
    "rawOutput",
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  // Some providers put a single path only in detail / title presentation seed.
  if (changedFiles.length === 0 && payload) {
    pushChangedFile(changedFiles, seen, payload.detail);
    pushChangedFile(changedFiles, seen, payload.title);
  }
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: ReadonlyArray<TurnDiffSummary>,
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (
    !session ||
    session.status === "stopped" ||
    session.status === "interrupted" ||
    session.status === "error"
  ) {
    return "disconnected";
  }
  if (session.status === "starting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

/**
 * Session phase for composer/queue/Working decisions. When the provider leaves
 * session.status stuck on "running" for a turn that already has completedAt
 * (Grok hang after tokens stop), treat the session as ready so Enter sends
 * instead of queueing forever and the queue can drain.
 *
 * The escape hatch must not fire on a turn that is genuinely still running: a
 * mid-turn checkpoint diff stamps a placeholder completedAt while state stays
 * "running", which satisfied every other condition here and downgraded live
 * Codex turns to "ready" (Working row gone, output still streaming).
 */
export function deriveComposerPhase(
  session: ThreadSession | null,
  latestTurn: LatestTurnTiming | null,
): SessionPhase {
  const base = derivePhase(session);
  if (base !== "running") {
    return base;
  }
  if (
    latestTurn?.startedAt != null &&
    latestTurn.completedAt != null &&
    latestTurn.state !== "running" &&
    session?.activeTurnId != null &&
    session.activeTurnId === latestTurn.turnId
  ) {
    return "ready";
  }
  return base;
}
