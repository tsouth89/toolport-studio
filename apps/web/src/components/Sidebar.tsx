import { autoAnimate } from "@formkit/auto-animate";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@toolport-studio/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@toolport-studio/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@toolport-studio/contracts";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  EllipsisIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@toolport-studio/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import {
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProjectlessThreadHandler } from "../hooks/useProjectlessThread";
import { openCommandPalette } from "../commandPaletteBus";
import { isGeneralChatProject } from "../lib/generalChat";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import {
  buildActiveSidebarProjectPanels,
  encodeSidebarThreadDragPayload,
  formatWorkingDurationLabel,
  hasUnseenCompletion,
  isThreadAlreadyInProject,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  parseSidebarThreadDragPayload,
  resolveAdjacentThreadId,
  resolveSameEnvironmentProjectMember,
  resolveSidebarProjectShelfExpanded,
  resolveSidebarStatus,
  resolveWorkingStartedAt,
  shouldNavigateAfterProjectRemoval,
  SIDEBAR_DND_PROJECT_MIME,
  SIDEBAR_DND_THREAD_MIME,
  sortLogicalProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { prStatusIndicator, resolveThreadPr } from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { CommandDialogTrigger } from "./ui/command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useComposerDraftStore } from "../composerDraftStore";

const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

// Floats at the row's right edge, vertically centered, while the jump
// modifier is held. An overlay pill instead of an inline slot: the hint
// must neither displace the status/time label (holding ⌘ used to blank
// out "Working") nor shift any layout when it appears. pointer-events-none
// so it never swallows clicks meant for wake/archive buttons it can overlap.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return <span className="tabular-nums">{formatWorkingDurationLabel(Date.now() - startedMs)}</span>;
}

function SidebarThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  environmentLabel,
  driverKind,
  presetId,
  modelInstanceId,
  modelLabel,
  branchMismatch,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  environmentLabel: string | null;
  driverKind: ProviderInstanceEntry["driverKind"] | null;
  presetId: ProviderInstanceEntry["presetId"];
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
}) {
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={8}
      className="dropdown-glass max-w-80 border-0! text-left whitespace-normal shadow-lg/10 before:hidden dark:shadow-none"
      style={{
        background:
          "color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity), transparent))",
      }}
    >
      <div className="flex max-w-80 flex-col gap-2 p-2">
        <div className="whitespace-nowrap text-sm font-medium text-foreground">{thread.title}</div>
        <div className="grid gap-1.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                className="size-4 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-4 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 wrap-break-word text-foreground/90">{thread.branch}</div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                presetId={presetId}
                displayName={thread.session?.providerName ?? modelInstanceId}
                iconClassName="size-4 shrink-0"
              />
              <div className="min-w-0 wrap-break-word text-foreground/90">{modelLabel}</div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-4 shrink-0 stroke-current" />
              <div className="min-w-0 wrap-break-word">{thread.session.lastError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

const SidebarRow = memo(function SidebarRow(props: {
  thread: SidebarThreadSummary;
  isActive: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  projectCwd: string | null;
  projectTitle: string | null;
  /** Nested under project shelves: hide redundant project name on the row. */
  nestUnderProjectShelf?: boolean;
  isDragging?: boolean;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onArchive: (threadRef: ScopedThreadRef) => void;
  onDragStart?: (event: ReactDragEvent, thread: SidebarThreadSummary) => void;
  onDragEnd?: () => void;
}) {
  const {
    isRenaming,
    nestUnderProjectShelf = false,
    isDragging = false,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onRenameTitleChange,
    onArchive,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onDragStart,
    onDragEnd,
    renamingTitle,
    thread,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();

  // Same semantics as v1 (never-visited counts as read).
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarStatus(thread);
  const isInFlight = status === "working" || status === "approval" || status === "input";
  // Live work, a finished-but-unseen turn, and failures are what you scan for —
  // they hold the prominence. Settled rows you have already read recede.
  const isLive = isInFlight || isUnread || status === "failed";
  const shouldRecede = !isLive && !props.isActive && !isSelected;
  const topStatus =
    status === "working"
      ? {
          label: "Working",
          icon: "working" as const,
          className:
            "animate-sidebar-working-text text-sky-600 motion-reduce:animate-none dark:text-sky-400",
        }
      : status === "approval"
        ? {
            label: "Approval",
            icon: null,
            className: "text-amber-700 dark:text-amber-300",
          }
        : status === "input"
          ? {
              label: "Input",
              icon: null,
              className: "text-indigo-600 dark:text-indigo-300",
            }
          : status === "failed"
            ? {
                label: "Failed",
                icon: null,
                className: "text-red-700 dark:text-red-300",
              }
            : isUnread
              ? {
                  label: "Done",
                  icon: "done" as const,
                  className: "text-emerald-700 dark:text-emerald-300",
                }
              : null;

  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const pr = resolveThreadPr({
    threadBranch: thread.branch,
    gitStatus: gitStatus.data,
    hasDedicatedWorktree: thread.worktreePath !== null,
  });
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);

  // Prefer the live session instance, but fall back to the thread's model
  // selection so a running session still shows its provider mark if the
  // session id is briefly missing from the providers map.
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry =
    props.providerEntryByInstanceId.get(modelInstanceId) ??
    props.providerEntryByInstanceId.get(thread.modelSelection.instanceId) ??
    null;
  const driverKind = providerEntry?.driverKind ?? null;
  const presetId = providerEntry?.presetId;
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const isRemote =
    props.currentEnvironmentId !== null && thread.environmentId !== props.currentEnvironmentId;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      projectTitle={props.projectTitle}
      projectCwd={props.projectCwd}
      environmentLabel={props.environmentLabel}
      driverKind={driverKind}
      presetId={presetId}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handleArchiveClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onArchive(threadRef);
    },
    [onArchive, threadRef],
  );
  const handleRowDragStart = useCallback(
    (event: ReactDragEvent) => {
      if (isRenaming || !onDragStart) {
        event.preventDefault();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, a")) {
        event.preventDefault();
        return;
      }
      onDragStart(event, thread);
    },
    [isRenaming, onDragStart, thread],
  );
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (pr?.url) openPrLink(event, pr.url);
    },
    [openPrLink, pr],
  );

  // All Sidebar V2 rows share one surface model. Live threads used to look
  // like elevated cards while settled threads were plain rows, leaving neither
  // a useful hierarchy nor a reliable hover cue. Status now lives in the row
  // content; surface is reserved for interaction (hover, multi-select, route).
  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none",
    props.isActive
      ? "bg-sidebar-row-active/60 text-sidebar-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sky-400"
      : isSelected
        ? "bg-sidebar-row-selected/70 text-sidebar-foreground"
        : shouldRecede
          ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    isDragging && "opacity-50",
    onDragStart && !isRenaming && "cursor-grab active:cursor-grabbing",
  );

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-[13px] font-medium text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-[13px] leading-5",
        // Title is the row; keep weight light like Claude Desktop.
        isLive || props.isActive ? "font-medium" : "font-normal",
        // Derived from foreground, not muted-foreground: the dark theme lifts
        // muted toward white, so muted/80 sat only a shade below a live row and
        // the two states read the same.
        shouldRecede
          ? "text-foreground/50"
          : isLive
            ? "text-foreground"
            : "text-sidebar-foreground/90",
      )}
    >
      {thread.title}
    </span>
  );

  // Nested project shelves already show the project; keep ungrouped rows a
  // touch more informative with a tiny project mark when needed.
  const showProjectFavicon = !nestUnderProjectShelf && props.projectCwd != null;

  return (
    <li
      data-thread-item
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_28px]"
      draggable={!isRenaming && onDragStart != null}
      onDragStart={handleRowDragStart}
      onDragEnd={onDragEnd}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role="button"
              tabIndex={0}
              data-testid="sidebar-row-card"
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {/* Provider identity and thread status share one compact mark. Status
              overlays the provider instead of creating another visual column. */}
          <div
            className={cn(
              "relative z-10 flex h-7 min-w-0 items-center gap-1.5 px-2",
              nestUnderProjectShelf && "ps-4",
            )}
          >
            <span
              className="relative flex size-4 shrink-0 items-center justify-center text-sidebar-muted-foreground"
              title={
                topStatus?.label ??
                (driverKind
                  ? (thread.session?.providerName ?? modelInstanceId)
                  : (props.projectTitle ?? undefined))
              }
            >
              <span
                className={cn(
                  "flex size-3.5 items-center justify-center transition-[opacity,filter]",
                  shouldRecede && "opacity-50 saturate-50",
                )}
              >
                {driverKind ? (
                  <ProviderInstanceIcon
                    driverKind={driverKind}
                    presetId={presetId}
                    displayName={thread.session?.providerName ?? modelInstanceId}
                    iconClassName="size-3.5"
                  />
                ) : showProjectFavicon ? (
                  <ProjectFavicon
                    environmentId={thread.environmentId}
                    cwd={props.projectCwd ?? ""}
                    className="size-3.5 opacity-80"
                  />
                ) : null}
              </span>
              {topStatus ? (
                <span
                  aria-hidden
                  className={cn(
                    driverKind || showProjectFavicon
                      ? "absolute -bottom-px -right-px size-2 ring-2 ring-sidebar"
                      : "size-1.5",
                    "block rounded-full",
                    status === "working"
                      ? "animate-status-pulse bg-sky-500 dark:bg-sky-400"
                      : status === "approval"
                        ? "bg-amber-500 dark:bg-amber-300"
                        : status === "input"
                          ? "bg-indigo-500 dark:bg-indigo-300"
                          : status === "failed"
                            ? "bg-red-500 dark:bg-red-400"
                            : "bg-emerald-500 dark:bg-emerald-400",
                  )}
                />
              ) : null}
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{title}</div>
            {/* Fixed-width trailing rail: title truncates against this edge at rest
                and on hover, so actions never sit on top of the name. Elapsed
                "1m" / archive both fit here without shrinking the leading rails. */}
            <span className="relative ml-auto flex h-5 w-16 shrink-0 items-center justify-end">
              <span
                className={cn(
                  "flex items-center justify-end transition-opacity group-hover/sidebar-row:pointer-events-none group-hover/sidebar-row:opacity-0",
                  "group-focus-within/sidebar-row:pointer-events-none group-focus-within/sidebar-row:opacity-0",
                )}
              >
                {status === "working" ? (
                  <span
                    className={cn(
                      "inline-flex items-center text-[11px] tabular-nums",
                      topStatus?.className,
                    )}
                    role="status"
                  >
                    <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  "absolute inset-y-0 right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity",
                  "pointer-events-none group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100",
                  "group-focus-within/sidebar-row:pointer-events-auto group-focus-within/sidebar-row:opacity-100",
                )}
              >
                {prStatus && pr ? (
                  <button
                    type="button"
                    onClick={handlePrClick}
                    className={cn(
                      "shrink-0 font-mono text-[10px] hover:underline",
                      prStatus.colorClass,
                    )}
                    aria-label={prStatus.tooltip}
                  >
                    #{pr.number}
                  </button>
                ) : (
                  <span className="tabular-nums text-[11px] text-muted-foreground/55">
                    {threadTimeLabel(thread)}
                  </span>
                )}
                {isRemote ? (
                  <ServerIcon
                    aria-hidden
                    className="size-3 shrink-0 text-sidebar-muted-foreground/65"
                  />
                ) : null}
                <button
                  type="button"
                  aria-label="Archive chat"
                  onClick={handleArchiveClick}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md bg-transparent text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
                >
                  <ArchiveIcon className="size-3.5" />
                </button>
              </span>
            </span>
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

