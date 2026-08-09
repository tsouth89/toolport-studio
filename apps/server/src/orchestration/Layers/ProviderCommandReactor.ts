import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@toolport-studio/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@toolport-studio/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { buildProviderHandoff } from "@toolport-studio/shared/providerHandoff";
import {
  resolveProviderSessionContinuity,
  shouldCarryResumeCursor,
  shouldSendConversationHistory,
  type ProviderSessionContinuity,
} from "../providerSwitch.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
} from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS,
  OrchestrationEventStore,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { makeDurableSideEffectReactor } from "../DurableSideEffectReactor.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderSessionNotFoundError = Schema.is(ProviderSessionNotFoundError);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

/**
 * Provider intents run in two serial lanes per thread rather than one.
 *
 * Turn execution holds its lane for the *entire* provider turn: `sendTurn`
 * blocks until the whole prompt settles and deliberately carries no timeout
 * (see `DEFAULT_PROVIDER_TURN_OPERATION_TIMEOUT`). With a single lane per
 * thread every control intent queued behind that, which meant Stop could not
 * be dequeued until the turn it was trying to stop had already finished on
 * its own — a Stop that only works once stopping is pointless (SOU-569,
 * observed as an agent editing files for 2m37s after the user pressed Stop).
 * The same lane also carried approval responses, so in approval-required mode
 * a mid-turn approval would queue behind the turn that was blocked waiting
 * for it.
 *
 * Control intents keep sharing one lane *with each other* per thread, so two
 * Stops, or a Stop and an approval response, still apply in request order.
 *
 * `thread.runtime-mode-set` stays on the turn lane on purpose: it can restart
 * the provider session, which must not race a turn that is mid-flight.
 */
