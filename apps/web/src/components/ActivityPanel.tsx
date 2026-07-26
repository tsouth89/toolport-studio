import type { TurnId } from "@t3tools/contracts";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  Loader2,
  XCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { formatDuration } from "../session-logic";
import type {
  ThreadActivityArtifact,
  ThreadActivityChangedFiles,
  ThreadActivityStep,
  ThreadActivityStepStatus,
  ThreadActivityViewModel,
} from "../threadActivityViewModel";
import { cn } from "../lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import { ScrollArea } from "./ui/scroll-area";

function useElapsedLabel(startedAt: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt || !active) return null;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  return formatDuration(Math.max(0, now - startedMs));
}

/** Clock for recent-step rows (mockup: 10:21:02 AM). */
function formatStepClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-0.5 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/80 uppercase">
      {children}
    </h3>
  );
}

function StepStatusIcon({ status }: { status: ThreadActivityStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />;
    case "completed":
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />;
    case "info":
      return <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
    case "failed":
    case "interrupted":
      return <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />;
    case "pending":
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/45" aria-hidden />;
    default:
      return <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />;
  }
}

function RecentStepRow({ step }: { step: ThreadActivityStep }) {
  const clock = formatStepClock(step.createdAt);
  return (
    <li className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-[12px]">
      <span className="shrink-0">
        <StepStatusIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p
          className={cn(
            "truncate leading-snug",
            step.status === "running"
              ? "font-semibold text-foreground"
              : "font-medium text-foreground/88",
          )}
        >
          {step.label}
        </p>
        {step.detail ? (
          <p className="mt-0.5 line-clamp-1 break-all text-[11px] leading-snug text-muted-foreground/85">
            {step.detail}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/70">
        {clock || "—"}
      </span>
    </li>
  );
}

function ArtifactsSection({
  artifacts,
  onOpenPlan,
}: {
  artifacts: ReadonlyArray<ThreadActivityArtifact>;
  onOpenPlan?: () => void;
}) {
  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <SectionLabel>
          <span className="inline-flex items-center gap-1.5">
            Artifacts
            <span className="rounded-full bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground normal-case tracking-normal">
              {artifacts.length}
            </span>
          </span>
        </SectionLabel>
      </div>
      <ul className="min-w-0 divide-y divide-border/35 overflow-hidden rounded-xl border border-border/55 bg-[color-mix(in_srgb,var(--shell-surface-raised,var(--card))_88%,transparent)] px-0.5 py-0.5 shadow-sm">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              type="button"
              className={cn(
                "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                onOpenPlan
                  ? "cursor-pointer rounded-lg hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "cursor-default",
              )}
              disabled={!onOpenPlan}
              onClick={() => onOpenPlan?.()}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                {artifact.label}
              </span>
              {artifact.implemented ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">Done</span>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground">Plan</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {onOpenPlan ? (
        <div className="flex justify-end px-0.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpenPlan}
          >
            View plan
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ChangedFilesSection({
  model,
  onOpenTurnDiff,
}: {
  model: ThreadActivityChangedFiles;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
}) {
  const remaining = model.fileCount - model.files.length;
  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <SectionLabel>
          <span className="inline-flex items-center gap-1.5">
            Changed files
            <span className="rounded-full bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground normal-case tracking-normal">
              {model.fileCount}
            </span>
          </span>
        </SectionLabel>
        {hasNonZeroStat({ additions: model.additions, deletions: model.deletions }) ? (
          <DiffStatLabel
            additions={model.additions}
            deletions={model.deletions}
            className="text-[11px]"
            layout="inline"
          />
        ) : null}
      </div>

      <ul className="min-w-0 divide-y divide-border/35 overflow-hidden rounded-xl border border-border/55 bg-[color-mix(in_srgb,var(--shell-surface-raised,var(--card))_88%,transparent)] px-0.5 py-0.5 shadow-sm">
        {model.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={cn(
                "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                onOpenTurnDiff
                  ? "cursor-pointer rounded-lg hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "cursor-default",
              )}
              disabled={!onOpenTurnDiff}
              onClick={() => onOpenTurnDiff?.(model.turnId, file.path)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/90">
                {file.path}
              </span>
              {model.hasStats ? (
                <DiffStatLabel
                  additions={file.additions}
                  deletions={file.deletions}
                  className="shrink-0 text-[11px]"
                  layout="inline"
                />
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex min-w-0 items-center justify-between gap-2 px-0.5">
        {remaining > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            +{remaining} more file{remaining === 1 ? "" : "s"}
          </span>
        ) : (
          <span />
        )}
        {onOpenTurnDiff ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpenTurnDiff(model.turnId)}
          >
            View diff
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function ActivityPanel({
  model,
  onOpenTurnDiff,
  onOpenPlan,
}: {
  model: ThreadActivityViewModel;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenPlan?: () => void;
}) {
  const elapsed = useElapsedLabel(model.elapsedStartedAt, model.isWorking);
  const currentElapsed = useElapsedLabel(model.current?.startedAt ?? null, model.isWorking);
  // Newest first for instrument readout.
  const recent = [...model.recentSteps].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--shell-surface,var(--background))] text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Activity className="size-3.5 shrink-0 text-primary" aria-hidden />
          <h2 className="truncate text-[13px] font-semibold tracking-tight">Activity</h2>
        </div>
        {elapsed ? (
          <span className="shrink-0 rounded-md bg-muted/50 px-1.5 py-0.5 tabular-nums text-[11px] text-muted-foreground">
            Elapsed {elapsed}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground/65">Idle</span>
        )}
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-3.5 overflow-x-hidden p-2.5">
          {model.attention ? (
            <section
              className={cn(
                "min-w-0 overflow-hidden rounded-xl border px-2.5 py-2 text-[12px] shadow-sm",
                model.attention.kind === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-warning/40 bg-warning/10 text-warning",
              )}
            >
              <div className="flex min-w-0 items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <p className="min-w-0 break-words leading-snug">{model.attention.label}</p>
              </div>
            </section>
          ) : null}

          <section className="min-w-0 space-y-1.5">
            <SectionLabel>Current step</SectionLabel>
            {model.current ? (
              <div className="min-w-0 overflow-hidden rounded-xl border border-primary/35 bg-primary/10 px-2.5 py-2.5 shadow-sm ring-1 ring-primary/10">
                <div className="flex min-w-0 items-start gap-2">
                  {model.isWorking ? (
                    <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  )}
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="flex min-w-0 items-baseline justify-between gap-2">
                      <p className="truncate text-[12.5px] font-semibold tracking-tight text-foreground">
                        {model.current.label}
                      </p>
                      {currentElapsed ? (
                        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                          {currentElapsed}
                        </span>
                      ) : null}
                    </div>
                    {model.current.detail ? (
                      <p className="mt-0.5 line-clamp-2 break-all text-[11px] leading-snug text-muted-foreground">
                        {model.current.detail}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-border/55 bg-card/35 px-2.5 py-3 text-[12px] text-muted-foreground">
                No active step. Start a turn to see live work here.
              </p>
            )}
          </section>

          <section className="min-w-0 space-y-1.5">
            <SectionLabel>Recent steps</SectionLabel>
            {recent.length > 0 ? (
              <ul className="min-w-0 divide-y divide-border/35 overflow-hidden rounded-xl border border-border/55 bg-[color-mix(in_srgb,var(--shell-surface-raised,var(--card))_88%,transparent)] py-0.5 shadow-sm">
                {recent.map((step) => (
                  <RecentStepRow key={step.id} step={step} />
                ))}
              </ul>
            ) : (
              <p className="px-0.5 text-[12px] text-muted-foreground">
                No steps yet for this turn.
              </p>
            )}
          </section>

          {model.changedFiles ? (
            <ChangedFilesSection model={model.changedFiles} onOpenTurnDiff={onOpenTurnDiff} />
          ) : null}

          {model.artifacts.length > 0 ? (
            <ArtifactsSection artifacts={model.artifacts} onOpenPlan={onOpenPlan} />
          ) : null}

          {/* MCP only when authoritative live status exists. */}
          {!model.hasAuthoritativeMcpStatus ? null : null}
        </div>
      </ScrollArea>
    </div>
  );
}
