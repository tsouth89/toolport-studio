/**
 * Shared Activity projection for timeline Working row + right-panel Activity.
 * Pure: no React, no store writes. SOU-386 PR2+ (mockup-shaped recent list).
 */
import type { ToolportMcpStatus, TurnId } from "@t3tools/contracts";

import { summarizeTurnDiffStats } from "./lib/turnDiffTree";
import {
  formatElapsed,
  formatWorkLogToolContext,
  formatWorkLogToolLabel,
  looksLikeFilePath,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "./session-logic";
import type { ToolActivityTense } from "@t3tools/shared/toolActivity";
import { proposedPlanTitle } from "./proposedPlan";
import type { ProposedPlan, TurnDiffFileChange, TurnDiffSummary } from "./types";

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
  readonly detail?: string | undefined;
  readonly status: ThreadActivityStepStatus;
  readonly createdAt: string;
  readonly turnId?: TurnId | null | undefined;
  readonly tone: WorkLogEntry["tone"];
  readonly isToolLike: boolean;
}

export interface ThreadActivityCurrentStep {
  readonly label: string;
  readonly detail?: string;
  readonly startedAt: string | null;
  readonly source:
    | "tool"
    | "thinking"
    | "working"
    | "approval"
    | "user-input"
    | "error"
    /** Last milestone after the turn settled — not an empty "start a turn" shell. */
    | "settled";
}

/**
 * Header chip for Activity: live elapsed while working, total duration after a
 * turn settles, idle only when the panel has nothing to show for this thread.
 */
export type ThreadActivityStatusBadge =
  | { readonly kind: "elapsed"; readonly startedAt: string }
  | { readonly kind: "done"; readonly durationLabel: string | null }
  | { readonly kind: "idle" };

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

export interface ThreadActivityArtifact {
  readonly id: string;
  readonly label: string;
  readonly kind: "proposed-plan";
  readonly turnId: TurnId | null;
  readonly updatedAt: string;
  readonly implemented: boolean;
}

export type ThreadActivityMcpHealth = "ready" | "disabled" | "offline";

export interface ThreadActivityMcpServer {
  readonly id: string;
  readonly name: string;
  readonly health: ThreadActivityMcpHealth;
  readonly transport: "http" | "stdio" | "unknown";
  readonly source?: string;
  /** Session tool-call hits used for ranking (most used first). */
  readonly useCount: number;
}

export type ThreadActivityMcpInjectionReason =
  | "disabled"
  | "ready"
  | "gateway_not_found"
  | "configured_path_missing";

export interface ThreadActivityMcpStatus {
  readonly gatewayAvailable: boolean;
  readonly activeProfileName: string | null;
  /**
   * Servers that actually ran tools this turn (ranked by use). Empty when the
   * turn has not touched MCP yet — never a full registry dump.
   */
  readonly usedThisTurn: ReadonlyArray<ThreadActivityMcpServer>;
  /**
   * Full ranked preview kept for optional deep inspect. Prefer usedThisTurn in
   * chat surfaces; do not render as a dead inventory list.
   */
  readonly servers: ReadonlyArray<ThreadActivityMcpServer>;
  /** Total servers in Toolport registry (for Open in Toolport copy). */
  readonly totalServerCount: number;
  /** Studio inject toggle (settings / env). */
  readonly injectionEnabled: boolean;
  /** Inject on and gateway binary resolved for provider sessions. */
  readonly injectionReady: boolean;
  readonly injectionReason: ThreadActivityMcpInjectionReason;
}

/** Max MCP names to surface as "used this turn" chips. */
const MAX_MCP_USED_THIS_TURN = 4;

export interface ThreadActivityViewModel {
  readonly isWorking: boolean;
  readonly elapsedStartedAt: string | null;
  readonly statusBadge: ThreadActivityStatusBadge;
  readonly current: ThreadActivityCurrentStep | null;
  readonly recentSteps: ReadonlyArray<ThreadActivityStep>;
  readonly changedFiles: ThreadActivityChangedFiles | null;
  /** Real artifacts only (e.g. proposed plans). Empty → section omitted. */
  readonly artifacts: ReadonlyArray<ThreadActivityArtifact>;
  readonly attention:
    | { readonly kind: "approval"; readonly label: string }
    | { readonly kind: "user-input"; readonly label: string }
    | { readonly kind: "error"; readonly label: string }
    | null;
  /** Toolport registry projection; null when no authoritative status. */
  readonly mcp: ThreadActivityMcpStatus | null;
  readonly hasAuthoritativeMcpStatus: boolean;
}

