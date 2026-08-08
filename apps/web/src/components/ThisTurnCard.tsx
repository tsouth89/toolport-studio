/**
 * Codex-style floating "this turn" card. Chat stays primary; this is optional
 * inspect chrome for live work, files, and Toolport — not a docked instrument column.
 */
import type { TurnId } from "@toolport-studio/contracts";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  ExternalLink,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatMcpServerDisplayName } from "@toolport-studio/shared/toolActivity";
import {
  preferredAgentRun,
  summarizeAgentRuns,
  type AgentRun,
  type AgentRunStatus,
} from "../agentRuns";
import {
  isBackgroundTaskInFlight,
  summarizeBackgroundTasks,
  type BackgroundTask,
} from "../backgroundTasks";
import { formatDuration } from "../session-logic";
import type { ThreadActivityViewModel } from "../threadActivityViewModel";
import { cn } from "../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";

/**
 * Brief expanded glance at turn start, then collapse to a pill so chat stays
 * primary. Attention re-expands and holds the card open.
 */
export const THIS_TURN_AUTO_COLLAPSE_MS = 4_000;
const EMPTY_AGENT_RUNS: ReadonlyArray<AgentRun> = [];
const EMPTY_BACKGROUND_TASKS: ReadonlyArray<BackgroundTask> = [];

function useElapsedLabel(startedAt: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt || !active) return null;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  return formatDuration(Math.max(0, now - startedMs));
}

function compactToolLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 27).trimEnd()}…`;
}

/**
 * The oldest in-flight background task's start time, or null when nothing is
 * running. Anchoring the elapsed clock to the oldest task means the header
 * answers "how long has this been watching", not "how long since the most
 * recent status patch".
 */
export function liveBackgroundWorkStartedAt(tasks: ReadonlyArray<BackgroundTask>): string | null {
  let oldest: string | null = null;
  for (const task of tasks) {
    if (!isBackgroundTaskInFlight(task)) continue;
    if (oldest === null || task.startedAt.localeCompare(oldest) < 0) {
      oldest = task.startedAt;
    }
  }
  return oldest;
}

function statusTitle(
  model: ThreadActivityViewModel,
  liveElapsed: string | null,
  backgroundWork: { readonly count: number; readonly elapsed: string | null } | null,
): string {
  // A settled turn that left something running must not say "Done". The turn is
  // done; the work is not, and reading "Done" next to a live watcher is exactly
  // what makes people think nothing is watching.
  if (!model.isWorking && backgroundWork !== null) {
    const suffix = backgroundWork.elapsed ? ` · ${backgroundWork.elapsed}` : "";
    return backgroundWork.count === 1
      ? `Watching${suffix}`
      : `Watching ${backgroundWork.count} tasks${suffix}`;
  }
  if (model.isWorking) {
    const current = model.current?.label?.trim();
    const toolBit =
      current &&
      current.length > 0 &&
      !/^waiting for/i.test(current) &&
      current.toLowerCase() !== "thinking"
        ? compactToolLabel(current)
        : null;
    if (liveElapsed && toolBit) {
      return `${toolBit} · ${liveElapsed}`;
    }
    if (liveElapsed) return `This turn · ${liveElapsed}`;
    return toolBit ?? "This turn";
  }
  if (model.statusBadge.kind === "done") {
    return model.statusBadge.durationLabel ? `Done · ${model.statusBadge.durationLabel}` : "Done";
  }
  return "This turn";
}

function agentStatusLabel(status: AgentRunStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "stopped":
      return "Stopped";
    case "unknown":
      return "Unknown";
  }
}

function AgentStatusIcon({ status }: { status: AgentRunStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3 animate-spin text-primary" aria-hidden />;
    case "completed":
      return <CheckCircle2 className="size-3 text-success" aria-hidden />;
    case "failed":
      return <XCircle className="size-3 text-destructive" aria-hidden />;
    case "interrupted":
    case "stopped":
      return <XCircle className="size-3 text-muted-foreground" aria-hidden />;
    case "pending":
    case "unknown":
      return <Circle className="size-3 text-muted-foreground" aria-hidden />;
  }
}

export function ThisTurnCard({
  model,
  agentRuns = EMPTY_AGENT_RUNS,
  backgroundTasks = EMPTY_BACKGROUND_TASKS,
  onDismiss,
  onOpenTurnDiff,
  onOpenToolport,
  onOpenDockedActivity,
  onOpenAgents,
  /** Bump when the user explicitly opens the card (Working row) so it expands. */
  expandRequestId = 0,
  className,
}: {
  model: ThreadActivityViewModel;
  agentRuns?: ReadonlyArray<AgentRun>;
  /** Backgrounded work for this thread; surfaced as its own chip. */
  backgroundTasks?: ReadonlyArray<BackgroundTask>;
  onDismiss: () => void;
  onOpenTurnDiff?: ((turnId: TurnId, filePath?: string) => void) | undefined;
  onOpenToolport?: (() => void) | undefined;
  /** Optional: expand into full docked Activity surface. */
  onOpenDockedActivity?: (() => void) | undefined;
  /** Open the Agents surface, optionally focused on one run. */
  onOpenAgents?: ((agentRunId?: string) => void) | undefined;
  expandRequestId?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [userPinnedExpanded, setUserPinnedExpanded] = useState(false);
  const liveElapsed = useElapsedLabel(model.elapsedStartedAt, model.isWorking);
  const backgroundWorkStartedAt = liveBackgroundWorkStartedAt(backgroundTasks);
  const backgroundElapsed = useElapsedLabel(
    backgroundWorkStartedAt,
    backgroundWorkStartedAt !== null,
  );
  const liveBackgroundCount = backgroundTasks.filter(isBackgroundTaskInFlight).length;
  // A green check beside "Watching" reads as finished. The spinner is what makes
  // the card legible at a glance as "still going".
  const showsLiveSpinner = model.isWorking || liveBackgroundCount > 0;
  const title = statusTitle(
    model,
    liveElapsed,
    liveBackgroundCount > 0 ? { count: liveBackgroundCount, elapsed: backgroundElapsed } : null,
  );
  const current = model.current;
  const agentSummary = summarizeAgentRuns(agentRuns);
  const preferredRun = preferredAgentRun(agentRuns);
  const compactAgentLabel =
    agentSummary.failedCount > 0
      ? `${agentSummary.failedCount} failed`
      : agentSummary.activeCount > 0
        ? `${agentSummary.activeCount} running`
        : agentSummary.completedCount === agentSummary.totalCount
          ? `${agentSummary.totalCount} done`
          : `${agentSummary.totalCount} agent${agentSummary.totalCount === 1 ? "" : "s"}`;
  const taskSummary = summarizeBackgroundTasks(backgroundTasks);
  const agentStatusKey = agentRuns.map((run) => `${run.id}:${run.status}`).join("|");
  const previousAgentStatusKey = useRef(agentStatusKey);
  const files = model.changedFiles;
  const usedMcp = model.mcp?.usedThisTurn ?? [];
  const usedLabel =
    usedMcp.length > 0
      ? usedMcp.map((server) => formatMcpServerDisplayName(server.name)).join(" · ")
      : null;
  const hasBody =
    current !== null ||
    (files !== null && files.fileCount > 0) ||
    usedLabel !== null ||
    model.attention !== null ||
    agentRuns.length > 0 ||
    backgroundTasks.length > 0;

  // Fresh turn: brief expanded glance, then pill (unless attention / user pin).
  useEffect(() => {
    setExpanded(true);
    setUserPinnedExpanded(false);
  }, [model.elapsedStartedAt]);

  // Approvals / errors deserve the full card, not a quiet pill.
  useEffect(() => {
    if (model.attention !== null) {
      setExpanded(true);
    }
  }, [model.attention]);

  // A newly launched or newly failed subagent deserves a brief glance even if
  // the card already collapsed. Successful agents remain quiet and clickable.
  useEffect(() => {
    if (previousAgentStatusKey.current !== agentStatusKey && agentRuns.length > 0) {
      setExpanded(true);
      setUserPinnedExpanded(false);
    }
    previousAgentStatusKey.current = agentStatusKey;
  }, [agentRuns.length, agentStatusKey]);

  // Once the parent settles, preserve discoverability as a compact pill. A
  // failed child remains expanded so the failure is not easy to miss.
  useEffect(() => {
    if (
      !model.isWorking &&
      agentRuns.length > 0 &&
      agentSummary.failedCount === 0 &&
      !userPinnedExpanded
    ) {
      setExpanded(false);
    }
  }, [agentRuns.length, agentSummary.failedCount, model.isWorking, userPinnedExpanded]);

  // Explicit open from Working "This turn" — expand and pin so it doesn't
  // immediately re-collapse under the auto-pill timer.
  useEffect(() => {
    if (expandRequestId <= 0) return;
    setExpanded(true);
    setUserPinnedExpanded(true);
  }, [expandRequestId]);

  useEffect(() => {
    if (
      !model.isWorking ||
      userPinnedExpanded ||
      model.attention !== null ||
      agentSummary.failedCount > 0
    ) {
      return;
    }
    const id = window.setTimeout(() => {
      setExpanded(false);
    }, THIS_TURN_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(id);
  }, [
    agentStatusKey,
    agentSummary.failedCount,
    model.attention,
    model.isWorking,
    model.elapsedStartedAt,
    userPinnedExpanded,
  ]);

  if (!expanded) {
    return (
      <div
        className={cn(
          "pointer-events-auto w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/60 bg-[color-mix(in_srgb,var(--shell-surface,var(--background))_94%,transparent)] shadow-lg backdrop-blur-md",
          className,
        )}
      >
        <div className="flex items-stretch">
          <button
            type="button"
            data-testid="this-turn-card-toggle"
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[12px] font-medium text-foreground/90 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setExpanded(true);
              setUserPinnedExpanded(true);
            }}
            aria-expanded={false}
          >
            {showsLiveSpinner ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
            ) : (
              <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate tabular-nums">{title}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {onOpenAgents && agentRuns.length > 0 ? (
            <button
              type="button"
              className={cn(
                "inline-flex shrink-0 items-center gap-1 border-l border-border/50 px-2 text-[10px] font-semibold text-muted-foreground hover:bg-accent/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                agentSummary.failedCount > 0 && "text-destructive",
              )}
              onClick={() => onOpenAgents(preferredRun?.id)}
              aria-label={`Open ${agentSummary.label} in Agents`}
            >
              {agentSummary.failedCount > 0 ? (
                <XCircle className="size-3" aria-hidden />
              ) : agentSummary.activeCount > 0 ? (
                <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
              ) : (
                <CheckCircle2 className="size-3 text-success" aria-hidden />
              )}
              {compactAgentLabel}
            </button>
          ) : null}
          {onOpenAgents && taskSummary.label ? (
            <button
              type="button"
              className={cn(
                "inline-flex shrink-0 items-center gap-1 border-l border-border/50 px-2 text-[10px] font-semibold text-muted-foreground hover:bg-accent/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                taskSummary.runningCount === 0 && taskSummary.failedCount > 0 && "text-destructive",
              )}
              onClick={() => onOpenAgents()}
              aria-label={`Open ${taskSummary.label} in Agents`}
            >
              {taskSummary.runningCount > 0 ? (
                <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
              ) : (
                <XCircle className="size-3" aria-hidden />
              )}
              {taskSummary.label}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-auto w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/60 bg-[color-mix(in_srgb,var(--shell-surface,var(--background))_94%,transparent)] shadow-lg backdrop-blur-md",
        className,
      )}
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <button
          type="button"
          data-testid="this-turn-card-toggle"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setExpanded(false);
            setUserPinnedExpanded(false);
          }}
          aria-expanded
          aria-label="Collapse this turn card"
        >
          {showsLiveSpinner ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tabular-nums tracking-tight">
            {title}
          </span>
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onDismiss}
          aria-label="Dismiss this turn card"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="space-y-2 px-2.5 py-2">
        {model.attention ? (
          <p
            className={cn(
              "rounded-lg border px-2 py-1.5 text-[11.5px] leading-snug",
              model.attention.kind === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {model.attention.label}
          </p>
        ) : null}

        {current ? (
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-foreground/90">{current.label}</p>
            {current.detail ? (
              <p className="mt-0.5 line-clamp-2 break-all text-[11px] text-muted-foreground">
                {current.detail}
              </p>
            ) : null}
          </div>
        ) : hasBody ? null : (
          <p className="text-[11.5px] text-muted-foreground">Waiting for the first step…</p>
        )}

        {agentRuns.length > 0 ? (
          <section
            aria-label="Subagents"
            className="overflow-hidden rounded-lg border border-border/50"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/20 px-2 py-1.5">
              <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Subagents
              </span>
              <span
                className={cn(
                  "text-[10px] font-medium text-muted-foreground",
                  agentSummary.failedCount > 0 && "text-destructive",
                )}
                role="status"
              >
                {agentSummary.label}
              </span>
            </div>
            <div className="divide-y divide-border/35">
              {agentRuns.slice(0, 3).map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  style={{ paddingInlineStart: `${8 + run.depth * 12}px` }}
                  onClick={() => onOpenAgents?.(run.id)}
                  disabled={!onOpenAgents}
                  aria-label={`Open ${run.label} in Agents`}
                >
                  <AgentStatusIcon status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground/90">
                    {run.label}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {agentStatusLabel(run.status)}
                  </span>
                </button>
              ))}
            </div>
            {agentRuns.length > 3 ? (
              <button
                type="button"
                className="w-full border-t border-border/35 px-2 py-1.5 text-left text-[10px] font-medium text-muted-foreground hover:bg-accent/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpenAgents?.(preferredRun?.id)}
                disabled={!onOpenAgents}
              >
                +{agentRuns.length - 3} more · Open Agents
              </button>
            ) : null}
          </section>
        ) : null}

        {files && files.fileCount > 0 ? (
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/25 px-2 py-1.5 text-left text-[11.5px]",
              onOpenTurnDiff
                ? "cursor-pointer hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : "cursor-default",
            )}
            disabled={!onOpenTurnDiff}
            onClick={() => onOpenTurnDiff?.(files.turnId)}
          >
            <span className="font-medium text-foreground/90">
              {files.fileCount} file{files.fileCount === 1 ? "" : "s"}
            </span>
            {hasNonZeroStat({ additions: files.additions, deletions: files.deletions }) ? (
              <DiffStatLabel
                additions={files.additions}
                deletions={files.deletions}
                className="text-[11px]"
                layout="inline"
              />
            ) : (
              <span className="text-muted-foreground">Open diff</span>
            )}
          </button>
        ) : null}

        {usedLabel ? (
          <p className="truncate text-[11px] text-muted-foreground" title={usedLabel}>
            Used · {usedLabel}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          {onOpenToolport && model.mcp ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenToolport}
            >
              Toolport
              <ExternalLink className="size-3" aria-hidden />
            </button>
          ) : null}
          {onOpenDockedActivity ? (
            <button
              type="button"
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenDockedActivity}
            >
              Full activity
            </button>
          ) : null}
          {onOpenAgents && agentRuns.length > 0 ? (
            <button
              type="button"
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpenAgents(preferredRun?.id)}
            >
              Open Agents
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Auto-show only while the turn is live or needs attention. After settle the
 * timeline already has Worked for / changed files — keep the chat Claude-clean
 * unless the user forced the card open (handled by the parent).
 */
export function shouldShowThisTurnCard(
  model: ThreadActivityViewModel,
  agentRuns: ReadonlyArray<AgentRun> = [],
  backgroundTasks: ReadonlyArray<BackgroundTask> = [],
): boolean {
  if (model.isWorking) return true;
  if (model.attention !== null) return true;
  if (agentRuns.length > 0) return true;
  // A settled turn that left something watching still has status worth showing.
  if (backgroundTasks.some(isBackgroundTaskInFlight)) return true;
  return false;
}

/**
 * Full visibility rule, including the user's dismiss.
 *
 * Dismissal is keyed to a turn, but background work outlives the turn that
 * started it. Dismissing during a turn therefore used to keep the card hidden
 * after that turn settled, so a live watcher had no in-session presence at all
 * while the sidebar chip went on counting it — you were left trusting a claim
 * the UI could not corroborate. Live background work overrides the dismiss: a
 * turn retrospective can be waved away, something still running cannot.
 */
export function isThisTurnCardVisible(input: {
  readonly model: ThreadActivityViewModel;
  readonly agentRuns?: ReadonlyArray<AgentRun>;
  readonly backgroundTasks?: ReadonlyArray<BackgroundTask>;
  /** The docked Activity surface already shows all of this. */
  readonly dockedActivityOpen: boolean;
  readonly dismissed: boolean;
  readonly forcedOpen: boolean;
}): boolean {
  if (input.dockedActivityOpen) return false;
  const backgroundTasks = input.backgroundTasks ?? [];
  if (input.dismissed && !backgroundTasks.some(isBackgroundTaskInFlight)) return false;
  if (input.forcedOpen) return true;
  return shouldShowThisTurnCard(input.model, input.agentRuns ?? [], backgroundTasks);
}
