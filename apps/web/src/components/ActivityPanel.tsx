import { Activity, AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDuration } from "../session-logic";
import type {
  ThreadActivityStep,
  ThreadActivityStepStatus,
  ThreadActivityViewModel,
} from "../threadActivityViewModel";
import { cn } from "../lib/utils";
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

function StepStatusIcon({ status }: { status: ThreadActivityStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />;
    case "completed":
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />;
    case "info":
      return <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/65" aria-hidden />;
    case "failed":
    case "interrupted":
      return <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />;
    case "pending":
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />;
    default:
      return <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/65" aria-hidden />;
  }
}

function RecentStepRow({ step }: { step: ThreadActivityStep }) {
  const clock = formatStepClock(step.createdAt);
  return (
    <li className="flex min-w-0 items-center gap-2 overflow-hidden px-1 py-1.5 text-[12px]">
      <span className="shrink-0">
        <StepStatusIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        <p
          className={cn(
            "truncate font-medium",
            step.status === "running" ? "text-foreground" : "text-foreground/90",
          )}
        >
          {step.label}
        </p>
        {step.detail ? (
          <p className="mt-0.5 line-clamp-1 break-all text-[11px] text-muted-foreground">
            {step.detail}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/80">
        {clock || "—"}
      </span>
    </li>
  );
}

export function ActivityPanel({ model }: { model: ThreadActivityViewModel }) {
  const elapsed = useElapsedLabel(model.elapsedStartedAt, model.isWorking);
  const currentElapsed = useElapsedLabel(model.current?.startedAt ?? null, model.isWorking);
  // Newest first, matching mockup top-of-list recency while still showing plan order
  // as reverse chrono of milestones.
  const recent = [...model.recentSteps].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Activity className="size-3.5 shrink-0 text-primary" aria-hidden />
          <h2 className="truncate text-[13px] font-semibold tracking-tight">Activity</h2>
        </div>
        {elapsed ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
            Elapsed {elapsed}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">Idle</span>
        )}
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-4 overflow-x-hidden p-3">
          {model.attention ? (
            <section
              className={cn(
                "min-w-0 overflow-hidden rounded-lg border px-2.5 py-2 text-[12px]",
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
            <h3 className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Current step
            </h3>
            {model.current ? (
              <div className="min-w-0 overflow-hidden rounded-lg border border-primary/30 bg-primary/8 px-2.5 py-2.5 shadow-sm">
                <div className="flex min-w-0 items-start gap-2">
                  {model.isWorking ? (
                    <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  )}
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div className="flex min-w-0 items-baseline justify-between gap-2">
                      <p className="truncate text-[12.5px] font-semibold text-foreground">
                        {model.current.label}
                      </p>
                      {currentElapsed ? (
                        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                          {currentElapsed}
                        </span>
                      ) : null}
                    </div>
                    {model.current.detail ? (
                      <p className="mt-0.5 line-clamp-2 break-all text-[11px] text-muted-foreground">
                        {model.current.detail}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-border/60 bg-card/40 px-2.5 py-3 text-[12px] text-muted-foreground">
                No active step. Start a turn to see live work here.
              </p>
            )}
          </section>

          <section className="min-w-0 space-y-1.5">
            <h3 className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              Recent steps
            </h3>
            {recent.length > 0 ? (
              <ul className="min-w-0 divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-card/30 px-1.5 py-0.5">
                {recent.map((step) => (
                  <RecentStepRow key={step.id} step={step} />
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-muted-foreground">No steps yet for this turn.</p>
            )}
          </section>

          {/* MCP / changed files / artifacts: later slices when data is authoritative. */}
          {!model.hasAuthoritativeMcpStatus ? null : null}
        </div>
      </ScrollArea>
    </div>
  );
}
