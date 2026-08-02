import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type OrchestrationQueuedTurn,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@toolport-studio/contracts";
import {
  connectionStatusTitle,
  type EnvironmentConnectionPresentation,
} from "@toolport-studio/client-runtime/connection";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@toolport-studio/client-runtime/environment";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  resolvePromptInjectedEffort,
} from "@toolport-studio/shared/model";
import { CHAT_LIST_ANCHOR_OFFSET } from "@toolport-studio/shared/chatList";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@toolport-studio/shared/projectScripts";
import { resolveLiveStreamActivityAt } from "@toolport-studio/shared/stalledTurn";
import { truncate } from "@toolport-studio/shared/String";
import {
  nextTerminalId,
  resolveTerminalSessionLabel,
} from "@toolport-studio/shared/terminalLabels";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@toolport-studio/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveComposerPhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  isPendingRequestTimeoutWarningMessage,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  getAnchoredTurnMetrics,
  isTimelineEndPositionKnown,
  type TimelineScrollMode,
} from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { isGeneralChatProject } from "../lib/generalChat";
import { buildTemporaryWorktreeBranchName } from "@toolport-studio/shared/git";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { RightPanelTabs } from "./RightPanelTabs";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import { ActivityPanel } from "./ActivityPanel";
import { AgentsPanel } from "./AgentsPanel";
import { agentRunsForTurn, deriveAgentRuns, latestMessageTurnId } from "../agentRuns";
import { shouldShowThisTurnCard, ThisTurnCard } from "./ThisTurnCard";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { deriveThreadActivityViewModel } from "../threadActivityViewModel";
import { openToolportApp } from "../lib/openToolport";
import { ChevronDownIcon, GitBranchIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { cn, randomHex } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendElementContextsToPrompt,
  type ElementContextDraft,
  formatElementContextLabel,
} from "../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../lib/previewAnnotation";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  useProject,
  useProjects,
  useThread,
  useThreadProposedPlans,
  useThreadRefs,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  deriveActiveWorkingToolLabel,
  shouldOfferLastUserMessageRetry,
} from "./chat/MessagesTimeline.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_DURATION_MS,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  resolveThreadError,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildThreadTurnInterruptInput,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasServerAcknowledgedLocalDispatch,
  LOCAL_DISPATCH_STALE_MS,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  getStartedThreadModelChangeBlockReason,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  waitForStartedServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { resolveComposerSubmitIntent } from "../threadTurnQueueStore";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction } from "./ServerUpdateAction";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_QUEUED_TURNS: ReadonlyArray<OrchestrationQueuedTurn> = [];
function useDraftHeroLayoutTransition(isDraftHeroState: boolean) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };
  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;

    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      !prefersReducedMotion &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: DRAFT_HERO_TRANSITION_DURATION_MS,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current !== animation) {
              return;
            }
            animationRef.current = null;
          });
      }
    }

    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [isDraftHeroState]);

  return [attachTransitionGroupRef, attachComposerAnchorRef, captureComposerRect] as const;
}
const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("./DiffPanel"));
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;

  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;

  return true;
}

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
/** Frames to wait for an appended timeline row to get a real position before giving up. */
const TIMELINE_END_SCROLL_MAX_FRAMES = 12;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  // Map of in-flight local dispatches by thread so multi-session Send does not
  // share one busy flag across the active composer.
  const [localDispatchByThreadId, setLocalDispatchByThreadId] = useState<
    ReadonlyMap<string, LocalDispatchSnapshot>
  >(() => new Map());
  const [dispatchClockMs, setDispatchClockMs] = useState(() => Date.now());
  const activeThreadId = input.activeThread?.id ?? null;
  const localDispatch =
    activeThreadId !== null ? (localDispatchByThreadId.get(String(activeThreadId)) ?? null) : null;
  const latestUserMessageId =
    input.activeThread?.messages.findLast((message) => message.role === "user")?.id ?? null;

  const resetLocalDispatch = useCallback(() => {
    if (activeThreadId === null) {
      return;
    }
    const key = String(activeThreadId);
    setLocalDispatchByThreadId((current) => {
      if (!current.has(key)) {
        return current;
      }
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, [activeThreadId]);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        latestUserMessageId,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
        activeThreadId,
        nowMs: dispatchClockMs,
      }),
    [
      activeThreadId,
      dispatchClockMs,
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      latestUserMessageId,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;

  // Drop acknowledged entries so the map does not grow with every send.
  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch || localDispatch === null || activeThreadId === null) {
      return;
    }
    const key = String(activeThreadId);
    setLocalDispatchByThreadId((current) => {
      if (!current.has(key)) {
        return current;
      }
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, [activeThreadId, localDispatch, serverAcknowledgedLocalDispatch]);

  // Re-evaluate stale "Sending" after LOCAL_DISPATCH_STALE_MS so the composer
  // cannot stay on a disabled spinner forever when projection never acks.
  useEffect(() => {
    if (!activeLocalDispatch) {
      return;
    }
    const startedMs = Date.parse(activeLocalDispatch.startedAt);
    if (!Number.isFinite(startedMs)) {
      return;
    }
    const remainingMs = LOCAL_DISPATCH_STALE_MS - (Date.now() - startedMs);
    const timeoutId = window.setTimeout(
      () => {
        setDispatchClockMs(Date.now());
      },
      Math.max(0, remainingMs) + 25,
    );
    return () => window.clearTimeout(timeoutId);
  }, [activeLocalDispatch]);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      const thread = input.activeThread;
      if (!thread) {
        return;
      }
      const key = String(thread.id);
      setDispatchClockMs(Date.now());
      setLocalDispatchByThreadId((current) => {
        const existing = current.get(key) ?? null;
        const active = serverAcknowledgedLocalDispatch ? null : existing;
        const nextSnapshot = active
          ? active.preparingWorktree === preparingWorktree
            ? active
            : { ...active, preparingWorktree }
          : createLocalDispatchSnapshot(thread, options);
        if (existing === nextSnapshot) {
          return current;
        }
        const next = new Map(current);
        next.set(key, nextSnapshot);
        return next;
      });
    },
    [input.activeThread, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
  };
}