const providerCommandLaneKey = (event: ProviderIntentEvent): string =>
  event.type === "thread.turn-start-requested" || event.type === "thread.runtime-mode-set"
    ? `turn:${event.payload.threadId}`
    : `control:${event.payload.threadId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
/**
 * Bounds session ensure / startSession / request build only.
 * Must stay relatively short so a wedged spawn fails closed.
 */
const DEFAULT_PROVIDER_SESSION_OPERATION_TIMEOUT = Duration.minutes(2);
/**
 * Bounds the full `sendTurn` wait. ACP providers (Grok, Cursor) block
 * `sendTurn` until the *entire* prompt settles, not until the turn merely
 * starts. A short wall-clock here false-kills live multi-minute work with
 * "Provider turn start timed out before the provider responded." while the
 * agent is still streaming (SOU-399 / dogfood). Adapters own silence
 * watchdogs and user Stop; this is only an absolute hang ceiling.
 * `null` = no reactor-level timeout on sendTurn.
 */
const DEFAULT_PROVIDER_TURN_OPERATION_TIMEOUT: Duration.Duration | null = null;
const DEFAULT_PROVIDER_CONTROL_OPERATION_TIMEOUT = Duration.seconds(30);
const DEFAULT_PROVIDER_COMMAND_LANE_IDLE_TIME_TO_LIVE = Duration.seconds(30);

export interface ProviderCommandReactorOptions {
  readonly sessionOperationTimeout?: Duration.Input;
  /**
   * Timeout for providerService.sendTurn. Prefer unset/null so long Grok/Cursor
   * turns are not false-killed. Tests may set a short duration to prove wedge
   * recovery.
   */
  readonly turnOperationTimeout?: Duration.Input | null;
  readonly controlOperationTimeout?: Duration.Input;
  readonly laneIdleTimeToLive?: Duration.Input;
}

export const ProviderCommandReactorConfig = Context.Reference<ProviderCommandReactorOptions>(
  "t3/orchestration/Layers/ProviderCommandReactorConfig",
  {
    defaultValue: () => ({}),
  },
);

/** First user message in the thread. Establishes what is being attempted. */
function firstUserMessageText(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  return (
    messages.find((entry) => entry.role === "user" && entry.text.trim().length > 0)?.text ?? null
  );
}

/** Most recent user message, used only when the turn itself carries no text. */
function lastUserMessageText(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry && entry.role === "user" && entry.text.trim().length > 0) {
      return entry.text;
    }
  }
  return null;
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<unknown>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<unknown>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const options = yield* ProviderCommandReactorConfig;
  const eventStore = yield* OrchestrationEventStore;
  const sessionOperationTimeout =
    options.sessionOperationTimeout ?? DEFAULT_PROVIDER_SESSION_OPERATION_TIMEOUT;
  // Explicit null disables the sendTurn wall-clock. Undefined falls back to
  // product default (also null). Tests pass a short Duration to simulate wedges.
  const turnOperationTimeout =
    options.turnOperationTimeout === undefined
      ? DEFAULT_PROVIDER_TURN_OPERATION_TIMEOUT
      : options.turnOperationTimeout;
  const controlOperationTimeout =
    options.controlOperationTimeout ?? DEFAULT_PROVIDER_CONTROL_OPERATION_TIMEOUT;
  const laneIdleTimeToLive =
    options.laneIdleTimeToLive ?? DEFAULT_PROVIDER_COMMAND_LANE_IDLE_TIME_TO_LIVE;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const withProviderOperationTimeout = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    input: {
      readonly duration: Duration.Input;
      readonly provider: string;
      readonly method: string;
      readonly operation: string;
    },
  ): Effect.Effect<A, E | ProviderAdapterRequestError, R> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.duration,
        orElse: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: input.provider,
              method: input.method,
              detail: `${input.operation} timed out before the provider responded.`,
            }),
          ),
      }),
    );
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  /**
   * Whether a Stop for this thread was appended after this turn start.
   *
   * Turn execution and control intents run on separate lanes, so by the time a
   * queued turn start dispatches the user may already have pressed Stop. Two
   * shapes of that, both real:
   *
   *   1. The turn start waited behind an earlier turn while Stop ran.
   *   2. The turn lane was idle, so the turn start and the Stop were dequeued
   *      concurrently and the turn start won the race to check.
   *
   * Reading the event log answers both, because the Stop event is durable the
   * moment it is appended — well before either lane processes it. An
   * in-memory watermark could not close (2) at all, and would additionally
   * have made correctness depend on cache TTL and capacity: `sendTurn` has no
   * maximum duration, so a queued turn start can outlive any expiry, and a
   * busy host can evict the entry outright. Neither is an acceptable boundary
   * for "did the user stop this".
   *
   * Only Stops strictly after this turn start count. Anything the user sends
   * *after* pressing Stop gets a higher sequence and still runs.
   */
  const wasStoppedAfterRequest = (threadId: ThreadId, sequence: number) =>
    eventStore.hasLaterStreamStop({ streamId: String(threadId), afterSequence: sequence }).pipe(
      // A read failure must not strand the user's turn. Log and dispatch:
      // the control lane still interrupts whatever this starts.
      Effect.catchCause((cause) =>
        Effect.logWarning("could not check for a later stop before dispatching a turn", {
          threadId,
          sequence,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  /**
   * Threads whose session was just restarted onto a different driver, waiting
   * for the turn that follows to carry the handoff. Set by ensureSessionForThread
   * and consumed once by the next buildSendTurnRequestForThread, so a handoff is
   * described to the incoming provider exactly once rather than on every turn.
   */
  const pendingProviderHandoffs = new Map<string, { readonly fromDriverKind: string }>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendStaleTurnReconciledActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-stale-turn-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "info",
            kind: "provider.turn.interrupt.reconciled",
            summary: "Cleared stale turn",
            payload: {
              detail: "The provider process was no longer bound to this thread.",
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  /**
   * Record a provider handoff in the transcript.
   *
   * Without this the thread simply changes voice partway through with nothing
   * to explain it, which is baffling on a re-read and leaves the user with
   * nothing to point at when answer quality shifts. It also makes the feature
   * debuggable: the switch is visible rather than inferred.
   */
  const appendProviderHandoffActivity = (input: {
    readonly threadId: ThreadId;
    readonly fromDriverKind: string;
    readonly toDriverKind: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-handoff-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "info",
            kind: "provider.handoff",
            summary: `Switched provider from ${providerErrorLabel(input.fromDriverKind)} to ${providerErrorLabel(input.toDriverKind)}`,
            payload: {
              fromDriverKind: input.fromDriverKind,
              toDriverKind: input.toDriverKind,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly expectedSession?: {
      readonly activeTurnId: TurnId | null;
      readonly updatedAt: string;
    };
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          expectedSession: input.expectedSession,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionIfCurrent = (input: Parameters<typeof setThreadSession>[0]) =>
    setThreadSession(input).pipe(
      Effect.as(true),
      Effect.catchIf(isOrchestrationCommandInvariantError, (error) =>
        Effect.logDebug("skipped stale conditional session update", {
          threadId: input.threadId,
          detail: error.detail,
        }).pipe(Effect.as(false)),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  /**
   * Surface a Stop/interrupt failure without lying about lifecycle.
   * Keep status + activeTurnId so the UI still shows Stop / Working while the
   * provider turn is actually still running (SOU-376 / t3code#4524).
   */
  const setThreadSessionLastErrorPreservingLifecycle = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: session.threadId,
        status: session.status,
        providerName: session.providerName,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session.runtimeMode,
        activeTurnId: session.activeTurnId,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const reportTurnInterruptFailure = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly detail: string;
  }) =>
    setThreadSessionLastErrorPreservingLifecycle({
      threadId: input.threadId,
      detail: input.detail,
      createdAt: input.createdAt,
    }).pipe(
      Effect.flatMap(() =>
        appendProviderFailureActivity({
          threadId: input.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail: input.detail,
          turnId: input.turnId,
          createdAt: input.createdAt,
        }),
      ),
      Effect.asVoid,
    );

  // A projectless thread has no workspace to look up; its cwd comes from the
  // projectless scratch directory instead.
  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId | null) {
    if (projectId === null) {
      return undefined;
    }
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      // A driver change is a handoff, not an error (SOU-480). The old rejection
      // treated provider-private resume state as if it made the switch itself
      // impossible; it only makes *resuming* impossible. The session restart
      // below starts clean and the turn carries a handoff envelope instead.
      if (
        currentInfo.driverKind === desiredInfo.driverKind &&
        currentInfo.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const continuity = resolveProviderSessionContinuity({
        currentDriverKind: currentInfo.driverKind,
        desiredDriverKind: desiredInfo.driverKind,
      });
      // A resume cursor is provider-private, so it never survives a handoff.
      // Carrying one across drivers either fails outright or silently resumes
      // the wrong conversation.
      const resumeCursor =
        shouldRestartForModelChange || !shouldCarryResumeCursor(continuity)
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      if (continuity.kind === "handoff") {
        pendingProviderHandoffs.set(threadId, { fromDriverKind: continuity.fromDriverKind });
        yield* appendProviderHandoffActivity({
          threadId,
          fromDriverKind: continuity.fromDriverKind,
          toDriverKind: continuity.toDriverKind,
          turnId: null,
          createdAt,
        }).pipe(
          // Best effort. A missing transcript marker must never fail the turn
          // the user actually asked for.
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to record provider handoff activity", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly messageId?: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    // Prior projected messages + tool summaries for cold-start rehydration when
    // native resume fails (app update/restart). Exclude the message being sent.
    const conversationHistory = thread.messages.flatMap((entry) => {
      if (input.messageId !== undefined && entry.id === input.messageId) {
        return [];
      }
      if (entry.role !== "user" && entry.role !== "assistant") {
        return [];
      }
      const text = entry.text.trim();
      if (text.length === 0) {
        return [];
      }
      return [{ role: entry.role as "user" | "assistant", text }];
    });
    const recentToolSummaries = thread.activities
      .filter((activity) => {
        const kind = activity.kind.toLowerCase();
        return (
          activity.tone === "tool" ||
          kind.startsWith("tool.") ||
          kind.includes("command") ||
          kind.includes("mcp")
        );
      })
      .map((activity) => activity.summary.trim())
      .filter((summary) => summary.length > 0)
      .slice(-20);

    // Consumed once: the incoming provider is told where the work stands on its
    // first turn, not on every subsequent one.
    const handoff = pendingProviderHandoffs.get(input.threadId);
    pendingProviderHandoffs.delete(input.threadId);
    const continuity: ProviderSessionContinuity =
      handoff === undefined
        ? { kind: "continue" }
        : {
            kind: "handoff",
            fromDriverKind: handoff.fromDriverKind,
            toDriverKind: String(activeSession?.provider ?? ""),
          };

    const handoffEnvelope =
      handoff === undefined
        ? null
        : buildProviderHandoff({
            previousProviderLabel: providerErrorLabel(handoff.fromDriverKind),
            firstUserMessage: firstUserMessageText(thread.messages),
            lastUserMessage: normalizedInput ?? lastUserMessageText(thread.messages),
            ...(activeSession?.cwd ? { cwd: activeSession.cwd } : {}),
            // The tail of the conversation, so the incoming provider knows what
            // was answered and not only what was asked. conversationHistory is
            // already user/assistant text with tool payloads stripped, which is
            // exactly the shape wanted here; the envelope caps it.
            recentExchange: conversationHistory,
          });

    // The user's own message goes last so it reads as the current instruction
    // rather than an afterthought appended to a wall of context.
    const inputWithHandoff =
      handoffEnvelope === null
        ? normalizedInput
        : normalizedInput
          ? `${handoffEnvelope}\n\n---\n\n${normalizedInput}`
          : handoffEnvelope;

    return {
      threadId: input.threadId,
      ...(inputWithHandoff ? { input: inputWithHandoff } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(conversationHistory.length > 0 && shouldSendConversationHistory(continuity)
        ? { conversationHistory }
        : {}),
      ...(recentToolSummaries.length > 0 && shouldSendConversationHistory(continuity)
        ? { recentToolSummaries }
        : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({
        cwd,
        oldBranch,
        newBranch: targetBranch,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // A Stop can now land while this turn start is still queued behind an
    // earlier turn on this lane. Starting it would open a new turn moments
    // after the user asked the thread to stop, so drop it instead. Runs before
    // session ensure and title/branch generation so a dropped turn costs
    // nothing.
    if (yield* wasStoppedAfterRequest(event.payload.threadId, event.sequence)) {
      yield* Effect.logDebug("dropping turn start superseded by a later stop", {
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        sequence: event.sequence,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* withProviderOperationTimeout(
      buildSendTurnRequestForThread({
        threadId: event.payload.threadId,
        messageText: message.text,
        messageId: String(message.id),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        createdAt: event.payload.createdAt,
      }),
      {
        duration: sessionOperationTimeout,
        provider: providerErrorLabelFromInstanceHint({
          instanceId: event.payload.modelSelection?.instanceId,
          modelSelectionInstanceId: thread.modelSelection.instanceId,
          sessionProvider: thread.session?.providerName ?? undefined,
        }),
        method: "thread.start",
        operation: "Provider session start",
      },
    ).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    // Re-check immediately before dispatch, not only on entry.
    //
    // Everything between the two checks can take real time — ensuring a
    // session spawns a provider child, and the handoff path restarts one. A
    // Stop pressed during that window was appended after the first check read
    // the log, so only this second read sees it. Without it the user watches
    // Stop do nothing while a turn they cancelled seconds ago starts up.
    if (yield* wasStoppedAfterRequest(event.payload.threadId, event.sequence)) {
      yield* Effect.logDebug("dropping turn start superseded by a stop during preparation", {
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        sequence: event.sequence,
      });
      return;
    }

    // Do not reuse sessionOperationTimeout here. Grok/Cursor sendTurn blocks
    // until the prompt finishes; a 2m "start" timeout interrupts live turns.
    const sendTurnEffect = providerService.sendTurn(sendTurnRequest.value);
    const providerLabel = providerErrorLabelFromInstanceHint({
      instanceId: event.payload.modelSelection?.instanceId,
      modelSelectionInstanceId: thread.modelSelection.instanceId,
      sessionProvider: thread.session?.providerName ?? undefined,
    });
    // Forked, so the turn lane is released once the turn is *dispatched*
    // rather than held until it settles.
    //
    // ACP `sendTurn` blocks for the whole prompt. Awaiting it here meant the
    // thread's turn lane was occupied for minutes, and a mid-turn message —
    // which arrives as another `thread.turn-start-requested` — could not be
    // dequeued until the turn it was meant to steer had already finished.
    // That is why steering "did nothing until the turn ended" on Cursor
    // (SOU-561) and looked dropped entirely on Grok (SOU-562). The adapters
    // already implement steering correctly (`promptConcurrent` /
    // `preemptActivePrompt`); they were simply never reached in time.
    //
    // Everything the lane actually needs to serialize still happens above and
    // is still awaited: session ensure, the continuity/handoff decision, and
    // request construction. Only the long-running prompt escapes. So two turn
    // starts can no longer both bootstrap a session (SOU-519) — by the time
    // the second is dequeued the first has already bound one — while a second
    // prompt reaching a live session is exactly what a steer is.
    //
    // The delivery is marked complete on dispatch rather than on settle. That
    // is deliberate: a crash mid-turn now drops the turn instead of replaying
    // it, and replaying a prompt whose tools already ran is the worse failure.
    yield* (
      turnOperationTimeout === null
        ? sendTurnEffect
        : withProviderOperationTimeout(sendTurnEffect, {
            duration: turnOperationTimeout,
            provider: providerLabel,
            method: "turn.start",
            operation: "Provider turn",
          })
    ).pipe(Effect.catchCause(recoverTurnStartFailure), Effect.forkScoped);
  });

  /**
   * After a successful provider interrupt, force orchestration session ready.
   * Grok can clear its local session without turn.completed applying — UI then
   * stays "running", Working/sidebar keep showing live, and Stop looks dead.
   */
  const forceSessionReadyAfterSuccessfulInterrupt = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    if (session.status !== "running" && session.status !== "starting") {
      return;
    }
    yield* setThreadSessionIfCurrent({
      threadId: input.threadId,
      session: {
        threadId: session.threadId,
        status: "ready",
        providerName: session.providerName,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: input.createdAt,
      },
      expectedSession: {
        activeTurnId: session.activeTurnId,
        updatedAt: session.updatedAt,
      },
      createdAt: input.createdAt,
    });
  });

  const reconcileMissingProviderSessionAfterInterrupt = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly expectedActiveTurnId: TurnId | null;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session || (session.status !== "running" && session.status !== "starting")) {
      return;
    }
    // Control and turn execution intentionally use separate lanes. A new turn
    // can therefore start while an older Stop is discovering that its runtime
    // is gone; never let that older recovery overwrite newer projected work.
    if (session.activeTurnId !== input.expectedActiveTurnId) {
      return;
    }
    if (Date.parse(session.updatedAt) > Date.parse(input.createdAt)) {
      return;
    }
    const applied = yield* setThreadSessionIfCurrent({
      threadId: input.threadId,
      session: {
        threadId: session.threadId,
        status: "interrupted",
        providerName: session.providerName,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: session.providerInstanceId }
          : {}),
        runtimeMode: session.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: input.createdAt,
      },
      expectedSession: {
        activeTurnId: session.activeTurnId,
        updatedAt: session.updatedAt,
      },
      createdAt: input.createdAt,
    });
    if (!applied) {
      return;
    }
    yield* appendStaleTurnReconciledActivity(input);
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnId = event.payload.turnId ?? null;
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      // No live session: activity only (nothing to preserve on session state).
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId,
        createdAt: event.payload.createdAt,
      });
    }
    const expectedActiveTurnId = thread.session.activeTurnId;

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    // Provider rejections must not be swallowed by processDomainEventSafely —
    // Stop would look successful while the turn keeps running (SOU-376).
    yield* withProviderOperationTimeout(
      providerService.interruptTurn({ threadId: event.payload.threadId }),
      {
        duration: controlOperationTimeout,
        provider: providerErrorLabel(thread.session?.providerName ?? undefined),
        method: "turn.interrupt",
        operation: "Provider turn interrupt",
      },
    ).pipe(
      Effect.tap(() =>
        forceSessionReadyAfterSuccessfulInterrupt({
          threadId: event.payload.threadId,
          createdAt: event.payload.createdAt,
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const failure = cause.reasons.find(Cause.isFailReason)?.error;
        if (
          isProviderSessionNotFoundError(failure) ||
          isProviderAdapterSessionNotFoundError(failure) ||
          isProviderAdapterSessionClosedError(failure)
        ) {
          // There is nothing left to interrupt. This is positive evidence that
          // the projected running turn is stale, so clear it rather than
          // preserving an impossible lifecycle behind an error banner.
          return reconcileMissingProviderSessionAfterInterrupt({
            threadId: event.payload.threadId,
            turnId,
            expectedActiveTurnId,
            createdAt: event.payload.createdAt,
          });
        }
        const failureDetail = formatFailureDetail(cause);
        // Prefix so the thread banner is unambiguous: dispatch accepted, stop did not.
        const detail =
          failureDetail.length > 0
            ? `Stop failed: ${failureDetail}`
            : "Stop failed: the provider rejected the interrupt request.";
        return reportTurnInterruptFailure({
          threadId: event.payload.threadId,
          turnId,
          createdAt: event.payload.createdAt,
          detail,
        }).pipe(
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning("provider command reactor failed to recover turn interrupt failure", {
              eventType: event.type,
              threadId: event.payload.threadId,
              cause: Cause.pretty(recoveryCause),
              originalCause: Cause.pretty(cause),
            }),
          ),
        );
      }),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* withProviderOperationTimeout(
      providerService.respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      }),
      {
        duration: controlOperationTimeout,
        provider: providerErrorLabel(thread.session?.providerName ?? undefined),
        method: "approval.respond",
        operation: "Provider approval response",
      },
    ).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.approval.respond.failed",
          summary: "Provider approval response failed",
          detail: isUnknownPendingApprovalRequestError(cause)
            ? stalePendingRequestDetail("approval", event.payload.requestId)
            : Cause.pretty(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        }),
      ),
    );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* withProviderOperationTimeout(
        providerService.respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        }),
        {
          duration: controlOperationTimeout,
          provider: providerErrorLabel(thread.session?.providerName ?? undefined),
          method: "user-input.respond",
          operation: "Provider user-input response",
        },
      ).pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: isUnknownPendingUserInputRequestError(cause)
              ? stalePendingRequestDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      const stopped = yield* withProviderOperationTimeout(
        providerService.stopSession({ threadId: thread.id }),
        {
          duration: controlOperationTimeout,
          provider: providerErrorLabel(thread.session.providerName ?? undefined),
          method: "session.stop",
          operation: "Provider session stop",
        },
      ).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return appendProviderFailureActivity({
            threadId: thread.id,
            kind: "provider.session.stop.failed",
            summary: "Provider session stop failed",
            detail: formatFailureDetail(cause),
            turnId: null,
            createdAt: now,
          }).pipe(Effect.as(false));
        }),
      );
      if (!stopped) {
        return;
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        // Stays on the turn lane because it can restart the provider session,
        // which must not race a live turn — but that means it is no longer
        // ordered against Stop, which now rides the control lane. Applying a
        // mode change after the user stopped the thread can restart the very
        // session they just killed, so honour a later Stop the same way a turn
        // start does.
        if (yield* wasStoppedAfterRequest(event.payload.threadId, event.sequence)) {
          yield* Effect.logDebug("skipping runtime-mode-set superseded by a later stop", {
            threadId: event.payload.threadId,
            sequence: event.sequence,
          });
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* withProviderOperationTimeout(
          ensureSessionForThread(
            event.payload.threadId,
            event.occurredAt,
            cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
          ),
          {
            duration: sessionOperationTimeout,
            provider: providerErrorLabel(thread.session.providerName ?? undefined),
            method: "session.restart",
            operation: "Provider session restart",
          },
        ).pipe(
          Effect.catchCause((cause) =>
            setThreadSessionLastErrorPreservingLifecycle({
              threadId: event.payload.threadId,
              detail: formatFailureDetail(cause),
              createdAt: event.occurredAt,
            }).pipe(
              Effect.andThen(
                Effect.logWarning("provider runtime-mode session update failed", {
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const isProviderIntentEvent = (event: OrchestrationEvent): event is ProviderIntentEvent =>
    event.type === "thread.runtime-mode-set" ||
    event.type === "thread.turn-start-requested" ||
    event.type === "thread.turn-interrupt-requested" ||
    event.type === "thread.approval-response-requested" ||
    event.type === "thread.user-input-response-requested" ||
    event.type === "thread.session-stop-requested";

  const surfaceDurableProviderFailure = (
    event: ProviderIntentEvent,
    cause: Cause.Cause<unknown>,
  ) => {
    const detail = formatFailureDetail(cause);
    const surfaceFailure =
      event.type === "thread.runtime-mode-set"
        ? setThreadSessionLastErrorPreservingLifecycle({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.occurredAt,
          })
        : appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind:
              event.type === "thread.turn-start-requested"
                ? "provider.turn.start.failed"
                : event.type === "thread.turn-interrupt-requested"
                  ? "provider.turn.interrupt.failed"
                  : event.type === "thread.approval-response-requested"
                    ? "provider.approval.respond.failed"
                    : event.type === "thread.user-input-response-requested"
                      ? "provider.user-input.respond.failed"
                      : "provider.session.stop.failed",
            summary:
              event.type === "thread.turn-start-requested"
                ? "Provider turn start failed"
                : event.type === "thread.turn-interrupt-requested"
                  ? "Provider turn interrupt failed"
                  : event.type === "thread.approval-response-requested"
                    ? "Provider approval response failed"
                    : event.type === "thread.user-input-response-requested"
                      ? "Provider user input response failed"
                      : "Provider session stop failed",
            detail,
            turnId:
              event.type === "thread.turn-interrupt-requested"
                ? (event.payload.turnId ?? null)
                : null,
            createdAt: event.payload.createdAt,
            ...(event.type === "thread.approval-response-requested" ||
            event.type === "thread.user-input-response-requested"
              ? { requestId: event.payload.requestId }
              : {}),
          }).pipe(Effect.asVoid);

    return surfaceFailure.pipe(
      Effect.catchCause((surfaceCause) =>
        Effect.logWarning("failed to surface durable provider command failure", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(surfaceCause),
          originalCause: detail,
        }),
      ),
    );
  };

  const durableReactor = yield* makeDurableSideEffectReactor({
    consumer: ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand,
    decode: (event) => (isProviderIntentEvent(event) ? event : null),
    key: providerCommandLaneKey,
    keyLabel: String,
    laneIdleTimeToLive,
    process: processDomainEvent,
    onFailure: (event, cause) =>
      surfaceDurableProviderFailure(event, cause).pipe(
        Effect.andThen(
          Effect.logWarning("provider command reactor failed to process durable event", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
  });

  return {
    start: durableReactor.start,
    drain: durableReactor.drain,
    shutdown: durableReactor.shutdown,
  } satisfies ProviderCommandReactorShape;
});

export const makeProviderCommandReactorLayer = (options: ProviderCommandReactorOptions = {}) =>
  Layer.effect(
    ProviderCommandReactor,
    make.pipe(Effect.provideService(ProviderCommandReactorConfig, options)),
  );

export const ProviderCommandReactorLive = makeProviderCommandReactorLayer();
