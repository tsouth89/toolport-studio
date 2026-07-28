/**
 * Codex-style floating "this turn" card. Chat stays primary; this is optional
 * inspect chrome for live work, files, and Toolport — not a docked instrument column.
 */
import type { TurnId } from "@t3tools/contracts";
import { CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { formatMcpServerDisplayName } from "@t3tools/shared/toolActivity";
import { formatDuration } from "../session-logic";
import type { ThreadActivityViewModel } from "../threadActivityViewModel";
import { cn } from "../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";

/** After this long while working, collapse to a pill so chat stays primary. */
const THIS_TURN_AUTO_COLLAPSE_MS = 12_000;

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

function statusTitle(model: ThreadActivityViewModel, liveElapsed: string | null): string {
  if (model.isWorking) {
    return liveElapsed ? `This turn · ${liveElapsed}` : "This turn";
  }
  if (model.statusBadge.kind === "done") {
    return model.statusBadge.durationLabel ? `Done · ${model.statusBadge.durationLabel}` : "Done";
  }
  return "This turn";
}

export function ThisTurnCard({
  model,
  onDismiss,
  onOpenTurnDiff,
  onOpenToolport,
  onOpenDockedActivity,
  className,
}: {
  model: ThreadActivityViewModel;
  onDismiss: () => void;
  onOpenTurnDiff?: ((turnId: TurnId, filePath?: string) => void) | undefined;
  onOpenToolport?: (() => void) | undefined;
  /** Optional: expand into full docked Activity surface. */
  onOpenDockedActivity?: (() => void) | undefined;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [userPinnedExpanded, setUserPinnedExpanded] = useState(false);
  const liveElapsed = useElapsedLabel(model.elapsedStartedAt, model.isWorking);
  const title = statusTitle(model, liveElapsed);
  const current = model.current;
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
    model.attention !== null;

  // Long healthy turns: collapse to a pill so the chat stays Claude-clean.
  // Attention keeps the card open; user expand pins it.
  useEffect(() => {
    if (!model.isWorking || userPinnedExpanded || model.attention !== null) {
      return;
    }
    const id = window.setTimeout(() => {
      setExpanded(false);
    }, THIS_TURN_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(id);
  }, [model.attention, model.isWorking, model.elapsedStartedAt, userPinnedExpanded]);

  useEffect(() => {
    // Fresh turn re-opens expanded once.
    setExpanded(true);
    setUserPinnedExpanded(false);
  }, [model.elapsedStartedAt]);

  if (!expanded) {
    return (
      <div
        className={cn(
          "pointer-events-auto w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/60 bg-[color-mix(in_srgb,var(--shell-surface,var(--background))_94%,transparent)] shadow-lg backdrop-blur-md",
          className,
        )}
      >
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12px] font-medium text-foreground/90 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setExpanded(true);
            setUserPinnedExpanded(true);
          }}
          aria-expanded={false}
        >
          {model.isWorking ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate tabular-nums">{title}</span>
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-auto w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border/60 bg-[color-mix(in_srgb,var(--shell-surface,var(--background))_94%,transparent)] shadow-lg backdrop-blur-md",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setExpanded(false);
            setUserPinnedExpanded(false);
          }}
          aria-expanded
          aria-label="Collapse this turn card"
        >
          {model.isWorking ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tabular-nums tracking-tight">
            {title}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
export function shouldShowThisTurnCard(model: ThreadActivityViewModel): boolean {
  if (model.isWorking) return true;
  if (model.attention !== null) return true;
  return false;
}