export default function Sidebar() {
  const projects = useProjects();
  const visibleProjects = useMemo(
    () => projects.filter((project) => !isGeneralChatProject(project)),
    [projects],
  );
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const pinnedProjectKeys = useUiStateStore((store) => store.pinnedProjectKeys);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const reorderProjectsInStore = useUiStateStore((store) => store.reorderProjects);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const setProjectPinned = useUiStateStore((store) => store.setProjectPinned);
  const reorderPinnedProjectKeys = useUiStateStore((store) => store.reorderPinnedProjectKeys);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { archiveThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateSettings = useUpdateClientSettings();
  const { copyToClipboard: copyProjectPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const [projectActionsTarget, setProjectActionsTarget] = useState<SidebarProjectSnapshot | null>(
    null,
  );
  const [projectScopeMenuOpen, setProjectScopeMenuOpen] = useState(false);
  const newThreadContext = useHandleNewThread();
  const startProjectlessThread = useProjectlessThreadHandler();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  // Post-settle navigation validates against the CURRENT route, not the one
  // captured when the settle started: if the user navigated elsewhere while
  // the command was in flight, completing it must not yank them away.
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: visibleProjects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, visibleProjects],
  );
  // All projects (including General) in user shelf order. Manual is the product
  // default: shelves stay put; pins float to the top.
  const orderedAllProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [environmentLabelById, orderedProjects, primaryEnvironmentId, projectGroupingSettings],
  );
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, "manual"),
    [threads, unsortedProjectGroups],
  );
  // Include General / projectless as a peer group for the active list (SOU-417).
  // Scope picker still uses projectGroups without General.
  const unsortedThreadListProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedAllProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).map((group) => {
        const isNoProject =
          group.memberProjects.length > 0 &&
          group.memberProjects.every((member) => isGeneralChatProject(member));
        return {
          ...group,
          displayName: isNoProject ? "No project" : group.displayName,
          isNoProject,
        };
      }),
    [environmentLabelById, orderedAllProjects, primaryEnvironmentId, projectGroupingSettings],
  );
  const threadListProjectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedThreadListProjectGroups, threads, "manual"),
    [threads, unsortedThreadListProjectGroups],
  );
  // Keep settings field for Settings UI / legacy, but thread list always uses
  // shelf order + pins (not activity auto-sort).
  void sidebarProjectSortOrder;
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleProjectThreadListExpanded = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }, []);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByInstanceId = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );
  const projectCwdByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.workspaceRoot,
        ]),
      ),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  // Project scope: one menu above the list. Scoping filters the list without
  // making the header width depend on the number or length of project names.
  const [projectScopeKey, setProjectScopeKey] = useState<string | null>(null);
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  useEffect(() => {
    if (projectScopeKey !== null && scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [projectScopeKey, scopedProjectGroup]);
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  const handleRemoveProjectMembers = useCallback(
    async (projectGroup: SidebarProjectSnapshot, members: readonly SidebarProjectGroupMember[]) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === projectGroup.memberProjects.length;
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? projectGroup.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          projectThreads.length > 0
            ? [
                `Remove project "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                "This permanently clears conversation history for those threads.",
                isWholeGroup
                  ? "This removes only the project entries, not the files on disk."
                  : "Other entries in this grouped project are unaffected.",
                "This action cannot be undone.",
              ].join("\n")
            : [
                `Remove project "${targetLabel}"?`,
                ...(singleMember
                  ? [
                      `Path: ${singleMember.workspaceRoot}`,
                      ...(singleMember.environmentLabel
                        ? [`Environment: ${singleMember.environmentLabel}`]
                        : []),
                    ]
                  : [`This removes ${members.length} grouped project entries.`]),
                isWholeGroup
                  ? "This removes only the project entries, not the files on disk."
                  : "Other entries in this grouped project are unaffected.",
              ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      let shouldNavigate = false;
      for (const project of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        );
        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
        const memberRemovalNeedsNavigation = shouldNavigateAfterProjectRemoval({
          routeTarget: routeTargetRef.current,
          projectThreads: memberThreads,
          projectDraftId: projectDraftThread?.draftId ?? null,
        });

        const result = await deleteProject({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            ...(memberThreads.length > 0 ? { force: true } : {}),
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Failed to remove "${project.title}"`,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          if (shouldNavigate) {
            void router.navigate({ to: "/" });
          }
          return;
        }

        shouldNavigate ||= memberRemovalNeedsNavigation;
        if (projectDraftThread) {
          draftStore.clearDraftThread(projectDraftThread.draftId);
        }
        draftStore.clearProjectDraftThreadId(projectRef);
      }

      if (shouldNavigate) {
        void router.navigate({ to: "/" });
      }
    },
    [deleteProject, router, threads],
  );

  const renameProjectMember = useCallback(
    async (member: SidebarProjectGroupMember, nextTitle: string) => {
      const title = nextTitle.trim();
      if (!title) {
        toastManager.add({ type: "warning", title: "Project title cannot be empty" });
        return;
      }
      if (title === member.title) return;
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, title },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [updateProject],
  );

  const updateProjectGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateSettings],
  );

  const handleProjectActions = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, projectGroup: SidebarProjectSnapshot) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectScopeMenuOpen(false);
      window.requestAnimationFrame(() => setProjectActionsTarget(projectGroup));
    },
    [],
  );

  // Archive removes from the sidebar entirely (Settings → Archive to restore).
  // Soft-done path is Archive; no Settled/Snooze shelves.
  const activeThreads = useMemo(() => {
    const visible = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
    );
    return sortThreadsForSidebar(visible);
  }, [scopedProjectKeys, threads]);

  const activeProjectPanels = useMemo(
    () =>
      buildActiveSidebarProjectPanels({
        projectGroups: threadListProjectGroups,
        activeThreads,
        activeThreadId: routeThreadRef?.threadId ?? null,
        activeThreadEnvironmentId: routeThreadRef?.environmentId ?? null,
        expandedProjectKeys,
        previewLimit: sidebarThreadPreviewCount,
        pinnedProjectKeys,
      }),
    [
      activeThreads,
      expandedProjectKeys,
      pinnedProjectKeys,
      routeThreadRef?.environmentId,
      routeThreadRef?.threadId,
      sidebarThreadPreviewCount,
      threadListProjectGroups,
    ],
  );

  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null);
  const [draggingThreadKey, setDraggingThreadKey] = useState<string | null>(null);
  const [dragOverProjectKey, setDragOverProjectKey] = useState<string | null>(null);
  const [dragOverKind, setDragOverKind] = useState<"project" | "thread" | null>(null);

  const physicalKeysForProjectKey = useCallback(
    (projectKey: string): string[] => {
      const group = threadListProjectGroups.find((entry) => entry.projectKey === projectKey);
      if (!group) return [];
      return group.memberProjects.map((member) => getProjectOrderKey(member));
    },
    [threadListProjectGroups],
  );

  const currentPhysicalOrder = useMemo(() => {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const group of threadListProjectGroups) {
      for (const member of group.memberProjects) {
        const key = getProjectOrderKey(member);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
    }
    // Include ordered physical keys not currently in a thread-bearing group so
    // reorder does not drop them from projectOrder.
    for (const key of projectOrder) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }, [projectOrder, threadListProjectGroups]);

  const clearSidebarDragState = useCallback(() => {
    setDraggingProjectKey(null);
    setDraggingThreadKey(null);
    setDragOverProjectKey(null);
    setDragOverKind(null);
  }, []);

  const handleProjectGroupDragStart = useCallback((event: ReactDragEvent, projectKey: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SIDEBAR_DND_PROJECT_MIME, projectKey);
    // Fallback for environments that only expose text/plain on drop.
    event.dataTransfer.setData("text/plain", projectKey);
    setDraggingProjectKey(projectKey);
    setDraggingThreadKey(null);
  }, []);

  const handleThreadRowDragStart = useCallback(
    (event: ReactDragEvent, thread: SidebarThreadSummary) => {
      event.dataTransfer.effectAllowed = "move";
      const payload = encodeSidebarThreadDragPayload({
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
      });
      event.dataTransfer.setData(SIDEBAR_DND_THREAD_MIME, payload);
      event.dataTransfer.setData("text/plain", payload);
      setDraggingThreadKey(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
      setDraggingProjectKey(null);
    },
    [],
  );

  const handleThreadRowDragEnd = useCallback(() => {
    clearSidebarDragState();
  }, [clearSidebarDragState]);

  const handleProjectGroupDragOver = useCallback(
    (event: ReactDragEvent, projectKey: string) => {
      const types = new Set(event.dataTransfer.types);
      // Prefer live drag state (reliable across browsers); fall back to MIME.
      const kind: "project" | "thread" =
        draggingThreadKey != null || types.has(SIDEBAR_DND_THREAD_MIME) ? "thread" : "project";
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverProjectKey(projectKey);
      setDragOverKind(kind);
    },
    [draggingThreadKey],
  );

  const moveThreadToProjectGroup = useCallback(
    async (
      payload: {
        environmentId: string;
        threadId: string;
        projectId: string;
      },
      targetProjectKey: string,
    ) => {
      const group = threadListProjectGroups.find((entry) => entry.projectKey === targetProjectKey);
      if (!group) return;
      const member = resolveSameEnvironmentProjectMember(
        group.memberProjectRefs,
        payload.environmentId,
      );
      if (!member) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn’t move session",
            description: "A conversation can only move within its current environment.",
          }),
        );
        return;
      }
      if (
        isThreadAlreadyInProject({
          sourceProjectId: payload.projectId,
          targetProjectId: member.projectId,
        })
      ) {
        return;
      }
      const result = await updateThreadMetadata({
        environmentId: EnvironmentId.make(payload.environmentId),
        input: {
          threadId: ThreadId.make(payload.threadId),
          projectId: ProjectId.make(member.projectId),
          // Folder change invalidates checkout binding (same as command palette attach).
          branch: null,
          worktreePath: null,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn’t move session",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [threadListProjectGroups, updateThreadMetadata],
  );

  const handleProjectGroupDrop = useCallback(
    (event: ReactDragEvent, targetProjectKey: string) => {
      event.preventDefault();
      const threadRaw =
        event.dataTransfer.getData(SIDEBAR_DND_THREAD_MIME) ||
        (draggingThreadKey != null ? event.dataTransfer.getData("text/plain") : "");
      const threadPayload = parseSidebarThreadDragPayload(threadRaw);
      if (threadPayload) {
        clearSidebarDragState();
        void moveThreadToProjectGroup(threadPayload, targetProjectKey);
        return;
      }

      const draggedKey =
        event.dataTransfer.getData(SIDEBAR_DND_PROJECT_MIME) ||
        event.dataTransfer.getData("text/plain") ||
        draggingProjectKey ||
        "";
      clearSidebarDragState();
      if (!draggedKey || draggedKey === targetProjectKey) {
        return;
      }
      // Reject accidental drops of non-project text.
      if (draggedKey.startsWith("{")) {
        return;
      }
      const draggedPinned = pinnedProjectKeys.includes(draggedKey);
      const targetPinned = pinnedProjectKeys.includes(targetProjectKey);
      if (draggedPinned && targetPinned) {
        reorderPinnedProjectKeys(pinnedProjectKeys, draggedKey, targetProjectKey);
        return;
      }
      // Moving across pin boundary: drop pin status of dragged if needed and
      // reorder shelves by physical keys.
      if (draggedPinned && !targetPinned) {
        setProjectPinned(draggedKey, false);
      }
      if (!draggedPinned && targetPinned) {
        setProjectPinned(draggedKey, true);
      }
      const draggedPhysical = physicalKeysForProjectKey(draggedKey);
      const targetPhysical = physicalKeysForProjectKey(targetProjectKey);
      if (draggedPhysical.length === 0 || targetPhysical.length === 0) {
        return;
      }
      reorderProjectsInStore(currentPhysicalOrder, draggedPhysical, targetPhysical);
      if (sidebarProjectSortOrder !== "manual") {
        updateSettings({ sidebarProjectSortOrder: "manual" });
      }
    },
    [
      clearSidebarDragState,
      currentPhysicalOrder,
      draggingProjectKey,
      draggingThreadKey,
      moveThreadToProjectGroup,
      physicalKeysForProjectKey,
      pinnedProjectKeys,
      reorderPinnedProjectKeys,
      reorderProjectsInStore,
      setProjectPinned,
      sidebarProjectSortOrder,
      updateSettings,
    ],
  );

  const handleProjectGroupDragEnd = useCallback(() => {
    clearSidebarDragState();
  }, [clearSidebarDragState]);

  const handleProjectGroupDragLeave = useCallback((event: ReactDragEvent, projectKey: string) => {
    const related = event.relatedTarget as Node | null;
    if (related && event.currentTarget.contains(related)) return;
    setDragOverProjectKey((current) => {
      if (current !== projectKey) return current;
      setDragOverKind(null);
      return null;
    });
  }, []);

  const toggleProjectPinned = useCallback(
    (event: ReactMouseEvent, projectKey: string, currentlyPinned: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      setProjectPinned(projectKey, !currentlyPinned);
      if (sidebarProjectSortOrder !== "manual") {
        updateSettings({ sidebarProjectSortOrder: "manual" });
      }
    },
    [setProjectPinned, sidebarProjectSortOrder, updateSettings],
  );

  const orderedThreads = useMemo(() => activeThreads, [activeThreads]);
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  // Rows call back into the click handler without carrying the ordered list as
  // a prop — a fresh array identity per shell update would defeat every row's
  // memoization. The ref keeps shift-range-select working against the list as
  // rendered at click time.
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  // handleNewThread is inherently unstable (depends on the projects list).
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const [showJumpHints, setShowJumpHints] = useState(false);

  // Settled threads are live shells, so opening one is plain navigation:
  // history stays readable without un-settling, and sending a message or
  // starting a session un-settles server-side.
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  const archivingThreadKeysRef = useRef(new Set<string>());
  const attemptArchive = useCallback(
    (threadRef: ScopedThreadRef, opts: { coArchivingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (archivingThreadKeysRef.current.has(threadKey)) return;
        archivingThreadKeysRef.current.add(threadKey);
        try {
          // archiveThread navigates when the open thread is archived; for bulk
          // we still plan forward when co-archiving several open-adjacent rows.
          void opts.coArchivingKeys;
          const result = await archiveThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive chat",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        } finally {
          archivingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [archiveThread],
  );
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // One exact actionable set: keys whose rows are actually rendered
      // right now. Selections can outlive their rows (settled-tail paging,
      // thread deletion elsewhere) and the menu labels must count only what
      // the actions will touch.
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter(
        (threadKey) => threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const hasRunningSelected = selectedThreads.some(
        (thread) => thread.session?.status === "running" && thread.session.activeTurnId != null,
      );
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            {
              id: "archive",
              label: `Archive chats (${count})`,
              disabled: hasRunningSelected,
            },
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "delete", label: `Delete chats (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "archive") {
        const coArchivingKeys = new Set(threadKeys);
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) continue;
          attemptArchive(scopeThreadRef(thread.environmentId, thread.id), { coArchivingKeys });
        }
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      // Grown as deletions actually land, never seeded with the whole batch:
      // orphaned-worktree detection must only discount threads that are
      // really gone, or the first delete would treat still-alive batch mates
      // as deleted and remove a worktree they still point at.
      const deletedThreadKeys = new Set<string>();
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to delete threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        deletedThreadKeys.add(threadKey);
      }
      removeFromSelection(threadKeys);
    },
    [
      attemptArchive,
      clearSelection,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const isRunning =
          thread.session?.status === "running" && thread.session.activeTurnId != null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(thread.branch
                ? [
                    {
                      id: "new-thread-on-branch",
                      label: `New thread on ${thread.branch}`,
                    },
                  ]
                : []),
              {
                id: "archive",
                label: "Archive chat",
                disabled: isRunning,
              },
              { id: "rename", label: "Rename chat" },
              { id: "mark-unread", label: "Mark unread" },
              ...(isElectron && window.desktopBridge?.openSessionPopOut
                ? [{ id: "open-popout", label: "Open in new window" }]
                : []),
              { id: "delete", label: "Delete chat", destructive: true, icon: "trash" },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "open-popout": {
            const openPopOut = window.desktopBridge?.openSessionPopOut;
            if (!openPopOut) return;
            try {
              await openPopOut({
                environmentId: String(thread.environmentId),
                threadId: String(thread.id),
              });
            } catch (error) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not open window",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "archive":
            attemptArchive(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete chat "${thread.title}"?`,
                    "This permanently clears conversation history for this chat.",
                  ].join("\n"),
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      attemptArchive,
      confirmThreadDelete,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      startThreadRename,
    ],
  );

  // Thread jump (cmd+1..9) and prev/next traversal reuse the same commands as
  // v1 — the keybinding layer is shared, only the ordered list differs.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Same predicate as v1: hints show only while the held modifiers exactly
  // match a thread-jump binding. Adding Shift (screenshots) or Alt no
  // longer matches ⌘1..9, so the overlay hides for chords like ⌘⇧4.
  const shortcutModifiers = useShortcutModifierState();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    { platform: navigator.platform },
  );
  useEffect(() => {
    setShowJumpHints(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow]);

  const attachListAutoAnimateRef = useCallback((node: HTMLUListElement | null) => {
    if (!node) return;
    autoAnimate(node, { duration: 150, easing: "ease-out" });
  }, []);

  const handleNewThreadClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void startProjectlessThread().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start a new chat",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }, [isMobile, setOpenMobile, startProjectlessThread]);

  const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const newThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.new");
  return (
    <>
      <SidebarChromeHeader
        isElectron={isElectron}
        newThreadDisabled={environments.length === 0}
        newThreadShortcutLabel={newThreadShortcutLabel}
        onNewThread={handleNewThreadClick}
      />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pb-2 pt-3">
          <CommandDialogTrigger
            render={
              <SidebarMenuButton
                size="sm"
                type="button"
                aria-label="Search threads and commands"
                className="group/search h-8 w-full gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                data-testid="command-palette-trigger"
              />
            }
          >
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <div className="flex-1 truncate text-left">Search</div>
            {commandPaletteShortcutLabel ? (
              <Kbd className="h-4 min-w-0 rounded-sm bg-sidebar-control-surface px-1.5 text-[10px] text-sidebar-muted-foreground opacity-55 ring-1 ring-sidebar-border transition-opacity group-hover/search:opacity-100 group-focus-visible/search:opacity-100">
                {commandPaletteShortcutLabel}
              </Kbd>
            ) : null}
          </CommandDialogTrigger>
        </SidebarGroup>
        {projectGroups.length > 0 ? (
          <SidebarGroup className="px-2 pb-2 pt-0">
            <div className="flex items-center">
              <Menu open={projectScopeMenuOpen} onOpenChange={setProjectScopeMenuOpen}>
                <MenuTrigger
                  aria-label="Filter threads by project"
                  className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                >
                  {scopedProjectGroup ? (
                    <ProjectFavicon
                      environmentId={scopedProjectGroup.environmentId}
                      cwd={scopedProjectGroup.workspaceRoot}
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {scopedProjectGroup?.displayName ?? "All projects"}
                  </span>
                  <ChevronDownIcon className="size-4 shrink-0 text-sidebar-muted-foreground/70" />
                </MenuTrigger>
                <MenuPopup align="start" className="w-(--anchor-width)">
                  <MenuRadioGroup
                    value={projectScopeKey ?? "all"}
                    onValueChange={(value) =>
                      setProjectScopeKey(value === "all" ? null : (value as string))
                    }
                  >
                    <MenuRadioItem
                      value="all"
                      closeOnClick
                      className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                    >
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="min-w-0 truncate text-sm">All projects</span>
                    </MenuRadioItem>
                    {projectGroups.map((project) => {
                      const scopeKey = project.projectKey;
                      return (
                        <MenuRadioItem
                          key={scopeKey}
                          value={scopeKey}
                          closeOnClick
                          className="h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            cwd={project.workspaceRoot}
                            className="size-4 shrink-0"
                          />
                          <span className="min-w-0 truncate text-sm">{project.displayName}</span>
                          <button
                            type="button"
                            aria-label={`Project actions for ${project.displayName}`}
                            title={`Project actions for ${project.displayName}`}
                            className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              void handleProjectActions(event, project);
                            }}
                          >
                            <EllipsisIcon className="size-3.5" />
                          </button>
                        </MenuRadioItem>
                      );
                    })}
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      setProjectScopeMenuOpen(false);
                      window.setTimeout(openAddProjectCommandPalette, 0);
                    }}
                  >
                    <FolderPlusIcon className="size-4" />
                    <span>Add project</span>
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1 [scrollbar-gutter:stable]">
          <TooltipProvider
            key="sidebar-thread-tooltips-150"
            delay={150}
            closeDelay={0}
            timeout={400}
          >
            <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
              {(() => {
                const renderThreadRow = (thread: EnvironmentThreadShell) => {
                  const threadKey = scopedThreadKey(
                    scopeThreadRef(thread.environmentId, thread.id),
                  );
                  return (
                    <SidebarRow
                      key={threadKey}
                      thread={thread}
                      isActive={routeThreadKey === threadKey}
                      jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
                      currentEnvironmentId={primaryEnvironmentId}
                      environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                      projectCwd={
                        projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                      }
                      projectTitle={
                        projectDisplayNameByKey.get(
                          `${thread.environmentId}:${thread.projectId}`,
                        ) ?? null
                      }
                      nestUnderProjectShelf
                      isDragging={draggingThreadKey === threadKey}
                      providerEntryByInstanceId={providerEntryByInstanceId}
                      onThreadClick={handleThreadClick}
                      onThreadActivate={navigateToThread}
                      onStartRename={startThreadRename}
                      onRenameTitleChange={setRenamingTitle}
                      onCommitRename={commitThreadRename}
                      onCancelRename={cancelThreadRename}
                      isRenaming={renamingThreadKey === threadKey}
                      renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                      onContextMenu={handleThreadContextMenu}
                      onArchive={attemptArchive}
                      onDragStart={handleThreadRowDragStart}
                      onDragEnd={handleThreadRowDragEnd}
                    />
                  );
                };
                // Nest sessions under stable project shelves (manual + pin order).
                // Cap at sidebarThreadPreviewCount (default 5) with Show more.
                // Empty unpinned shelves stay hidden until a session drag so the
                // list is not a wall of empty project folders.
                const items: ReactNode[] = [];
                for (const panel of activeProjectPanels) {
                  if (panel.threads.length === 0 && !panel.isPinned && draggingThreadKey == null) {
                    continue;
                  }
                  const isDropTarget =
                    dragOverProjectKey === panel.projectKey &&
                    draggingProjectKey !== panel.projectKey;
                  const dropHighlightClass =
                    isDropTarget && dragOverKind === "thread"
                      ? "rounded-md ring-1 ring-inset ring-sky-500/50 bg-sky-500/10"
                      : isDropTarget
                        ? "rounded-md bg-sidebar-row-hover/80"
                        : null;
                  const isScopedProject = scopedProjectGroup?.projectKey === panel.projectKey;
                  const hasActiveThread = panel.threads.some(
                    (thread) =>
                      thread.id === routeThreadRef?.threadId &&
                      thread.environmentId === routeThreadRef.environmentId,
                  );
                  const hasAttentionThread = panel.threads.some((thread) => {
                    const threadStatus = resolveSidebarStatus(thread);
                    if (
                      threadStatus === "working" ||
                      threadStatus === "approval" ||
                      threadStatus === "input" ||
                      threadStatus === "failed"
                    ) {
                      return true;
                    }
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return hasUnseenCompletion({
                      ...thread,
                      lastVisitedAt: threadLastVisitedAtById[threadKey],
                    });
                  });
                  // Unconfigured shelves stay quiet unless they are scoped or
                  // need attention. Once a user toggles one, honor that choice.
                  const isShelfExpanded = resolveSidebarProjectShelfExpanded({
                    persistedExpanded: projectExpandedById[panel.projectKey],
                    isScoped: isScopedProject,
                    hasActiveThread,
                    hasAttentionThread,
                  });
                  items.push(
                    <li
                      key={`project-header:${panel.projectKey}`}
                      data-thread-selection-safe
                      data-testid="sidebar-project-group-header"
                      data-project-key={panel.projectKey}
                      data-pinned={panel.isPinned ? "true" : "false"}
                      className={cn(
                        "list-none",
                        dropHighlightClass,
                        draggingProjectKey === panel.projectKey && "opacity-60",
                      )}
                      draggable={draggingThreadKey == null}
                      onDragStart={(event) => handleProjectGroupDragStart(event, panel.projectKey)}
                      onDragOver={(event) => handleProjectGroupDragOver(event, panel.projectKey)}
                      onDragLeave={(event) => handleProjectGroupDragLeave(event, panel.projectKey)}
                      onDrop={(event) => handleProjectGroupDrop(event, panel.projectKey)}
                      onDragEnd={handleProjectGroupDragEnd}
                    >
                      <div className="group/project-header mt-3 mb-0.5 flex h-6 w-full items-center gap-1 px-1 text-left first:mt-1">
                        <button
                          type="button"
                          aria-expanded={isShelfExpanded}
                          aria-label={`${isShelfExpanded ? "Collapse" : "Expand"} ${panel.displayName}`}
                          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm px-0.5 text-left outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(event) => {
                            event.stopPropagation();
                            setProjectExpanded(panel.projectKey, !isShelfExpanded);
                          }}
                        >
                          <ChevronRightIcon
                            aria-hidden
                            className={cn(
                              "size-3 shrink-0 text-muted-foreground/55 transition-transform",
                              isShelfExpanded && "rotate-90",
                            )}
                          />
                          <span
                            className={cn(
                              "min-w-0 truncate text-[11px] font-medium tracking-wide",
                              panel.isNoProject
                                ? "text-muted-foreground/70"
                                : "text-sidebar-muted-foreground/85",
                            )}
                            title={panel.displayName}
                          >
                            {panel.displayName}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid="sidebar-project-pin"
                          aria-label={
                            panel.isPinned
                              ? `Unpin ${panel.displayName}`
                              : `Pin ${panel.displayName}`
                          }
                          aria-pressed={panel.isPinned}
                          title={panel.isPinned ? "Unpin project" : "Pin project"}
                          onClick={(event) =>
                            toggleProjectPinned(event, panel.projectKey, panel.isPinned)
                          }
                          className={cn(
                            "inline-flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-row-hover hover:text-foreground",
                            panel.isPinned
                              ? "opacity-100 text-foreground"
                              : "opacity-0 text-muted-foreground/50 group-hover/project-header:opacity-100 focus-visible:opacity-100",
                          )}
                        >
                          <PinIcon className={cn("size-3", panel.isPinned && "fill-current")} />
                        </button>
                        {panel.threads.length > 0 ? (
                          <span className="shrink-0 pe-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/40">
                            {panel.threads.length}
                          </span>
                        ) : null}
                      </div>
                    </li>,
                  );
                  if (!isShelfExpanded) {
                    continue;
                  }
                  if (panel.threads.length === 0) {
                    items.push(
                      <li
                        key={`project-empty:${panel.projectKey}`}
                        className={cn(
                          "list-none",
                          isDropTarget &&
                            dragOverKind === "thread" &&
                            "rounded-md ring-1 ring-inset ring-sky-500/40 bg-sky-500/5",
                        )}
                        data-thread-selection-safe
                        data-testid="sidebar-project-empty-hint"
                        onDragOver={(event) => handleProjectGroupDragOver(event, panel.projectKey)}
                        onDragLeave={(event) =>
                          handleProjectGroupDragLeave(event, panel.projectKey)
                        }
                        onDrop={(event) => handleProjectGroupDrop(event, panel.projectKey)}
                      >
                        {draggingThreadKey != null ? (
                          <div className="mb-0.5 px-5 py-0.5 font-mono text-[10px] text-muted-foreground/40">
                            Drop session here
                          </div>
                        ) : null}
                      </li>,
                    );
                  }
                  for (const thread of panel.visibleThreads) {
                    items.push(renderThreadRow(thread));
                  }
                  if (panel.hasHiddenThreads) {
                    const expanded = expandedProjectKeys.has(panel.projectKey);
                    items.push(
                      <li
                        key={`project-show-more:${panel.projectKey}`}
                        className="list-none"
                        data-thread-selection-safe
                      >
                        <button
                          type="button"
                          data-testid="sidebar-project-show-more"
                          onClick={() => toggleProjectThreadListExpanded(panel.projectKey)}
                          className="mb-0.5 flex h-6 w-full items-center justify-start gap-1.5 rounded-md px-2 ps-5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-foreground"
                        >
                          {expanded ? "Show less" : `Show ${panel.hiddenCount} more`}
                        </button>
                      </li>,
                    );
                  }
                }
                return items;
              })()}
            </ul>
          </TooltipProvider>
          {activeThreads.length === 0 && activeProjectPanels.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <Dialog
        open={projectActionsTarget !== null}
        onOpenChange={(open) => {
          if (!open) setProjectActionsTarget(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-balance">Project settings</DialogTitle>
            <DialogDescription>
              {projectActionsTarget && projectActionsTarget.memberProjects.length > 1
                ? `${projectActionsTarget.displayName} has an entry in each environment. Changes apply only to the entry you choose.`
                : `Manage ${projectActionsTarget?.displayName ?? "this project"} in this environment.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="p-0">
            <div className="divide-y divide-border/60">
              {projectActionsTarget?.memberProjects.map((member) => (
                <section
                  key={member.physicalProjectKey}
                  className="flex min-w-0 flex-col gap-4 px-6 py-5 sm:gap-3 sm:py-4"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <ProjectFavicon
                      environmentId={member.environmentId}
                      cwd={member.workspaceRoot}
                      className="size-5 shrink-0 sm:size-4"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-base text-muted-foreground sm:text-sm">
                        <ServerIcon className="size-4 shrink-0 stroke-muted-foreground" />
                        <p className="min-w-0 truncate">
                          {member.environmentLabel ?? "Current environment"}
                        </p>
                      </div>
                      <p
                        className="truncate font-mono text-base text-muted-foreground/72 sm:text-sm"
                        title={member.workspaceRoot}
                      >
                        {member.workspaceRoot}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 sm:gap-3 sm:pl-7">
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Project name</span>
                      <Input
                        key={`${member.physicalProjectKey}:${member.title}`}
                        size="sm"
                        aria-label={`Project name in ${member.environmentLabel ?? "current environment"}`}
                        defaultValue={member.title}
                        onBlur={(event) => {
                          void renameProjectMember(member, event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5">
                      <span className="font-medium text-foreground">Grouping rule</span>
                      <Select
                        value={
                          projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                            deriveProjectGroupingOverrideKey(member)
                          ] ?? "inherit"
                        }
                        onValueChange={(value) => {
                          if (
                            value === "inherit" ||
                            value === "repository" ||
                            value === "repository_path" ||
                            value === "separate"
                          ) {
                            updateProjectGroupingPreference(member, value);
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-full"
                          aria-label={`Grouping rule for ${member.environmentLabel ?? "current environment"}`}
                        >
                          <SelectValue>
                            {(() => {
                              const selection =
                                projectGroupingSettings.sidebarProjectGroupingOverrides?.[
                                  deriveProjectGroupingOverrideKey(member)
                                ] ?? "inherit";
                              return selection === "inherit"
                                ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                                : PROJECT_GROUPING_MODE_LABELS[selection];
                            })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="start" alignItemWithTrigger={false}>
                          <SelectItem hideIndicator value="inherit">
                            Use global default
                          </SelectItem>
                          <SelectItem hideIndicator value="repository">
                            {PROJECT_GROUPING_MODE_LABELS.repository}
                          </SelectItem>
                          <SelectItem hideIndicator value="repository_path">
                            {PROJECT_GROUPING_MODE_LABELS.repository_path}
                          </SelectItem>
                          <SelectItem hideIndicator value="separate">
                            {PROJECT_GROUPING_MODE_LABELS.separate}
                          </SelectItem>
                        </SelectPopup>
                      </Select>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:pl-7">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        copyProjectPath(member.workspaceRoot, { path: member.workspaceRoot })
                      }
                    >
                      <CopyIcon />
                      Copy path
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive-foreground hover:bg-destructive/8 hover:text-destructive-foreground sm:ml-auto"
                      onClick={() => {
                        const projectGroup = projectActionsTarget;
                        if (!projectGroup) return;
                        setProjectActionsTarget(null);
                        void handleRemoveProjectMembers(projectGroup, [member]);
                      }}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>
                </section>
              ))}
            </div>
            {projectActionsTarget && projectActionsTarget.memberProjects.length > 1 ? (
              <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/32 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground sm:text-sm">
                    Remove this project everywhere
                  </p>
                  <p className="text-base text-pretty text-muted-foreground sm:text-sm">
                    Deletes all grouped entries and their conversation history.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  className="shrink-0"
                  onClick={() => {
                    const projectGroup = projectActionsTarget;
                    setProjectActionsTarget(null);
                    void handleRemoveProjectMembers(projectGroup, projectGroup.memberProjects);
                  }}
                >
                  <Trash2Icon />
                  Remove all entries
                </Button>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button onClick={() => setProjectActionsTarget(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <SidebarChromeFooter />
    </>
  );
}
