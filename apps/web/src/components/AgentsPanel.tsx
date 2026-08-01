import { Bot, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";

import type { AgentRun, AgentRunStatus } from "../agentRuns";
import { cn } from "../lib/utils";
import { ScrollArea } from "./ui/scroll-area";

function StatusIcon({ status }: { status: AgentRunStatus }) {
  switch (status) {
    case "pending":
    case "unknown":
      return <Circle className="size-3.5 text-muted-foreground" aria-hidden />;
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />;
    case "completed":
      return <CheckCircle2 className="size-3.5 text-success" aria-hidden />;
    case "failed":
      return <XCircle className="size-3.5 text-destructive" aria-hidden />;
    case "interrupted":
    case "stopped":
      return <XCircle className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

function statusLabel(status: AgentRunStatus): string {
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

export function AgentsPanel(props: {
  runs: ReadonlyArray<AgentRun>;
  selectedAgentRunId: string | null;
  onSelectAgent: (agentRunId: string) => void;
}) {
  const selected =
    props.runs.find((run) => run.id === props.selectedAgentRunId) ?? props.runs[0] ?? null;
  const activeCount = props.runs.filter(
    (run) => run.status === "pending" || run.status === "running",
  ).length;

  if (props.runs.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        data-testid="agents-panel"
      >
        <div className="max-w-xs text-center">
          <Bot className="mx-auto size-7 text-muted-foreground/65" aria-hidden />
          <h3 className="mt-3 text-sm font-medium text-foreground">No subagents yet</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Native provider subagents will appear here with their live status and recent work.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid min-h-0 flex-1 grid-rows-[minmax(8rem,0.8fr)_minmax(0,1.2fr)]"
      data-testid="agents-panel"
    >
      <ScrollArea className="min-h-0 border-b border-border/60">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/45 bg-background/95 px-3 py-2 backdrop-blur">
          <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/80 uppercase">
            Subagents
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground" role="status">
            {activeCount > 0
              ? `${activeCount} active · ${props.runs.length} total`
              : `${props.runs.length} total`}
          </span>
        </div>
        <div className="space-y-1 p-2">
          {props.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                selected?.id === run.id ? "bg-accent text-foreground" : "hover:bg-accent/55",
              )}
              style={{ paddingInlineStart: `${8 + run.depth * 16}px` }}
              onClick={() => props.onSelectAgent(run.id)}
              aria-current={selected?.id === run.id ? "true" : undefined}
            >
              <span className="mt-0.5 shrink-0">
                <StatusIcon status={run.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{run.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {run.prompt ?? run.message ?? statusLabel(run.status)}
                </span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {statusLabel(run.status)}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>

      {selected ? (
        <ScrollArea className="min-h-0">
          <div className="space-y-5 p-4">
            <section>
              <div className="flex items-center gap-2">
                <StatusIcon status={selected.status} />
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.label}</h3>
                <span className="text-[11px] text-muted-foreground">
                  {statusLabel(selected.status)}
                </span>
              </div>
              {selected.prompt ? (
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
                  {selected.prompt}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {selected.model ? <span>{selected.model}</span> : null}
                {selected.reasoningEffort ? (
                  <span>{selected.reasoningEffort} reasoning</span>
                ) : null}
                {selected.providerThreadId ? (
                  <span className="truncate font-mono" title={selected.providerThreadId}>
                    {selected.providerThreadId}
                  </span>
                ) : null}
              </div>
              {selected.message ? (
                <div className="mt-3 rounded-lg border border-border/55 bg-muted/35 px-3 py-2 text-xs leading-relaxed">
                  {selected.message}
                </div>
              ) : null}
            </section>

            <section>
              <h4 className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/80 uppercase">
                Recent activity
              </h4>
              <ol className="mt-2 divide-y divide-border/40 overflow-hidden rounded-lg border border-border/55">
                {selected.activities.slice(-12).map((activity) => (
                  <li key={activity.id} className="flex items-start gap-2 px-2.5 py-2 text-xs">
                    <span
                      className={cn(
                        "mt-1 block size-1.5 shrink-0 rotate-45 rounded-[1px] bg-current",
                        activity.tone === "error" ? "text-destructive" : "text-muted-foreground",
                      )}
                    />
                    <span className="min-w-0 flex-1 break-words text-foreground/85">
                      {activity.summary}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}