/** Mockup-scale: short instrument list, not a transcript. */
const MAX_RECENT_STEPS = 8;
const MAX_ACTIVITY_DETAIL_CHARS = 96;
const MAX_CHANGED_FILE_PREVIEW = 5;
const MAX_ACTIVITY_ARTIFACTS = 5;
const MAX_ACTIVITY_MCP_SERVERS = 6;

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
    normalized === "ran a tool" ||
    normalized === "running a tool" ||
    normalized === "ran a command" ||
    normalized === "running a command" ||
    normalized === "step" ||
    normalized === "terminal" ||
    normalized === "working" ||
    normalized === "thinking"
  );
}

function stepLabel(entry: WorkLogEntry, tense?: ToolActivityTense): string {
  if (!workLogEntryIsToolLike(entry)) {
    return (entry.toolTitle ?? entry.label).trim() || "Step";
  }
  return tense ? formatWorkLogToolLabel(entry, tense) : formatWorkLogToolLabel(entry);
}

/**
 * Recent rows: label + optional short real context (path/command/query).
 * Failures keep a one-line reason. No JSON dumps.
 */
function recentStepDetail(
  entry: WorkLogEntry,
  status: ThreadActivityStepStatus,
  workspaceRoot?: string | null,
): string | undefined {
  if (status === "failed" || status === "interrupted") {
    return formatActivityDetail(entry.detail ?? entry.command, workspaceRoot);
  }
  return formatActivityDetail(formatWorkLogToolContext(entry), workspaceRoot);
}

