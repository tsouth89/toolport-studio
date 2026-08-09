import { Bot, Check, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { AgentRun, AgentRunStatus } from "../agentRuns";
import {
  isBackgroundTaskInFlight,
  type BackgroundTask,
  type BackgroundTaskStatus,
} from "../backgroundTasks";
import { cn } from "../lib/utils";
import { ScrollArea } from "./ui/scroll-area";

const STATUS_VISUALS: Record<AgentRunStatus, { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  stopped: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  unknown: { dotClass: "bg-muted-foreground/50", label: "Unknown" },
};

function StatusDot({ status }: { status: AgentRunStatus }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function statusLabel(status: AgentRunStatus): string {
  switch (status) {
    case "pending":
      return "Working";
    case "running":
      return "Working";
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

const TASK_DOT_CLASS: Record<BackgroundTaskStatus, string> = {
  pending: "bg-info",
  running: "bg-info",
  paused: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/60",
};

function TaskStatusDot({ status }: { status: BackgroundTaskStatus }) {
  return <span aria-hidden className={cn("size-1.5 rounded-full", TASK_DOT_CLASS[status])} />;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, completedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  return Number.isNaN(start) || Number.isNaN(end) ? "" : formatElapsedSeconds((end - start) / 1000);
}

/** Live elapsed time updates without forcing a React render every second. */
function AgentElapsed({ run }: { run: AgentRun }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = run.status === "pending" || run.status === "running";

  useEffect(() => {
    if (!live) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = elapsedBetween(run.startedAt, null);
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [live, run.startedAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(run.startedAt, live ? null : run.completedAt)}
    </span>
  );
}

function agentActivityText(run: AgentRun): string {
  const lifecycleKinds = new Set(["agent.started", "agent.updated", "agent.completed"]);
  const latestWork = run.activities
    .toReversed()
    .find((activity) => !lifecycleKinds.has(activity.kind));
  const live = run.status === "pending" || run.status === "running";
  if (live) return latestWork?.summary ?? run.message ?? run.prompt ?? "Working";
  return run.message ?? latestWork?.summary ?? statusLabel(run.status);
}

function taskStatusLabel(task: BackgroundTask): string {
  switch (task.status) {
    case "pending":
      return "Queued";
    case "running":
      return task.backgrounded ? "Watching" : "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

/**
 * Background work that outlives the turn (shells, monitors, and dev servers).
 * It stays visually separate from the agent fleet so "agent" keeps one meaning.
 */
function BackgroundTasksSection({ tasks }: { tasks: ReadonlyArray<BackgroundTask> }) {
  const runningCount = tasks.filter(isBackgroundTaskInFlight).length;

  return (
    <div data-testid="background-tasks-section">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/45 bg-background/95 px-3 py-2 backdrop-blur">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/80 uppercase">
          Background work
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground" role="status">
          {runningCount > 0
            ? `${runningCount} running · ${tasks.length} total`
            : `${tasks.length} total`}
        </span>
      </div>
      <ul className="space-y-1 p-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="grid h-14 grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-2 rounded-md px-2 py-1"
          >
            <span className="col-start-1 row-start-1 flex items-center">
              <TaskStatusDot status={task.status} />
            </span>
            <span className="col-start-2 row-start-1 block truncate text-xs font-medium">
              {task.label}
            </span>
            <span className="col-start-3 row-start-1 text-[10px] text-muted-foreground">
              {taskStatusLabel(task)}
            </span>
            <span
              className={cn(
                "col-start-2 col-end-4 row-start-2 flex min-w-0 items-center gap-1 truncate font-mono text-[11px]",
                task.error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {task.command ? <TerminalSquare className="size-3 shrink-0" aria-hidden /> : null}
              <span className="truncate">
                {task.error ?? task.command ?? task.kind ?? "Background task"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentsPanel(props: {
  runs: ReadonlyArray<AgentRun>;
  backgroundTasks?: ReadonlyArray<BackgroundTask>;
  selectedAgentRunId: string | null;
  onSelectAgent: (agentRunId: string) => void;
}) {
  const backgroundTasks = props.backgroundTasks ?? [];
  const selected =
    props.runs.find((run) => run.id === props.selectedAgentRunId) ?? props.runs[0] ?? null;
  const activeCount = props.runs.filter(
    (run) => run.status === "pending" || run.status === "running",
  ).length;

  if (props.runs.length === 0 && backgroundTasks.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        data-testid="agents-panel"
      >
        <div className="max-w-xs text-center">
          <Bot className="mx-auto size-7 text-muted-foreground/65" aria-hidden />
          <h3 className="mt-3 text-sm font-medium text-foreground">Nothing running</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Subagents and background tasks — watched commands, monitors, detached work — appear here
            with their live status.
          </p>
        </div>
      </div>
    );
  }

  // Tasks without subagents: the roster is the whole panel, so give it the
  // full height instead of squeezing it above an empty Subagents list.
  if (props.runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="agents-panel">
        <ScrollArea className="min-h-0 flex-1">
          <BackgroundTasksSection tasks={backgroundTasks} />
        </ScrollArea>
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
            Agents
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground" role="status">
            {activeCount > 0
              ? `${activeCount} working · ${props.runs.length} total`
              : `${props.runs.length} total`}
          </span>
        </div>
        <div className="space-y-1 p-2">
          {props.runs.map((run) => {
            const toolUses = run.activities.filter((activity) => activity.kind.startsWith("tool."));
            const metadata = [
              run.model,
              run.reasoningEffort ? `${run.reasoningEffort} reasoning` : null,
              toolUses.length > 0
                ? `${toolUses.length} tool${toolUses.length === 1 ? "" : "s"}`
                : null,
            ].filter((value): value is string => value !== null);
            return (
              <button
                key={run.id}
                type="button"
                className={cn(
                  "grid h-[3.875rem] w-full min-w-0 grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left transition-colors",
                  selected?.id === run.id ? "bg-accent/70 text-foreground" : "hover:bg-accent/45",
                )}
                style={{ paddingInlineStart: `${6 + run.depth * 14}px` }}
                onClick={() => props.onSelectAgent(run.id)}
                aria-current={selected?.id === run.id ? "true" : undefined}
              >
                <span className="col-start-1 row-start-1 flex items-center">
                  <StatusDot status={run.status} />
                </span>
                <span className="col-start-2 row-start-1 block min-w-0 truncate text-sm font-medium">
                  {run.label}
                </span>
                <span className="col-start-3 row-start-1 inline-flex min-w-14 items-center justify-end gap-1 font-mono text-[.7rem] text-muted-foreground/80">
                  <AgentElapsed run={run} />
                  {run.status === "completed" ? (
                    <Check aria-hidden className="size-3 text-success" />
                  ) : null}
                  {run.status === "failed" ? (
                    <X aria-hidden className="size-3 text-destructive" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "col-start-2 col-end-4 row-start-2 block truncate text-xs",
                    run.status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {agentActivityText(run)}
                </span>
                <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] text-muted-foreground/70">
                  {metadata.length > 0 ? metadata.join(" · ") : STATUS_VISUALS[run.status].label}
                </span>
                <span className="sr-only">{STATUS_VISUALS[run.status].label}</span>
              </button>
            );
          })}
        </div>
        {backgroundTasks.length > 0 ? <BackgroundTasksSection tasks={backgroundTasks} /> : null}
      </ScrollArea>

      {selected ? (
        <ScrollArea className="min-h-0">
          <div className="space-y-5 p-4">
            <section>
              <div className="flex items-center gap-2">
                <StatusDot status={selected.status} />
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