/** Same terminal ids (order ignored) — avoids reconcile when only server session ordering differs. */
function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Server knows about fewer sessions than the client, but every server id still exists locally.
 * Typical right after `terminal.open`: known-session list lags; reconciling would drop the new id
 * and later re-add it as a separate group (no split layout).
 */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useThread(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        panelSurfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [panelSurfaces],
  );
  const drawerTerminalSessions = useMemo(
    () =>
      knownTerminalSessions.filter((session) => !panelTerminalIds.has(session.target.terminalId)),
    [knownTerminalSessions, panelTerminalIds],
  );
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);
  const splitTerminalVertical = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    openTerminal,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeSplitTerminalVertical,
    threadId,
    threadRef,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!cwd) {
      return;
    }
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    serverOrderedTerminalIds,
    storeNewTerminal,
    threadId,
    threadRef,
    openTerminal,
  ]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalUiState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalUiState.terminalHeight}
        // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
        terminalIds={terminalUiState.terminalIds}
        activeTerminalId={terminalUiState.activeTerminalId}
        terminalGroups={terminalUiState.terminalGroups}
        activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onSplitTerminalVertical={splitTerminalVertical}
        onNewTerminal={createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
        terminalLabelsById={terminalLabelsById}
        terminalLaunchLocationsById={terminalLaunchLocationsById}
      />
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useThread(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath =
    launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : null),
    [activeSummary?.cwd, launchContext?.cwd, project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      labels.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    }
    return labels;
  }, [knownTerminalSessions, surface.terminalIds]);
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      const terminalWorktreePath =
        launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath;
      const terminalCwd =
        launchContext?.cwd ??
        summary?.cwd ??
        (project
          ? projectScriptCwd({
              project: { cwd: project.workspaceRoot },
              worktreePath: terminalWorktreePath,
            })
          : null);
      if (!terminalCwd || !project) continue;
      locations.set(terminalId, {
        cwd: terminalCwd,
        worktreePath: terminalWorktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      });
    }
    return locations;
  }, [
    knownTerminalSessions,
    launchContext?.cwd,
    launchContext?.worktreePath,
    project,
    surface.terminalIds,
    threadWorktreePath,
  ]);

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
  /**
   * Server error this entry explicitly dismissed. Clearing `message` alone is
   * not enough: the resolver falls back to `session.lastError`, which the server
   * still holds, so the banner would re-render identically and the X would look
   * broken. See resolveThreadError.
   */
  readonly dismissedServerError?: string | null;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function ChatViewContent(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
  } = props;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const queueThreadTurn = useAtomCommand(threadEnvironment.queueTurn, { reportFailure: false });
  const discardQueuedTurns = useAtomCommand(threadEnvironment.discardQueuedTurns, {
    reportFailure: false,
  });
  const flushQueuedTurn = useAtomCommand(threadEnvironment.flushQueuedTurn, {
    reportFailure: false,
  });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useThread(routeThreadRef);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  );
  const settings = useEnvironmentSettings(environmentId);
  // New-thread defaults live in the primary environment's settings.json (the
  // settings UI never writes to remote environments), so read them from the
  // primary server rather than the thread's environment.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const autoOpenPlanSidebar = settings.autoOpenPlanSidebar;
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const composerPreviewAnnotationsRef = useRef<PreviewAnnotationPayload[]>([]);
  const composerReviewCommentsRef = useRef<ReviewCommentContext[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  // Optimistic user rows are keyed by thread so switching chats cannot wipe an
  // in-flight send for the thread you left (and must not show that row on B).
  const [optimisticUserMessagesByThreadId, setOptimisticUserMessagesByThreadId] = useState<
    Readonly<Record<string, ReadonlyArray<ChatMessage>>>
  >({});
  const optimisticUserMessagesByThreadIdRef = useRef(optimisticUserMessagesByThreadId);
  optimisticUserMessagesByThreadIdRef.current = optimisticUserMessagesByThreadId;
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  // Per-thread preparation aborts: Stop / same-thread re-send may cancel prep.
  // Switching chats must never abort another thread's in-flight send.
  const sendPreparationAbortByThreadIdRef = useRef<Map<string, AbortController>>(new Map());
  // Per-thread send lock so thread A's upload cannot block B's Enter.
  const sendInFlightThreadIdsRef = useRef<Set<string>>(new Set());
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(composerOverlayElement.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setComposerOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(composerOverlayElement);
    return () => observer.disconnect();
  }, [composerOverlayElement]);

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs]);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!serverThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [draftId, localDraftErrorsByDraftId, routeThreadKey, serverThread]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, threadId],
  );
  // Promotion is data-driven: the draft route keeps rendering while the
  // server thread (same pre-allocated ref) starts, so live state must not
  // depend on which route is mounted.
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const agentRuns = useMemo(
    () => deriveAgentRuns(activeThread?.activities ?? []),
    [activeThread?.activities],
  );
  const threadError = isServerThread
    ? resolveThreadError({
        local: localServerErrorsByThreadKey[routeThreadKey],
        serverError: serverThread?.session?.lastError ?? null,
      })
    : localDraftError;
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) => session.target.threadId === activeThreadId,
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activeFileSurface =
    activeRightPanelSurface?.kind === "file" ? activeRightPanelSurface : null;
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && isPreviewSupportedInRuntime();
  const rightPanelOpen = rightPanelState.isOpen;
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;

  useEffect(() => {
    if (!activeThreadRef) return;
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(activeThreadRef, Object.keys(activePreviewState.sessions));
  }, [activePreviewState.sessions, activeThreadRef]);

  const planSidebarOpen = activeRightPanelKind === "plan";

  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestSettledMessageTurnId = useMemo(
    () => latestMessageTurnId(activeThread?.messages ?? []),
    [activeThread?.messages],
  );
  const thisTurnAgentRuns = useMemo(
    () =>
      agentRunsForTurn(
        agentRuns,
        activeThread?.session?.activeTurnId ??
          activeLatestTurn?.turnId ??
          latestSettledMessageTurnId,
      ),
    [
      activeLatestTurn?.turnId,
      activeThread?.session?.activeTurnId,
      agentRuns,
      latestSettledMessageTurnId,
    ],
  );
  const sourcePlanThreadRef = useMemo(() => {
    const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
    if (!activeThread || !sourceThreadId || sourceThreadId === activeThread.id) {
      return null;
    }
    return scopeThreadRef(activeThread.environmentId, sourceThreadId);
  }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread]);
  const sourceThreadProposedPlans = useThreadProposedPlans(sourcePlanThreadRef);
  const threadPlanCatalog = useMemo<ThreadPlanCatalogEntry[]>(() => {
    if (!activeThread) {
      return [];
    }
    const entries: ThreadPlanCatalogEntry[] = [
      { id: activeThread.id, proposedPlans: activeThread.proposedPlans },
    ];
    if (sourcePlanThreadRef) {
      entries.push({
        id: sourcePlanThreadRef.threadId,
        proposedPlans: sourceThreadProposedPlans,
      });
    }
    return entries;
  }, [activeThread, sourcePlanThreadRef, sourceThreadProposedPlans]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalUiState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalUiState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeThreadQueueItems = activeThread?.queuedTurns ?? EMPTY_QUEUED_TURNS;
  const activeThreadQueueCount = activeThreadQueueItems.length;
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useProject(activeProjectRef);
  const isProjectless = activeProject ? isGeneralChatProject(activeProject) : false;
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProject?.scripts),
    [activeProject?.scripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const label = environmentById.get(p.environmentId)?.label ?? p.environmentId;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLastVisitedAt,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.updatedAt,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  // Derived here from the thread's own activities rather than the memoised
  // pendingApprovals/pendingUserInputs below, which are defined after this and
  // after lockedProvider's first consumer.
  const lockedProviderActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    hasPendingApproval: derivePendingApprovals(lockedProviderActivities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(lockedProviderActivities).length > 0,
  });
  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const versionMismatchEnvironmentId =
    versionMismatch && activeThread ? activeThread.environmentId : null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (activeEnvironmentUnavailableState) {
      const connection = activeEnvironmentUnavailableState.connection;
      const isReconnecting =
        connection.phase === "connecting" || connection.phase === "reconnecting";
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: connection.phase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(connection)}`,
        description:
          connection.error ??
          "Reconnect this environment before sending messages or running actions.",
        actions: (
          <>
            <Button
              size="xs"
              disabled={isReconnecting}
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                )
              }
            >
              {isReconnecting ? "Reconnecting..." : "Reconnect"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Connections
            </Button>
          </>
        ),
      });
    }
    if (
      showVersionMismatchBanner &&
      versionMismatch &&
      versionMismatchDismissKey &&
      versionMismatchEnvironmentId
    ) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}.{" "}
            {serverUpdateGuidance(versionMismatchSelfUpdate, versionMismatchServerLabel)}
          </>
        ),
        // The desktop-managed guidance is already the description; the action
        // slot would only repeat it.
        actions:
          versionMismatchSelfUpdate === "desktop-managed" ? undefined : (
            <ServerUpdateAction
              environmentId={versionMismatchEnvironmentId}
              serverLabel={versionMismatchServerLabel}
              selfUpdate={versionMismatchSelfUpdate}
              targetVersion={versionMismatch.clientVersion}
            />
          ),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider,
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = deriveComposerPhase(activeThread?.session ?? null, activeLatestTurn ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  // Quiet notice when multi-session auto-cancel clears an unanswered approval form.
  const seenTimeoutWarningActivityIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const activity of threadActivities) {
      if (activity.kind !== "runtime.warning") {
        continue;
      }
      if (seenTimeoutWarningActivityIdsRef.current.has(activity.id)) {
        continue;
      }
      const message =
        activity.payload &&
        typeof activity.payload === "object" &&
        typeof (activity.payload as { message?: unknown }).message === "string"
          ? (activity.payload as { message: string }).message
          : typeof activity.summary === "string"
            ? activity.summary
            : null;
      if (!isPendingRequestTimeoutWarningMessage(message)) {
        continue;
      }
      seenTimeoutWarningActivityIdsRef.current.add(activity.id);
      toastManager.add({
        type: "warning",
        title: "Request timed out",
        description: message ?? "An unanswered permission or question was cancelled automatically.",
      });
    }
  }, [threadActivities]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  // Keep Working true for the whole live lifecycle: local send, session start
  // (connecting), running turn, and an actual in-flight latest turn. phase
  // "connecting" alone used to leave the timeline blank while Grok recycled.
  // Do not use bare !latestTurnSettled: with no latestTurn, isLatestTurnSettled
  // is false and would mark idle empty threads as Working forever.
  const hasUnsettledLiveTurn =
    activeLatestTurn !== null && activeLatestTurn !== undefined && !latestTurnSettled;
  const isWorking =
    phase === "running" ||
    phase === "connecting" ||
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint ||
    hasUnsettledLiveTurn;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  // Track silence while any live work is in flight so the Working row can show
  // quiet/recovery copy during long connecting or silent running windows.
  // Floor against local send / work start so a settled prior turn's old
  // timestamps do not flash a long wait notice on Enter.
  const lastStreamActivityAt =
    isWorking && activeThread
      ? resolveLiveStreamActivityAt({
          threadUpdatedAt: activeThread.updatedAt,
          sessionUpdatedAt: activeThread.session?.updatedAt ?? null,
          latestTurnRequestedAt: activeLatestTurn?.requestedAt ?? null,
          latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
          includeLatestTurnAnchors: !latestTurnSettled,
          localDispatchStartedAt,
          activeWorkStartedAt,
        })
      : null;
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const messages of Object.values(optimisticUserMessagesByThreadIdRef.current)) {
        for (const message of messages) {
          revokeUserMessagePreviewUrls(message);
        }
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const serverAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const message of serverMessages ?? []) {
      for (const attachment of message.attachments ?? []) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverMessages]);
  const serverAttachmentResources = useMemo(
    () =>
      serverAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverAttachmentIds],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentIds, serverAttachmentUrls],
  );
  const displayServerMessages = useMemo<ReadonlyArray<ChatMessage>>(() => {
    if (!serverMessages) return [];
    return serverMessages.map((message) => {
      if (!message.attachments || message.attachments.length === 0) {
        return message;
      }
      return {
        ...message,
        attachments: message.attachments.map((attachment) => {
          const previewUrl = serverAttachmentUrlById.get(attachment.id);
          return previewUrl ? { ...attachment, previewUrl } : attachment;
        }),
      };
    });
  }, [serverAttachmentUrlById, serverMessages]);
  useEffect(() => {
    if (typeof Image === "undefined" || displayServerMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map<string, ChatMessage>(
      displayServerMessages
        .filter((message) => message.role === "user")
        .map((message) => [String(message.id), message] as const),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, displayServerMessages]);
  const timelineMessages = useMemo(() => {
    const messages = displayServerMessages;
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    const optimisticUserMessages =
      activeThreadId !== null
        ? (optimisticUserMessagesByThreadId[String(activeThreadId)] ?? [])
        : [];
    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    activeThreadId,
    attachmentPreviewHandoffByMessageId,
    displayServerMessages,
    optimisticUserMessagesByThreadId,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState =
    isLocalDraftThread && timelineEntries.length === 0 && !isWorking && !draftHeroDockRequested;
  const [
    attachDraftHeroTransitionGroupRef,
    attachDraftHeroComposerAnchorRef,
    captureDraftHeroComposerRect,
  ] = useDraftHeroLayoutTransition(isDraftHeroState);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const activityViewModel = useMemo(() => {
    const unsettledTurnId = !latestTurnSettled ? (activeLatestTurn?.turnId ?? null) : null;
    const workspaceRoot = activeThread?.worktreePath ?? activeProject?.workspaceRoot ?? null;
    return deriveThreadActivityViewModel({
      timelineEntries,
      isWorking,
      activeTurnStartedAt: activeWorkStartedAt,
      unsettledTurnId,
      activeToolLabel: deriveActiveWorkingToolLabel({
        timelineEntries,
        unsettledTurnId,
      }),
      hasPendingApproval: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
      threadError,
      turnDiffSummaries,
      latestTurnId: activeLatestTurn?.turnId ?? null,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? activeLatestTurn?.requestedAt ?? null,
      latestTurnCompletedAt: activeLatestTurn?.completedAt ?? null,
      proposedPlans: activeThread?.proposedPlans ?? [],
      mcpStatus: serverConfig?.mcpStatus ?? null,
      workspaceRoot,
    });
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.requestedAt,
    activeLatestTurn?.startedAt,
    activeLatestTurn?.turnId,
    activeProject?.workspaceRoot,
    activeThread?.proposedPlans,
    activeThread?.worktreePath,
    activeWorkStartedAt,
    isWorking,
    latestTurnSettled,
    pendingApprovals.length,
    pendingUserInputs.length,
    serverConfig?.mcpStatus,
    threadError,
    timelineEntries,
    turnDiffSummaries,
  ]);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const selectedProviderInstanceId =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)
      ?.instanceId ?? null;
  const activeProviderInstanceId =
    selectedProviderInstanceId ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const latestAssistantActivityAt =
    activeThread?.messages.findLast((message) => message.role === "assistant")?.updatedAt ?? null;
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
    latestAssistantActivityAt,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(threadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const showComposerContextStrip = isGitRepo && activeProject !== null;
  const initialDiffPanelGitScope =
    gitStatusQuery.data?.hasWorkingTreeChanges === true ? "unstaged" : "branch";
  const diffPanelGitStatusResolutionKey = gitStatusQuery.data ? "resolved" : "pending";
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  }, [activeThreadRef, diffOpen, isServerThread, onDiffPanelOpen]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        serverThread &&
        targetThreadId === routeThreadRef.threadId &&
        serverThread.environmentId === routeThreadRef.environmentId &&
        serverThread.id === targetThreadId
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [draftId, routeThreadKey, routeThreadRef, serverThread],
  );

  /**
   * Dismiss whatever the banner is currently showing.
   *
   * Clearing the local message is not sufficient on its own — the resolver falls
   * back to `session.lastError`, which the server keeps until the next turn — so
   * record the exact server error being dismissed. A different error later still
   * surfaces.
   */
  const dismissThreadError = useCallback(() => {
    const serverError = serverThread?.session?.lastError ?? null;
    if (serverThread && serverThread.id === routeThreadRef.threadId) {
      setLocalServerErrorsByThreadKey((existing) => ({
        ...existing,
        [routeThreadKey]: {
          message: null,
          at: Date.now(),
          dismissedServerError: serverError,
        },
      }));
      return;
    }
    const localDraftErrorKey = draftId ?? activeThreadIdRef.current;
    if (!localDraftErrorKey) return;
    setLocalDraftErrorsByDraftId((existing) => ({
      ...existing,
      [localDraftErrorKey]: { message: null, at: Date.now() },
    }));
  }, [draftId, routeThreadKey, routeThreadRef, serverThread]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (nextOpen && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      storeEnsureTerminal(activeThreadRef, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    openTerminal,
    panelTerminalIds,
    setTerminalOpen,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (!activeThreadRef || hasReachedSplitLimit || !activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = nextTerminalId(activeKnownTerminalIds);
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadRef, terminalId);
      } else {
        storeSplitTerminal(activeThreadRef, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeKnownTerminalIds,
      activeThreadId,
      activeThreadRef,
      openTerminal,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = nextTerminalId(activeKnownTerminalIds);
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeKnownTerminalIds,
    activeThreadId,
    activeThreadRef,
    openTerminal,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId || !activeThreadRef) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadRef,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal
        ? nextTerminalId(activeKnownTerminalIds)
        : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure" && !isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      activeKnownTerminalIds,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [environmentId, updateProject, upsertKeybinding],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const dismissPlanSidebarForCurrentTurn = useCallback(() => {
    planSidebarDismissedForTurnRef.current =
      activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);
  const togglePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    } else {
      planSidebarDismissedForTurnRef.current = null;
    }
    useRightPanelStore.getState().toggle(activeThreadRef, "plan");
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn, planSidebarOpen]);
  const closePlanSidebar = useCallback(() => {
    if (!activeThreadRef) return;
    setMaximizedRightPanelThreadKey(null);
    useRightPanelStore.getState().close(activeThreadRef);
    dismissPlanSidebarForCurrentTurn();
  }, [activeThreadRef, dismissPlanSidebarForCurrentTurn]);
  const createBrowserSurface = useCallback(() => {
    if (!activeThreadRef) return;
    void addBrowserSurface({ threadRef: activeThreadRef, openPreview });
  }, [activeThreadRef, openPreview]);
  const addDiffSurface = useCallback(() => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    if (planSidebarOpen) {
      dismissPlanSidebarForCurrentTurn();
    }
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  }, [
    activeThreadRef,
    dismissPlanSidebarForCurrentTurn,
    isGitRepo,
    isServerThread,
    onDiffPanelOpen,
    planSidebarOpen,
  ]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeProject, activeThreadRef]);
  const addActivitySurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "activity");
  }, [activeThreadRef]);
  const openAgentsSurface = useCallback(
    (agentRunId?: string) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().openAgents(activeThreadRef, agentRunId);
    },
    [activeThreadRef],
  );
  const addAgentsSurface = useCallback(() => openAgentsSurface(), [openAgentsSurface]);
  const addPlanSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "plan");
  }, [activeThreadRef]);
  const openToolportMcp = useCallback(() => {
    // Prefer installed Toolport app (toolport://); fall back to web catalog.
    void openToolportApp();
  }, []);
  // Codex-style This-turn card: show while work is interesting; hide when
  // docked Activity is open (duplicate) or the user dismisses for this turn key.
  // Prefer the in-flight local send key while busy so dismiss does not stick to
  // the previous turnId and re-open when the new latestTurn arrives.
  const thisTurnCardKey =
    isSendBusy && localDispatchStartedAt != null
      ? `send:${localDispatchStartedAt}`
      : activeLatestTurn?.turnId != null
        ? String(activeLatestTurn.turnId)
        : localDispatchStartedAt != null
          ? `send:${localDispatchStartedAt}`
          : activeThreadKey != null
            ? `thread:${activeThreadKey}`
            : "none";
  const [thisTurnCardDismissedKey, setThisTurnCardDismissedKey] = useState<string | null>(null);
  const [thisTurnCardForcedOpen, setThisTurnCardForcedOpen] = useState(false);
  const [thisTurnExpandRequestId, setThisTurnExpandRequestId] = useState(0);
  useEffect(() => {
    // New turn / send re-enables the card after a prior dismiss.
    setThisTurnCardDismissedKey((previous) =>
      previous !== null && previous !== thisTurnCardKey ? null : previous,
    );
    setThisTurnCardForcedOpen(false);
  }, [thisTurnCardKey]);
  const dockedActivityOpen = rightPanelOpen && activeRightPanelKind === "activity";
  const thisTurnCardVisible =
    !dockedActivityOpen &&
    thisTurnCardDismissedKey !== thisTurnCardKey &&
    (thisTurnCardForcedOpen || shouldShowThisTurnCard(activityViewModel, thisTurnAgentRuns));
  const openThisTurnCard = useCallback(() => {
    setThisTurnCardDismissedKey(null);
    setThisTurnCardForcedOpen(true);
    setThisTurnExpandRequestId((previous) => previous + 1);
  }, []);
  const dismissThisTurnCard = useCallback(() => {
    setThisTurnCardDismissedKey(thisTurnCardKey);
    setThisTurnCardForcedOpen(false);
  }, [thisTurnCardKey]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadRef || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
    },
    [activeProject, activeThreadRef],
  );
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      useRightPanelStore.getState().close(activeThreadRef);
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [activePreviewState.activeTabId, activeThreadRef, createBrowserSurface, previewPanelOpen]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeThreadRef]);
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeKnownTerminalIds,
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    gitCwd,
    openTerminal,
    panelTerminalIds,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId([...activeKnownTerminalIds, ...panelTerminalIds]);
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeKnownTerminalIds,
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      gitCwd,
      openTerminal,
      panelTerminalIds,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      if (surface.kind === "plan") {
        planSidebarDismissedForTurnRef.current = null;
      } else if (planSidebarOpen) {
        dismissPlanSidebarForCurrentTurn();
      }
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadRef, diffOpen, dismissPlanSidebarForCurrentTurn, onDiffPanelOpen, planSidebarOpen],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      if (planSidebarOpen) {
        closePlanSidebar();
      } else {
        closePreviewPanel();
      }
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePlanSidebar, closePreviewPanel, planSidebarOpen, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      if (surfaces.some((surface) => surface.kind === "plan")) {
        dismissPlanSidebarForCurrentTurn();
      }

      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      dismissPlanSidebarForCurrentTurn,
      storeCloseTerminal,
    ],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces([surface]);
      useRightPanelStore.getState().closeSurface(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeOtherSurfaces(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      cleanupRightPanelSurfaces(surfaces);
      useRightPanelStore.getState().closeSurfacesToRight(activeThreadRef, surface.id);
      syncActivePreviewSurface();
    },
    [
      activeThreadRef,
      cleanupRightPanelSurfaces,
      rightPanelState.surfaces,
      syncActivePreviewSurface,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    cleanupRightPanelSurfaces(rightPanelState.surfaces);
    useRightPanelStore.getState().closeAllSurfaces(activeThreadRef);
  }, [activeThreadRef, cleanupRightPanelSurfaces, rightPanelState.surfaces]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const endScrollFrameRef = useRef<number | null>(null);
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    // A queued end-scroll would fight the gesture that just opted out of live-follow.
    if (endScrollFrameRef.current !== null) {
      cancelAnimationFrame(endScrollFrameRef.current);
      endScrollFrameRef.current = null;
    }
  }, []);
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);
  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? legendListRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight],
  );
  // Never hand LegendList a scrollToEnd it cannot resolve: an appended row with no
  // computed position makes it target offset 0, which reads as "thrown to the top of
  // the thread for the whole response". Wait for the position instead, and if it never
  // arrives leave the scroll alone — maintainScrollAtEnd still pins us, and staying
  // put is always better than jumping to the oldest message.
  const cancelPendingTimelineEndScroll = useCallback(() => {
    if (endScrollFrameRef.current !== null) {
      cancelAnimationFrame(endScrollFrameRef.current);
      endScrollFrameRef.current = null;
    }
  }, []);
  const requestTimelineScrollToEnd = useCallback(
    (animated: boolean) => {
      cancelPendingTimelineEndScroll();
      const attempt = (remainingAttempts: number) => {
        const list = legendListRef.current;
        if (!list) {
          return;
        }
        if (isTimelineEndPositionKnown(list.getState())) {
          void list.scrollToEnd?.({ animated });
          return;
        }
        if (remainingAttempts <= 0) {
          return;
        }
        endScrollFrameRef.current = requestAnimationFrame(() => {
          endScrollFrameRef.current = null;
          attempt(remainingAttempts - 1);
        });
      };
      attempt(TIMELINE_END_SCROLL_MAX_FRAMES);
    },
    [cancelPendingTimelineEndScroll],
  );
  useEffect(() => cancelPendingTimelineEndScroll, [cancelPendingTimelineEndScroll]);

  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      requestTimelineScrollToEnd(animated);
    },
    [requestTimelineScrollToEnd],
  );
  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    const frame = requestAnimationFrame(() => {
      const scrollNode = legendListRef.current?.getScrollableNode();
      if (!scrollNode) {
        return;
      }
      // Only intentional scroll gestures leave live-follow. pointerdown used to
      // cancel on any click in the list (including residual hit-testing) and
      // left the next response growth stuck at the top of history.
      const handleManualNavigation = () => {
        cancelTimelineLiveFollowForUserNavigationRef.current();
      };
      scrollNode.addEventListener("wheel", handleManualNavigation, {
        passive: true,
      });
      scrollNode.addEventListener("touchmove", handleManualNavigation, {
        passive: true,
      });
      removeListeners = () => {
        scrollNode.removeEventListener("wheel", handleManualNavigation);
        scrollNode.removeEventListener("touchmove", handleManualNavigation);
      };
    });

    return () => {
      cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [activeThread?.id]);

  const onTimelineAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    if (pendingTimelineAnchorRef.current === messageId) {
      pendingTimelineAnchorRef.current = null;
    }
    activeTimelineAnchorIndexRef.current = anchorIndex;
    if (positionedTimelineAnchorRef.current === messageId) {
      return;
    }
    positionedTimelineAnchorRef.current = messageId;
    settledTimelineAnchorRef.current = null;
    const positionAnchor = (remainingAttempts: number) => {
      requestAnimationFrame(() => {
        if (positionedTimelineAnchorRef.current !== messageId) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          if (remainingAttempts > 0) {
            positionAnchor(remainingAttempts - 1);
          }
          return;
        }
        const scrollNode = list.getScrollableNode();
        let finished = false;
        const finishAnimatedPositioning = () => {
          if (finished) {
            return;
          }
          finished = true;
          window.clearTimeout(fallbackTimer);
          scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
          if (positionedTimelineAnchorRef.current !== messageId) {
            return;
          }
          const scrollOffset = list.getState().scroll;
          void list.scrollToOffset({ offset: scrollOffset, animated: false });
          settledTimelineAnchorRef.current = messageId;
        };
        const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
        scrollNode.addEventListener("scrollend", finishAnimatedPositioning, { once: true });
        void list.scrollToIndex({
          index: anchorIndex,
          animated: true,
          viewPosition: 0,
          viewOffset: CHAT_LIST_ANCHOR_OFFSET,
        });
      });
    };
    requestAnimationFrame(() => positionAnchor(12));
  }, []);
  const onTimelineAnchorSizeChanged = useCallback((messageId: MessageId) => {
    if (settledTimelineAnchorRef.current !== messageId) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
      return;
    }
    const scrollOffset = legendListRef.current?.getState().scroll;
    if (scrollOffset === undefined) {
      return;
    }
    if (pendingAnchorScrollRestoreRef.current === null) {
      pendingAnchorScrollRestoreRef.current = {
        messageId,
        offset: scrollOffset,
        userScrollGeneration: anchorUserScrollGenerationRef.current,
      };
    }
    if (anchorScrollRestoreFrameRef.current !== null) {
      return;
    }
    anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorScrollRestoreFrameRef.current = null;
      const pending = pendingAnchorScrollRestoreRef.current;
      pendingAnchorScrollRestoreRef.current = null;
      if (
        pending &&
        settledTimelineAnchorRef.current === pending.messageId &&
        pending.userScrollGeneration === anchorUserScrollGenerationRef.current
      ) {
        const list = legendListRef.current;
        const currentScrollOffset = list?.getState().scroll;
        if (
          typeof currentScrollOffset === "number" &&
          Math.abs(currentScrollOffset - pending.offset) <= 2
        ) {
          void list?.scrollToOffset({ offset: pending.offset, animated: false });
        }
      }
    });
  }, []);

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) {
          return;
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = legendListRef.current;
        if (!list) {
          return;
        }

        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const metrics = getActiveTimelineTurnMetrics(list);
          if (!metrics) {
            return;
          }
          if (metrics.scrollDeltaToRevealEnd <= 1) {
            return;
          }

          const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
          void list.scrollToOffset({ offset: nextOffset, animated: false });
          return;
        }

        if (timelineScrollModeRef.current !== "following-end") {
          return;
        }
        // Pin to end while following, but only once the appended row has a real
        // position — see requestTimelineScrollToEnd.
        requestTimelineScrollToEnd(false);
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [activeThread?.id, timelineEntries, getActiveTimelineTurnMetrics, requestTimelineScrollToEnd]);

  useEffect(() => {
    setPullRequestDialogState(null);
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      if (activeThreadRef) {
        useRightPanelStore.getState().open(activeThreadRef, "plan");
      }
    }
    planSidebarDismissedForTurnRef.current = null;
    // activeThreadRef resets transitively with the active thread.
  }, [activeThread?.id]);

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  useEffect(() => {
    if (!autoOpenPlanSidebar) return;
    if (!activePlan) return;
    if (planSidebarOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && activePlan.turnId !== latestTurnId) return;
    const turnKey = activePlan.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
    if (planSidebarDismissedForTurnRef.current === turnKey) return;
    if (activeThreadRef) {
      useRightPanelStore.getState().open(activeThreadRef, "plan");
    }
  }, [
    activePlan,
    activeLatestTurn?.turnId,
    activeThreadRef,
    autoOpenPlanSidebar,
    planSidebarOpen,
    sidebarProposedPlan?.turnId,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const threadKey = String(activeThread.id);
    const optimisticUserMessages = optimisticUserMessagesByThreadId[threadKey] ?? [];
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessagesByThreadId((existing) => {
        const current = existing[threadKey] ?? [];
        const nextForThread = current.filter((message) => !serverIds.has(message.id));
        if (nextForThread.length === current.length) {
          return existing;
        }
        if (nextForThread.length === 0) {
          const { [threadKey]: _removed, ...rest } = existing;
          return rest;
        }
        return { ...existing, [threadKey]: nextForThread };
      });
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeThread?.id,
    activeThread?.messages,
    handoffAttachmentPreviews,
    optimisticUserMessagesByThreadId,
  ]);

  useEffect(() => {
    // Navigation is not cancel. Leaving a chat must not abort its in-flight
    // send, interrupt a just-started turn, or wipe that thread's optimistic
    // rows — those are the three ways a successful turn became invisible until
    // full app restart reloaded the server snapshot.
    setExpandedImage(null);
  }, [draftId, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        primaryServerSettings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0 ||
        draft.elementContexts.length > 0 ||
        draft.previewAnnotations.length > 0 ||
        draft.reviewComments.length > 0),
    );
  });
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRef,
    updateThreadMetadata,
  ]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: system banners, then the branch-mismatch notice,
  // and the informational parked-thread banner last — it must never cover another.
  const parkedThreadBannerItem = null;
  const handleRestoreThreadBranch = useCallback(() => {
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [gitStatusQuery.data?.hasWorkingTreeChanges, handleSwitchCheckoutToThread]);
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [...systemComposerBannerItems, ...parkedThreadItems];
    }
    return [
      ...systemComposerBannerItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: "dark:shadow-none",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          closePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalUiState.terminalOpen) return;
        closeTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    activeRightPanelSurface,
    addTerminalSurface,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    closePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    onToggleDiff,
    toggleRightPanel,
    toggleTerminalVisibility,
    composerRef,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const localApi = readLocalApi();
      if (!localApi || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || phase === "connecting" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          turnCount,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
    ],
  );

  // Send now / Enter-to-flush used to fire and forget. When the server rejected
  // the flush (queued turn already drained, thread gone) the queued row just sat
  // there and every click looked like a dead button.
  const flushQueuedTurnForThread = useCallback(
    async (targetThreadId: ThreadId, messageId: MessageId) => {
      const result = await flushQueuedTurn({
        environmentId,
        input: { threadId: targetThreadId, messageId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          targetThreadId,
          error instanceof Error ? error.message : "Failed to send the queued message.",
        );
      }
      return result;
    },
    [environmentId, flushQueuedTurn, setThreadError],
  );

  const onSend = async (
    e?: { preventDefault: () => void },
    options?: {
      readonly intent?: "auto" | "queue" | "steer" | "force";
      readonly ctrlOrMetaKey?: boolean;
    },
  ): Promise<boolean> => {
    e?.preventDefault();
    if (!activeThread || isSendBusy || isConnecting || activeEnvironmentUnavailable) return false;
    const activeSendThreadKey = String(activeThread.id);
    if (sendInFlightThreadIdsRef.current.has(activeSendThreadKey)) return false;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return false;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) return false;
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      elementContexts: composerElementContexts,
      previewAnnotations: composerPreviewAnnotations,
      reviewComments: composerReviewComments,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerElementContexts.length +
        composerPreviewAnnotations.length +
        composerReviewComments.length,
    });
    const submitIntent = resolveComposerSubmitIntent({
      phase,
      ctrlOrMetaKey: options?.ctrlOrMetaKey ?? false,
      ...(options?.intent === undefined ? {} : { explicitIntent: options.intent }),
    });
    // While a turn is live, default Enter queues for after settle. Empty
    // Enter with a non-empty queue flushes the head as send-now (steer if
    // still running). Ctrl/Cmd+Enter or Send injects into the live turn.
    // Stop cancels the live turn; queued messages are kept unless cleared.
    if (phase === "running" && !hasSendableContent && activeThreadQueueCount > 0) {
      const head = activeThreadQueueItems[0];
      if (head) {
        void flushQueuedTurnForThread(activeThread.id, head.message.messageId);
        return true;
      }
    }
    const shouldQueueTurn = submitIntent === "queue" && phase === "running";
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return true;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerElementContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return true;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return false;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return false;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return false;
    }

    sendInFlightThreadIdsRef.current.add(activeSendThreadKey);
    const sendPreparationAbort = new AbortController();
    // Only cancel prep for this same thread (re-send / Stop), never for others.
    sendPreparationAbortByThreadIdRef.current.get(activeSendThreadKey)?.abort();
    sendPreparationAbortByThreadIdRef.current.set(activeSendThreadKey, sendPreparationAbort);
    if (isDraftHeroState && activeThreadKey) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(() => {
        flushSync(() => {
          captureDraftHeroComposerRect();
          setDockedDraftHeroThreadKey(activeThreadKey);
        });
        resolveDockStarted?.();
      });
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }
    if (!shouldQueueTurn) {
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    }

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerElementContextsSnapshot = [...composerElementContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const messageTextWithContexts = appendElementContextsToPrompt(
      appendTerminalContextsToPrompt(promptForSend, composerTerminalContextsSnapshot),
      composerElementContextsSnapshot,
    );
    const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
      (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
      messageTextWithContexts,
    );
    const messageTextForSend = appendReviewCommentsToPrompt(
      messageTextWithPreviewAnnotations,
      composerReviewCommentsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file, {
          signal: sendPreparationAbort.signal,
        }),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    // Stay pinned to the live edge after send (Claude Desktop behavior).
    // Anchoring the user row to the top caused a jump into older history
    // until the first provider token snapped back (SOU-352).
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({
      threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageId: null,
    });
    scrollToEnd(false);
    if (!shouldQueueTurn) {
      setOptimisticUserMessagesByThreadId((existing) => {
        const key = String(threadIdForSend);
        const nextMessage: ChatMessage = {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        };
        return {
          ...existing,
          [key]: [...(existing[key] ?? []), nextMessage],
        };
      });
    }
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerElementContextsSnapshot.length > 0) {
        titleSeed = formatElementContextLabel(composerElementContextsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;
    // Auto-title from first message
    if (isFirstMessage && isServerThread) {
      const titleResult = await updateThreadMetadata({
        environmentId,
        input: {
          threadId: threadIdForSend,
          title,
        },
      });
      if (titleResult._tag === "Failure") {
        failure = titleResult;
      }
    }

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(ctxSelectedModel ? { modelSelection: ctxSelectedModelSelection } : {}),
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(() => turnAttachmentsPromise);
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let turnStartSucceeded = false;
    if (
      failure === null &&
      turnAttachmentsResult._tag === "Success" &&
      !sendPreparationAbort.signal.aborted
    ) {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(randomHex),
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      if (!shouldQueueTurn) {
        beginLocalDispatch({ preparingWorktree: false });
      }
      const turnInput = {
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user" as const,
          text: outgoingMessageText,
          attachments: turnAttachmentsResult.value,
        },
        modelSelection: ctxSelectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        createdAt: messageCreatedAt,
      };
      const startResult = shouldQueueTurn
        ? await queueThreadTurn({
            environmentId,
            input: turnInput,
          })
        : await startThreadTurn({
            environmentId,
            input: {
              ...turnInput,
              ...(bootstrap ? { bootstrap } : {}),
            },
          });
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        // Never interrupt a successful turnStart because preparation was
        // aborted. Prep abort is for cancelling image reads / pre-RPC work;
        // once the server accepted the turn, only explicit Stop may interrupt.
      }
    }

    const preparationWasCancelled = sendPreparationAbort.signal.aborted;
    if (failure !== null || (preparationWasCancelled && !turnStartSucceeded)) {
      const optimisticKey = String(threadIdForSend);
      setOptimisticUserMessagesByThreadId((existing) => {
        const current = existing[optimisticKey] ?? [];
        const removed = current.filter((message) => message.id === messageIdForSend);
        if (removed.length === 0) {
          return existing;
        }
        for (const message of removed) {
          revokeUserMessagePreviewUrls(message);
        }
        const nextForThread = current.filter((message) => message.id !== messageIdForSend);
        if (nextForThread.length === 0) {
          const { [optimisticKey]: _removed, ...rest } = existing;
          return rest;
        }
        return { ...existing, [optimisticKey]: nextForThread };
      });
      // Queue drain failures keep the item queued; do not shove text into the
      // composer (that would block the next drain and look like a draft).
      if (
        activeThreadIdRef.current === threadIdForSend &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerElementContextsRef.current.length === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.previewAnnotations
          .length ?? 0) === 0 &&
        (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
          .length ?? 0) === 0
      ) {
        promptRef.current = promptForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerElementContextsRef.current = composerElementContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftElementContexts(composerDraftTarget, composerElementContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      if (failure !== null && !preparationWasCancelled && !isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        const detail = error instanceof Error ? error.message : "Failed to send message.";
        const imageHint =
          composerImagesSnapshot.length > 0 &&
          (detail.toLowerCase().includes("image") ||
            detail.toLowerCase().includes("read") ||
            detail.toLowerCase().includes("timed out") ||
            detail.toLowerCase().includes("attachment"))
            ? " Image attach failed — re-attach or send without the image."
            : "";
        setThreadError(threadIdForSend, `${detail}${imageHint}`);
      }
    }
    if (
      sendPreparationAbortByThreadIdRef.current.get(activeSendThreadKey) === sendPreparationAbort
    ) {
      sendPreparationAbortByThreadIdRef.current.delete(activeSendThreadKey);
    }
    sendInFlightThreadIdsRef.current.delete(activeSendThreadKey);
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      // Only clear local busy for the thread that failed; never clobber another.
      if (activeThreadIdRef.current === threadIdForSend) {
        resetLocalDispatch();
      }
    }
    return turnStartSucceeded;
  };

  const onInterrupt = async () => {
    if (!activeThread) return;
    // Always clear local "Sending" busy state. Stop must work even when the
    // provider turn never reached phase=running (stuck image read/upload or
    // missing projection ack). Only abort this thread's preparation.
    const interruptThreadKey = String(activeThread.id);
    sendPreparationAbortByThreadIdRef.current.get(interruptThreadKey)?.abort();
    sendPreparationAbortByThreadIdRef.current.delete(interruptThreadKey);
    sendInFlightThreadIdsRef.current.delete(interruptThreadKey);
    resetLocalDispatch();
    // Call the server whenever anything looks live — not only phase=running.
    // Connecting recycle, sticky Working chrome, and unsettled turns all show
    // Stop; gating only on running made Stop a silent no-op (Grok dogfood).
    const sessionStatus = activeThread.session?.status;
    const shouldInterruptServer =
      phase === "running" ||
      phase === "connecting" ||
      isWorking ||
      sessionStatus === "running" ||
      sessionStatus === "starting";
    if (!shouldInterruptServer) {
      return;
    }
    const result = await interruptThreadTurn({
      environmentId,
      input: buildThreadTurnInterruptInput(activeThread),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const lastUserMessageText =
    activeThread?.messages.findLast((message) => message.role === "user")?.text?.trim() ?? "";
  const canRetryLastUserMessage =
    shouldOfferLastUserMessageRetry(threadError) &&
    lastUserMessageText.length > 0 &&
    phase !== "running" &&
    !isSendBusy &&
    !isConnecting &&
    !activeEnvironmentUnavailable;

  const onRetryLastUserMessage = useCallback(() => {
    if (!activeThread || lastUserMessageText.length === 0) {
      return;
    }
    setThreadError(activeThread.id, null);
    clearComposerDraftContent(composerDraftTarget);
    setComposerDraftPrompt(composerDraftTarget, lastUserMessageText);
    promptRef.current = lastUserMessageText;
    composerImagesRef.current = [];
    composerTerminalContextsRef.current = [];
    composerElementContextsRef.current = [];
    composerPreviewAnnotationsRef.current = [];
    composerReviewCommentsRef.current = [];
    composerRef.current?.resetCursorState({
      prompt: lastUserMessageText,
      cursor: lastUserMessageText.length,
      detectTrigger: false,
    });
    void onSendRef.current(undefined, { intent: "force" });
  }, [
    activeThread,
    clearComposerDraftContent,
    composerDraftTarget,
    lastUserMessageText,
    setComposerDraftPrompt,
    setThreadError,
  ]);

  const sendQueuedItemNow = useCallback(
    (messageId: MessageId) => {
      if (!activeThreadId) {
        return;
      }
      void flushQueuedTurnForThread(activeThreadId, messageId);
    },
    [activeThreadId, flushQueuedTurnForThread],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadApproval({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          decision,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadApproval, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      if (!activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToThreadUserInput({
        environmentId,
        input: {
          threadId: activeThreadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit user input.",
        );
      }
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [activeThreadId, environmentId, respondToThreadUserInput, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, composerRef],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, composerRef],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      if (!activeThread || !isServerThread || isSendBusy || isConnecting) {
        return;
      }
      const planFollowUpThreadKey = String(activeThread.id);
      if (sendInFlightThreadIdsRef.current.has(planFollowUpThreadKey)) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx?.providerAvailable) {
        return;
      }
      const {
        selectedProvider: ctxSelectedProvider,
        selectedModel: ctxSelectedModel,
        selectedProviderModels: ctxSelectedProviderModels,
        selectedPromptEffort: ctxSelectedPromptEffort,
        selectedModelSelection: ctxSelectedModelSelection,
      } = sendCtx;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: trimmed,
      });

      sendInFlightThreadIdsRef.current.add(planFollowUpThreadKey);
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Stay pinned to the live edge after send (SOU-352).
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: null,
      });
      scrollToEnd(false);

      setOptimisticUserMessagesByThreadId((existing) => {
        const key = String(threadIdForSend);
        const nextMessage: ChatMessage = {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          turnId: null,
          createdAt: messageCreatedAt,
          updatedAt: messageCreatedAt,
          streaming: false,
        };
        return {
          ...existing,
          [key]: [...(existing[key] ?? []), nextMessage],
        };
      });

      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: ctxSelectedModelSelection,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await startThreadTurn({
          environmentId,
          input: {
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: ctxSelectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: {
                    threadId: activeThread.id,
                    planId: activeProposedPlan.id,
                  },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      if (failure === null) {
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default" && autoOpenPlanSidebar) {
          planSidebarDismissedForTurnRef.current = null;
          if (activeThreadRef) {
            useRightPanelStore.getState().open(activeThreadRef, "plan");
          }
        }
        sendInFlightThreadIdsRef.current.delete(planFollowUpThreadKey);
        return;
      }

      setOptimisticUserMessagesByThreadId((existing) => {
        const key = String(threadIdForSend);
        const current = existing[key] ?? [];
        const nextForThread = current.filter((message) => message.id !== messageIdForSend);
        if (nextForThread.length === current.length) {
          return existing;
        }
        if (nextForThread.length === 0) {
          const { [key]: _removed, ...rest } = existing;
          return rest;
        }
        return { ...existing, [key]: nextForThread };
      });
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
      }
      sendInFlightThreadIdsRef.current.delete(planFollowUpThreadKey);
      resetLocalDispatch();
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      startThreadTurn,
      autoOpenPlanSidebar,
      environmentId,
      composerRef,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable
    ) {
      return;
    }
    const implementPlanThreadKey = String(activeThread.id);
    if (sendInFlightThreadIdsRef.current.has(implementPlanThreadKey)) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightThreadIdsRef.current.add(implementPlanThreadKey);
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightThreadIdsRef.current.delete(implementPlanThreadKey);
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      // Signal that the plan sidebar should open on the new thread when enabled.
      planSidebarOpenOnNextThreadRef.current = autoOpenPlanSidebar;
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    startThreadTurn,
    autoOpenPlanSidebar,
    environmentId,
    composerRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeThread, providerStatuses],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        scheduleComposerFocus();
        return;
      }
      if (lockedProvider !== null && activeThread.session?.providerInstanceId) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeThread.session !== null,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeThread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      primaryServerSettings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread || !activeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(activeThreadRef, turnId, filePath);
      useRightPanelStore.getState().open(activeThreadRef, "diff");
      onDiffPanelOpen?.();
    },
    [activeThreadRef, isServerThread, onDiffPanelOpen],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={activeProject !== null}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      rightPanelAvailable={activeProject !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div className="workspace-titlebar-controls z-50 gap-1 [-webkit-app-region:no-drag]">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    activeRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={activeRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        threadRef={activeThreadRef}
        surface={activeRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : activeRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={`${activeThreadKey}:${diffPanelGitStatusResolutionKey}`}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          initialGitScope={initialDiffPanelGitScope}
        />
      </Suspense>
    ) : activeRightPanelSurface?.kind === "plan" ? (
      <PlanSidebar
        activePlan={activePlan}
        activeProposedPlan={sidebarProposedPlan}
        label={planSidebarLabel}
        environmentId={environmentId}
        threadRef={activeThreadRef}
        markdownCwd={gitCwd ?? undefined}
        workspaceRoot={activeWorkspaceRoot}
        timestampFormat={timestampFormat}
        mode="embedded"
      />
    ) : activeRightPanelSurface?.kind === "activity" ? (
      <ActivityPanel
        model={activityViewModel}
        onOpenTurnDiff={onOpenTurnDiff}
        onOpenPlan={addPlanSurface}
        onViewAllMcp={openToolportMcp}
      />
    ) : activeRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        runs={agentRuns}
        selectedAgentRunId={activeRightPanelSurface.selectedAgentRunId}
        onSelectAgent={openAgentsSurface}
      />
    ) : (activeRightPanelSurface?.kind === "files" || activeRightPanelSurface?.kind === "file") &&
      activeProject &&
      activeWorkspaceRoot ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeProject.environmentId}:${activeWorkspaceRoot}`}
          environmentId={activeProject.environmentId}
          cwd={activeWorkspaceRoot}
          projectName={activeProject.title}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            activeRightPanelSurface.kind === "file" ? activeRightPanelSurface.relativePath : null
          }
          revealLine={activeFileSurface?.revealLine ?? null}
          revealRequestId={activeFileSurface?.revealRequestId ?? 0}
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
        />
      </Suspense>
    ) : null
  ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {rightPanelOpen && !shouldUsePlanSidebarSheet ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar */}
        <header
          data-chat-header
          className={cn(
            // SOU-386 PR4: quiet instrument top bar — shell surface + hairline edge
            "border-b border-border/50 bg-[color-mix(in_srgb,var(--shell-surface,var(--background))_92%,transparent)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
            isElectron
              ? cn(
                  "workspace-topbar drag-region relative px-3 sm:px-5",
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    "wco:pr-[var(--workspace-native-controls-inset)]",
                )
              : "workspace-topbar pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {!rightPanelOpen ? panelLayoutControls : null}
          <ChatHeader
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === "draft" && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            activeProjectName={isProjectless ? undefined : activeProject?.title}
            activeProjectCwd={isProjectless ? null : (activeProject?.workspaceRoot ?? null)}
            isProjectless={isProjectless}
            canAttachProject={
              activeThread.session?.status !== "starting" &&
              activeThread.session?.status !== "running"
            }
            openInCwd={gitCwd}
            activeProjectScripts={isProjectless ? undefined : activeProject?.scripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            rightPanelOpen={rightPanelOpen}
            gitCwd={gitCwd}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onAttachProject={() => openCommandPalette({ open: "attach-project" })}
          />
        </header>

        <ThreadErrorBanner
          error={threadError}
          onDismiss={dismissThreadError}
          {...(canRetryLastUserMessage ? { onRetry: onRetryLastUserMessage } : {})}
        />
        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Provider status overlays the timeline (no layout jump). Live-turn
                chrome lives in the composer (queue strip + stop) — no redundant
                Working bar / second Stop control at the top. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-1.5 px-2 pt-1 sm:px-3">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
              />
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                key={activeThread.id}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnStartedAt={activeWorkStartedAt}
                lastStreamActivityAt={lastStreamActivityAt}
                listRef={legendListRef}
                timelineEntries={timelineEntries}
                latestTurn={activeLatestTurn}
                runningTurnId={
                  activeThread.session?.status === "running" ||
                  activeThread.session?.status === "starting"
                    ? activeThread.session.activeTurnId
                    : null
                }
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                onInterrupt={onInterrupt}
                onOpenActivity={openThisTurnCard}
                onOpenAgents={openAgentsSurface}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                anchorMessageId={timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReady}
                onAnchorSizeChanged={onTimelineAnchorSizeChanged}
                contentInsetEndAdjustment={composerOverlayHeight}
                onIsAtEndChange={onIsAtEndChange}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                hideEmptyPlaceholder={isDraftHeroState}
                topFadeEnabled={!hasTimelineTopBanner}
              />

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: composerOverlayHeight + 4 }}
                >
                  <button
                    type="button"
                    aria-label="Scroll to end"
                    title="Scroll to end"
                    onClick={() => scrollToEnd(true)}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to end
                  </button>
                </div>
              )}

              {/* Codex-style this-turn inspect card (not a docked Activity column). */}
              {thisTurnCardVisible ? (
                <div
                  className="pointer-events-none absolute right-2 z-30 sm:right-3"
                  style={{ top: 8 }}
                >
                  <ThisTurnCard
                    model={activityViewModel}
                    agentRuns={thisTurnAgentRuns}
                    onDismiss={dismissThisTurnCard}
                    onOpenTurnDiff={isServerThread ? onOpenTurnDiff : undefined}
                    onOpenToolport={openToolportMcp}
                    onOpenDockedActivity={addActivitySurface}
                    onOpenAgents={openAgentsSurface}
                    expandRequestId={thisTurnExpandRequestId}
                  />
                </div>
              ) : null}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="chat-composer-horizontal-inset w-full"
              >
                <div className="pointer-events-auto relative z-10">
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                          isProjectless={isProjectless}
                        />
                      </div>
                      <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                    </div>
                  ) : (
                    <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
                  )}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <div
                      className={cn(
                        "chat-composer-glass-shell relative mx-auto w-full max-w-3xl",
                        showComposerContextStrip && "chat-composer-glass-shell-with-context",
                      )}
                    >
                      <div className="chat-composer-glass-host relative z-10 w-full rounded-[18px]">
                        {activeThreadId && activeThreadQueueCount > 0 ? (
                          <div className="space-y-1.5 border-b border-primary/25 bg-primary/8 px-3 py-2 text-xs text-foreground sm:px-4">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">
                                {activeThreadQueueCount === 1
                                  ? "1 message queued"
                                  : `${activeThreadQueueCount} messages queued`}
                                {phase === "running" || phase === "connecting"
                                  ? " · after this turn · Enter again to send now"
                                  : " · sending next"}
                              </span>
                              <button
                                type="button"
                                className="shrink-0 rounded-md px-2 py-0.5 text-foreground/80 hover:bg-muted"
                                onClick={() => {
                                  void discardQueuedTurns({
                                    environmentId,
                                    input: { threadId: activeThreadId },
                                  });
                                }}
                              >
                                Clear queue
                              </button>
                            </div>
                            <ul className="space-y-1">
                              {activeThreadQueueItems.map((item, index) => {
                                const preview =
                                  item.message.text.trim().length > 0
                                    ? item.message.text.trim().slice(0, 72)
                                    : item.message.attachments.length > 0
                                      ? `${item.message.attachments.length} image${item.message.attachments.length === 1 ? "" : "s"}`
                                      : "Empty message";
                                return (
                                  <li
                                    key={item.message.messageId}
                                    className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1 text-[11px] text-foreground/80"
                                  >
                                    <span className="min-w-0 truncate">
                                      {index + 1}. {preview}
                                      {item.message.text.trim().length > 72 ? "…" : ""}
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1">
                                      <button
                                        type="button"
                                        className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-muted"
                                        onClick={() => {
                                          sendQueuedItemNow(item.message.messageId);
                                        }}
                                      >
                                        Send now
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                                        onClick={() => {
                                          void discardQueuedTurns({
                                            environmentId,
                                            input: {
                                              threadId: activeThreadId,
                                              messageId: item.message.messageId,
                                            },
                                          });
                                        }}
                                      >
                                        Remove
                                      </button>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : null}
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            queuedMessageCount={activeThreadQueueCount}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy}
                            isPreparingWorktree={isPreparingWorktree}
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activePlan={activePlan as { turnId?: TurnId } | null}
                            sidebarProposedPlan={sidebarProposedPlan as { turnId?: TurnId } | null}
                            planSidebarLabel={planSidebarLabel}
                            planSidebarOpen={planSidebarOpen}
                            runtimeMode={runtimeMode}
                            interactionMode={interactionMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            activeProjectDefaultModelSelection={
                              activeProject?.defaultModelSelection
                            }
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeThreadActivities={activeThread?.activities}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            terminalOpen={Boolean(terminalUiState.terminalOpen)}
                            gitCwd={gitCwd}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            composerElementContextsRef={composerElementContextsRef}
                            composerPreviewAnnotationsRef={composerPreviewAnnotationsRef}
                            composerReviewCommentsRef={composerReviewCommentsRef}
                            onSend={onSend}
                            onInterrupt={onInterrupt}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            getModelDisabledReason={getModelDisabledReason}
                            toggleInteractionMode={toggleInteractionMode}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            handleInteractionModeChange={handleInteractionModeChange}
                            togglePlanSidebar={togglePlanSidebar}
                            focusComposer={focusComposer}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                          />
                        </div>
                      </div>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {showComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                {...(canOverrideServerThreadEnvMode
                                  ? { effectiveEnvModeOverride: envMode }
                                  : {})}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                availableEnvironments={logicalProjectEnvironments}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            visible={mountedThreadKey === activeThreadKey && terminalUiState.terminalOpen}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ))}
      </div>

      {!shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          maximized={rightPanelMaximized}
          surfaces={rightPanelState.surfaces}
          activeSurfaceId={activeRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddActivity={addActivitySurface}
          onAddAgents={addAgentsSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {shouldUsePlanSidebarSheet && rightPanelOpen && activeThreadRef ? (
        <RightPanelSheet open onClose={planSidebarOpen ? closePlanSidebar : closePreviewPanel}>
          <RightPanelTabs
            mode="sheet"
            layoutControls={panelToggleControls}
            surfaces={rightPanelState.surfaces}
            activeSurfaceId={activeRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddActivity={addActivitySurface}
            onAddAgents={addAgentsSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      {expandedImage && (
        <ExpandedImageDialog
          key={`${expandedImage.images[expandedImage.index]?.src ?? "image"}:${expandedImage.index}`}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  );
}

export default function ChatView(props: ChatViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <ChatViewContent {...props} />
    </DiffWorkerPoolProvider>
  );
}