function toActivityStep(
  entry: WorkLogEntry,
  options: { turnActive: boolean; workspaceRoot?: string | null },
): ThreadActivityStep {
  const status = stepStatusFromWorkEntry(entry, options);
  const detail = recentStepDetail(entry, status, options.workspaceRoot);
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

/** Strip a trailing " × N" so consecutive collapse can re-count cleanly. */
function activityStepBaseLabel(label: string): string {
  return label.replace(/\s+×\s+\d+\s*$/u, "").trim();
}

function mergeActivityStepStatus(
  left: ThreadActivityStepStatus,
  right: ThreadActivityStepStatus,
): ThreadActivityStepStatus {
  const rank: Record<ThreadActivityStepStatus, number> = {
    failed: 5,
    interrupted: 4,
    running: 3,
    pending: 2,
    completed: 1,
    info: 0,
  };
  return rank[left] >= rank[right] ? left : right;
}

/**
 * Collapse consecutive same-label completed tools into one denser row
 * (`Read file × 8`). Running tools stay individual so live work stays visible.
 * Collapse runs before the mockup cap so 20 reads leave room for other steps.
 */
export function collapseConsecutiveActivitySteps(
  steps: ReadonlyArray<ThreadActivityStep>,
): ThreadActivityStep[] {
  const collapsed: ThreadActivityStep[] = [];
  for (const step of steps) {
    const prev = collapsed[collapsed.length - 1];
    const prevBase = prev ? activityStepBaseLabel(prev.label) : "";
    const stepBase = activityStepBaseLabel(step.label);
    const canMerge =
      prev != null &&
      prev.isToolLike &&
      step.isToolLike &&
      prev.status !== "running" &&
      step.status !== "running" &&
      prevBase.length > 0 &&
      prevBase === stepBase;

    if (!canMerge || !prev) {
      collapsed.push(step);
      continue;
    }

    const prevCount = Number(/×\s+(\d+)\s*$/u.exec(prev.label)?.[1] ?? 1);
    const nextCount = prevCount + 1;
    collapsed[collapsed.length - 1] = {
      ...step,
      label: `${stepBase} × ${nextCount}`,
      status: mergeActivityStepStatus(prev.status, step.status),
      // Keep the latest real context (path/command); drop empty.
      detail: step.detail ?? prev.detail,
    };
  }
  return collapsed;
}

function selectRecentActivitySteps(
  workEntries: ReadonlyArray<WorkLogEntry>,
  turnActive: boolean,
  workspaceRoot?: string | null,
): ThreadActivityStep[] {
  const milestones = workEntries.filter(isActivityRecentMilestone);
  const steps = milestones.map((entry) =>
    toActivityStep(entry, { turnActive, workspaceRoot: workspaceRoot ?? null }),
  );
  const collapsed = collapseConsecutiveActivitySteps(steps);
  if (collapsed.length <= MAX_RECENT_STEPS) {
    return collapsed;
  }
  return collapsed.slice(-MAX_RECENT_STEPS);
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .trim();
}

function toChangedFileRow(
  file: TurnDiffFileChange,
  workspaceRoot?: string | null,
): ThreadActivityChangedFile {
  return {
    path: displayPathForActivity(file.path, workspaceRoot) || file.path,
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
  // When a specific turn is active (or settled latest is known), only use that
  // turn's checkpoint. Falling back to an older turn's files made mid-flight
  // Activity show a previous turn's +/− table while the current turn only had
  // work-log paths (or none) — sessions looked inconsistent for no good reason.
  if (preferredTurnId != null) {
    return withFiles.find((summary) => summary.turnId === preferredTurnId) ?? null;
  }
  // Idle / no preferred turn: show the most recent checkpoint that has files.
  return [...withFiles].toSorted((left, right) => {
    if (left.checkpointTurnCount !== right.checkpointTurnCount) {
      return right.checkpointTurnCount - left.checkpointTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  })[0]!;
}

/**
 * Prefer paths under the active workspace root (no drive letter dumps).
 * Falls back to stripping a known repo leaf, then last path segments.
 */
export function displayPathForActivity(pathValue: string, workspaceRoot?: string | null): string {
  const normalized = normalizeRelativePath(pathValue);
  if (normalized.length === 0) {
    return normalized;
  }

  if (workspaceRoot) {
    const root = normalizeRelativePath(workspaceRoot).replace(/\/+$/u, "");
    if (root.length > 0) {
      const pathLower = normalized.toLowerCase();
      const rootLower = root.toLowerCase();
      if (pathLower === rootLower) {
        return ".";
      }
      if (pathLower.startsWith(`${rootLower}/`)) {
        return normalized.slice(root.length + 1);
      }
    }
  }

  // .../toolport/... or .../toolport-studio/... → path under that repo root.
  const repoMatch = /\/(?:toolport(?:-studio)?|t3-code)\/(.+)$/i.exec(`/${normalized}`);
  if (repoMatch?.[1]) {
    return repoMatch[1];
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    const parts = normalized
      .replace(/^[A-Za-z]:\//, "")
      .split("/")
      .filter(Boolean);
    if (parts.length > 3) {
      return parts.slice(-3).join("/");
    }
    return parts.join("/");
  }
  return normalized;
}

/** Compact detail; relativize path-like strings when a workspace root is known. */
export function formatActivityDetail(
  detail: string | undefined,
  workspaceRoot?: string | null,
): string | undefined {
  if (!detail) {
    return undefined;
  }
  let normalized = detail.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  // Absolute Windows/Unix paths (or paths with backslashes) become workspace-relative.
  if (
    looksLikeFilePath(normalized) ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.includes("\\")
  ) {
    normalized = displayPathForActivity(normalized, workspaceRoot);
  }
  if (normalized.length <= MAX_ACTIVITY_DETAIL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ACTIVITY_DETAIL_CHARS - 1).trimEnd()}…`;
}

function collectWorkLogChangedPaths(
  workEntries: ReadonlyArray<WorkLogEntry>,
  preferredTurnId: TurnId | null,
  workspaceRoot?: string | null,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) {
      return;
    }
    if (!looksLikeFilePath(raw)) {
      return;
    }
    const path = displayPathForActivity(raw, workspaceRoot);
    if (path.length === 0 || seen.has(path) || !looksLikeFilePath(path)) {
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
  readonly workspaceRoot?: string | null;
}): ThreadActivityChangedFiles | null {
  const workspaceRoot = input.workspaceRoot ?? null;
  const summary = pickCheckpointSummary(input.turnDiffSummaries, input.preferredTurnId);
  if (summary) {
    const stats = summarizeTurnDiffStats(summary.files);
    const files = summary.files
      .slice(0, MAX_CHANGED_FILE_PREVIEW)
      .map((file) => toChangedFileRow(file, workspaceRoot));
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

  const paths = collectWorkLogChangedPaths(input.workEntries, input.preferredTurnId, workspaceRoot);
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

/**
 * Proposed plans are the first real Activity artifact type. Prefer plans for
 * the active/preferred turn; otherwise surface recent unimplemented plans.
 */
/** Collapse id/name variants: `linear-2`, `linear_2`, `Linear` → comparable keys. */
function normalizeMcpMatchKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

/** Drop trailing instance suffixes: linear2 / linear-2 → linear. */
function baseMcpMatchKey(value: string): string {
  return normalizeMcpMatchKey(value).replace(/\d+$/u, "");
}

function isNoiseMcpServerKey(value: string): boolean {
  const key = value.trim().toLowerCase();
  return (
    key.length === 0 ||
    key === "tool" ||
    key === "tool call" ||
    key === "a tool" ||
    key === "mcp" ||
    key === "unknown"
  );
}

/** Gateway meta tools (`toolport_call_tool`, `toolport__toolport_status`, …). */
function isToolportGatewayMetaWireName(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^(?:mcp__|toolport__)+/gu, "")
    .replace(/__/gu, "_")
    .replace(/^toolport_/u, "");
  return (
    normalized === "call_tool" ||
    normalized === "toolport_call_tool" ||
    normalized === "search_tools" ||
    normalized === "toolport_search_tools" ||
    normalized === "status" ||
    normalized === "toolport_status" ||
    normalized === "run_script" ||
    normalized === "toolport_run_script" ||
    normalized === "fetch_result" ||
    normalized === "toolport_fetch_result" ||
    normalized === "enable_server" ||
    normalized === "toolport_enable_server" ||
    normalized === "disable_server" ||
    normalized === "toolport_disable_server"
  );
}

/**
 * Wire ids often look like `linear_2__list_projects` or
 * `toolport__toolport_call_tool`. Return server-side attribution keys.
 */
function serverKeysFromWireName(wire: string): string[] {
  const trimmed = wire.trim();
  if (!trimmed) return [];
  if (isToolportGatewayMetaWireName(trimmed)) {
    return ["toolport"];
  }
  let name = trimmed.replace(/^(?:mcp__)+/iu, "");
  // `toolport__linear__…` style (rare) vs `toolport__toolport_call_tool`
  if (/^toolport__/iu.test(name) && isToolportGatewayMetaWireName(name)) {
    return ["toolport"];
  }
  name = name.replace(/^toolport__/iu, "");
  if (isToolportGatewayMetaWireName(name)) {
    return ["toolport"];
  }
  if (name.includes("__")) {
    const serverPart = name.split("__")[0]?.trim() ?? "";
    if (serverPart && !isNoiseMcpServerKey(serverPart)) {
      return [serverPart.toLowerCase()];
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // ignore non-JSON strings
      }
    }
  }
  return null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addServerAttributionKeys(keys: Set<string>, raw: string | undefined): void {
  if (!raw || isNoiseMcpServerKey(raw)) return;
  const lower = raw.trim().toLowerCase();
  keys.add(lower);
  const normalized = normalizeMcpMatchKey(lower);
  if (normalized.length > 0) keys.add(normalized);
  const base = baseMcpMatchKey(lower);
  if (base.length > 0) keys.add(base);
}

function harvestWireFields(bag: Record<string, unknown>, keys: Set<string>): void {
  for (const field of ["server", "serverName", "server_name", "serverId", "server_id"] as const) {
    addServerAttributionKeys(keys, asTrimmedString(bag[field]));
  }
  for (const field of ["name", "tool", "tool_name", "toolName"] as const) {
    const wire = asTrimmedString(bag[field]);
    if (!wire) continue;
    for (const key of serverKeysFromWireName(wire)) {
      addServerAttributionKeys(keys, key);
    }
  }
  const argBag = asRecord(bag.arguments) ?? asRecord(bag.input) ?? asRecord(bag.params);
  if (argBag) {
    harvestWireFields(argBag, keys);
  }
}

/**
 * Keys that may match a registry server id/name (or the synthetic Toolport
 * gateway). Grok/ACP rarely sets `toolData.server`; wire names live in
 * rawInput / humanized titles instead.
 *
 * Prefer downstream MCP (Linear, GitHub, …). Gateway meta alone yields
 * `toolport` so pure status/search still surfaces.
 */
function collectActivityMcpUseKeys(entry: WorkLogEntry): Set<string> {
  const keys = new Set<string>();

  const toolData = asRecord(entry.toolData);
  if (toolData) {
    addServerAttributionKeys(keys, asTrimmedString(toolData.server));
    const bags: Array<Record<string, unknown> | null> = [
      toolData,
      asRecord(toolData.rawInput),
      asRecord(toolData.item),
      asRecord(toolData.arguments),
      asRecord(toolData.input),
    ];
    for (const bag of bags) {
      if (bag) harvestWireFields(bag, keys);
    }
  }

  const title = (entry.toolTitle ?? entry.label).trim();
  if (title) {
    // Humanized pure-gateway lines (no nested target in the title).
    if (
      /\btoolport\b/iu.test(title) &&
      /via\s+toolport|toolport\s+tools|toolport\s+status|toolport\s+script|toolport\s+result|searching\s+toolport|checked\s+toolport|calling\s+a\s+tool\s+via|called\s+a\s+tool\s+via/iu.test(
        title,
      )
    ) {
      addServerAttributionKeys(keys, "toolport");
    }
    for (const key of serverKeysFromWireName(title)) {
      addServerAttributionKeys(keys, key);
    }

    const withoutVerb = title
      .replace(
        /^(?:called|calling|searched|searching|checked|checking|ran|running|fetched|fetching|used)\s+/iu,
        "",
      )
      .replace(/\s+via\s+toolport\b/iu, "")
      .trim();
    // "Linear · list projects" / "Linear - list projects"
    const serverFromTitle = withoutVerb.split(/\s*[·•|–—-]\s+/u)[0]?.trim();
    if (
      serverFromTitle &&
      serverFromTitle.length > 0 &&
      serverFromTitle.length < 48 &&
      !/^a\s+tool$/iu.test(serverFromTitle) &&
      !isToolportGatewayMetaWireName(serverFromTitle)
    ) {
      addServerAttributionKeys(keys, serverFromTitle);
    }
    if (withoutVerb.includes("__")) {
      for (const key of serverKeysFromWireName(withoutVerb)) {
        addServerAttributionKeys(keys, key);
      }
    }
  }

  const detail = entry.detail?.trim();
  if (detail && detail.length < 200) {
    for (const key of serverKeysFromWireName(detail)) {
      addServerAttributionKeys(keys, key);
    }
  }

  return keys;
}

function useCountForRegistryServer(
  server: { readonly id: string; readonly name: string },
  useCounts: ReadonlyMap<string, number>,
): number {
  const idNorm = normalizeMcpMatchKey(server.id);
  const nameNorm = normalizeMcpMatchKey(server.name);
  const idBase = baseMcpMatchKey(server.id);
  const nameBase = baseMcpMatchKey(server.name);
  const candidates = new Set(
    [
      server.id.trim().toLowerCase(),
      server.name.trim().toLowerCase(),
      idNorm,
      nameNorm,
      idBase,
      nameBase,
    ].filter((value) => value.length > 0),
  );
  let max = 0;
  for (const candidate of candidates) {
    max = Math.max(max, useCounts.get(candidate) ?? 0);
  }
  for (const [key, count] of useCounts) {
    if (key === "toolport" || normalizeMcpMatchKey(key) === "toolport") continue;
    const keyNorm = normalizeMcpMatchKey(key);
    const keyBase = baseMcpMatchKey(key);
    if (
      candidates.has(key) ||
      candidates.has(keyNorm) ||
      (keyBase.length >= 3 && (keyBase === idBase || keyBase === nameBase))
    ) {
      max = Math.max(max, count);
    }
  }
  return max;
}

/**
 * Rank Toolport servers for Activity: enabled + gateway first, then session
 * usage, then name. Preview caps at MAX_ACTIVITY_MCP_SERVERS.
 */
export function deriveActivityMcpStatus(input: {
  readonly mcpStatus: ToolportMcpStatus | null | undefined;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly preferredTurnId?: TurnId | null;
}): ThreadActivityMcpStatus | null {
  const status = input.mcpStatus;
  // Show when registry has servers and/or Studio inject is configured to run.
  if (!status) {
    return null;
  }
  if (status.servers.length === 0 && !status.injectionEnabled) {
    return null;
  }

  const injectionEnabled = status.injectionEnabled;
  const injectionReady = status.injectionReady;
  const injectionReason = status.injectionReason;

  const useCounts = new Map<string, number>();
  const preferredTurnId = input.preferredTurnId ?? null;
  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry.kind !== "work") continue;
    const entry = timelineEntry.entry;
    if (preferredTurnId != null && entry.turnId != null && entry.turnId !== preferredTurnId) {
      continue;
    }
    // Codex: mcp_tool_call. Grok/ACP: dynamic_tool_call with tone tool.
    if (
      entry.itemType !== "mcp_tool_call" &&
      entry.itemType !== "dynamic_tool_call" &&
      entry.tone !== "tool"
    ) {
      continue;
    }
    const keys = collectActivityMcpUseKeys(entry);
    if (keys.size === 0) continue;
    // One hit per tool call, attributed to every matching key (id and display name).
    for (const key of keys) {
      useCounts.set(key, (useCounts.get(key) ?? 0) + 1);
    }
  }

  const scored = status.servers.map((server) => {
    const useCount = useCountForRegistryServer(server, useCounts);
    let health: ThreadActivityMcpHealth = "disabled";
    if (!server.enabled) {
      health = "disabled";
    } else if (!status.gatewayAvailable) {
      health = "offline";
    } else {
      health = "ready";
    }
    return {
      id: server.id,
      name: server.name,
      health,
      transport: server.transport,
      ...(server.source ? { source: server.source } : {}),
      useCount,
    } satisfies ThreadActivityMcpServer;
  });

  scored.sort((left, right) => {
    const healthRank = (h: ThreadActivityMcpHealth) =>
      h === "ready" ? 0 : h === "offline" ? 1 : 2;
    const byHealth = healthRank(left.health) - healthRank(right.health);
    if (byHealth !== 0) return byHealth;
    if (right.useCount !== left.useCount) return right.useCount - left.useCount;
    return left.name.localeCompare(right.name);
  });

  const usedFromRegistry = scored.filter((server) => server.useCount > 0);
  const toolportUses = Math.max(
    useCounts.get("toolport") ?? 0,
    useCounts.get(normalizeMcpMatchKey("toolport")) ?? 0,
  );
  // Prefer real MCP servers (Linear, GitHub, …). The gateway chip is a fallback
  // for pure meta tools (status / bare search) — not a substitute for Linear.
  const usedThisTurn: ThreadActivityMcpServer[] = usedFromRegistry.slice(0, MAX_MCP_USED_THIS_TURN);
  if (usedThisTurn.length === 0 && toolportUses > 0) {
    usedThisTurn.push({
      id: "toolport",
      name: "Toolport",
      health: status.gatewayAvailable ? "ready" : "offline",
      transport: "stdio",
      useCount: toolportUses,
    });
  }

  return {
    gatewayAvailable: status.gatewayAvailable,
    activeProfileName: status.activeProfileName,
    usedThisTurn: usedThisTurn.slice(0, MAX_MCP_USED_THIS_TURN),
    servers: scored.slice(0, MAX_ACTIVITY_MCP_SERVERS),
    totalServerCount: status.servers.length,
    injectionEnabled,
    injectionReady,
    injectionReason,
  };
}

/** One-line inject state for Activity (gateway spawn into providers). */
export function formatActivityMcpInjectionLabel(model: ThreadActivityMcpStatus): string {
  if (!model.injectionEnabled) {
    return "Studio inject off";
  }
  if (model.injectionReady) {
    return "Studio inject ready";
  }
  if (model.injectionReason === "configured_path_missing") {
    return "Gateway path missing";
  }
  return "Gateway not found";
}

export function deriveActivityArtifacts(input: {
  readonly proposedPlans: ReadonlyArray<ProposedPlan>;
  readonly preferredTurnId: TurnId | null;
}): ThreadActivityArtifact[] {
  const plans = input.proposedPlans;
  if (plans.length === 0) {
    return [];
  }

  const preferred =
    input.preferredTurnId != null
      ? plans.filter((plan) => plan.turnId === input.preferredTurnId)
      : [];
  const source =
    preferred.length > 0
      ? preferred
      : [...plans]
          .filter((plan) => plan.implementedAt === null)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return source.slice(0, MAX_ACTIVITY_ARTIFACTS).map((plan) => {
    const title = proposedPlanTitle(plan.planMarkdown)?.trim();
    return {
      id: plan.id,
      label: title && title.length > 0 ? title : "Proposed plan",
      kind: "proposed-plan" as const,
      turnId: plan.turnId,
      updatedAt: plan.updatedAt,
      implemented: plan.implementedAt !== null,
    };
  });
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
  /** Turn wall-clock anchors for the settled "Done · 3m 10s" badge. */
  readonly latestTurnStartedAt?: string | null;
  readonly latestTurnCompletedAt?: string | null;
  readonly proposedPlans?: ReadonlyArray<ProposedPlan>;
  readonly mcpStatus?: ToolportMcpStatus | null;
  /** Active project / worktree root — shortens absolute paths in the panel. */
  readonly workspaceRoot?: string | null;
}): ThreadActivityViewModel {
  const unsettledTurnId = input.unsettledTurnId ?? null;
  const turnActive = input.isWorking;
  const workspaceRoot = input.workspaceRoot ?? null;
  const workEntries = collectWorkEntries(input.timelineEntries, unsettledTurnId);
  const recentSteps = selectRecentActivitySteps(workEntries, turnActive, workspaceRoot);
  const preferredTurnId = unsettledTurnId ?? input.latestTurnId ?? null;
  const changedFiles = deriveActivityChangedFiles({
    turnDiffSummaries: input.turnDiffSummaries ?? [],
    preferredTurnId,
    workEntries,
    workspaceRoot,
  });
  const artifacts = deriveActivityArtifacts({
    proposedPlans: input.proposedPlans ?? [],
    preferredTurnId,
  });
  const mcp = deriveActivityMcpStatus({
    mcpStatus: input.mcpStatus,
    timelineEntries: input.timelineEntries,
    preferredTurnId,
  });

  let current: ThreadActivityCurrentStep | null = null;
  if (input.isWorking) {
    const runningTool = workEntries
      .toReversed()
      .find((entry) => workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "inProgress");
    const thinking = workEntries
      .toReversed()
      .find((entry) => entry.tone === "thinking" || entry.sourceActivityKind === "task.progress");
    const lastFinishedTool = workEntries
      .toReversed()
      .find(
        (entry) =>
          workLogEntryIsToolLike(entry) &&
          entry.toolLifecycleStatus !== "inProgress" &&
          !isGenericActivityLabel(stepLabel(entry)),
      );

    // Only an explicit in-progress tool is Current as a tool. Thinking may
    // label Current while tools are quiet; it is not a Recent milestone.
    if (runningTool) {
      const label = stepLabel(runningTool, "present");
      const detail = formatActivityDetail(formatWorkLogToolContext(runningTool), workspaceRoot);
      current = {
        // Prefer the real tool name as the hero (Grok-terminal style), not
        // "Waiting on …" — elapsed already communicates that work is open.
        label,
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
  } else if (recentSteps.length > 0) {
    // Settled turn with history: show the last milestone instead of an empty
    // "Start a turn" shell while Recent steps still list the work.
    const last = recentSteps[recentSteps.length - 1]!;
    current = {
      label: last.label,
      ...(last.detail ? { detail: last.detail } : {}),
      startedAt: last.createdAt,
      source: "settled",
    };
  }

  let attention: ThreadActivityViewModel["attention"] = null;
  if (input.hasPendingApproval) {
    attention = { kind: "approval", label: "Approval required" };
  } else if (input.hasPendingUserInput) {
    attention = { kind: "user-input", label: "Input required" };
  } else if (input.threadError?.trim()) {
    attention = { kind: "error", label: input.threadError.trim() };
  }

  const hasSettledContext =
    recentSteps.length > 0 || changedFiles !== null || artifacts.length > 0 || current !== null;
  const settledStart =
    input.latestTurnStartedAt ??
    input.activeTurnStartedAt ??
    workEntries[0]?.createdAt ??
    recentSteps[0]?.createdAt ??
    null;
  const settledEnd =
    input.latestTurnCompletedAt ??
    (workEntries.length > 0 ? workEntries[workEntries.length - 1]?.createdAt : null) ??
    recentSteps[recentSteps.length - 1]?.createdAt ??
    null;
  const settledDurationLabel =
    !input.isWorking && settledStart && settledEnd ? formatElapsed(settledStart, settledEnd) : null;
  // When the turn projection lacks timestamps, still show Done if we have work history.
  const statusBadge: ThreadActivityStatusBadge = input.isWorking
    ? input.activeTurnStartedAt
      ? { kind: "elapsed", startedAt: input.activeTurnStartedAt }
      : { kind: "idle" }
    : hasSettledContext
      ? { kind: "done", durationLabel: settledDurationLabel }
      : { kind: "idle" };

  return {
    isWorking: input.isWorking,
    elapsedStartedAt: input.isWorking ? input.activeTurnStartedAt : null,
    statusBadge,
    current,
    recentSteps,
    changedFiles,
    artifacts,
    attention,
    mcp,
    hasAuthoritativeMcpStatus: mcp !== null,
  };
}
