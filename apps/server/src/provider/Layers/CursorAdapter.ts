/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */

import {
  ApprovalRequestId,
  type CursorSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeAgentId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@toolport-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  classifyProviderEmittedFailure,
  formatProviderEmittedFailureMessage,
} from "@toolport-studio/shared/providerError";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  isAcpSubagentTaskToolCall,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { canSteerSendTurn, shouldForceCloseOpenToolsOnStop } from "../turnEngine/index.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];

/** Auto-cancel unanswered permission prompts so multi-session dogfood cannot hang forever. */
const CURSOR_PENDING_APPROVAL_TIMEOUT_MS = 3 * 60_000;
/**
 * Cursor ACP can sit with zero session/update traffic (first token, post-tool
 * thinking, or a wedged stream). Surface a warning so Working is not a silent
 * black hole. Open tools suppress the warning: quiet tools are valid work.
 */
const CURSOR_SILENT_PROMPT_WARNING_MS = 20_000;
const CURSOR_SILENCE_POLL_MS = 5_000;
/** Slightly longer for multi-question forms. */
const CURSOR_PENDING_USER_INPUT_TIMEOUT_MS = 5 * 60_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface CursorAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
  /** Override pending permission auto-cancel (default 3 minutes). */
  readonly pendingApprovalTimeoutMs?: number;
  /** Override pending user-input auto-cancel (default 5 minutes). */
  readonly pendingUserInputTimeoutMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  scope: Scope.Closeable;
  acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /**
   * Last turn that owned live ACP stream traffic. Survives force-settle so late
   * session/update chunks after Stop still bind to a turn (otherwise content.delta
   * arrives with no turnId and the UI looks empty while the agent was talking).
   */
  lastNotificationTurnId: TurnId | undefined;
  /** Wall-clock ms of last visible stream activity (text/tools/plan/thought). */
  lastVisibleActivityAtMs: number;
  /** Turn id we already warned about for silent prompt (one warning per turn). */
  silentPromptWarningTurnId: string | undefined;
  /**
   * Concatenated assistant_text for the live turn. Used to classify pure
   * provider-emitted failures (e.g. Cursor resource_exhausted dumps) that
   * arrive as agent_message_chunk + end_turn instead of a failed prompt RPC.
   */
  turnAssistantText: string;
  /**
   * How many visible events the live turn projected off the notification
   * stream: reasoning and assistant deltas, tool calls, plans, and the
   * assistant segment lifecycle derived from them. Zero at turn end means the
   * agent said nothing we could show, which is the visible shape of a broken
   * notification stream.
   */
  turnProjectedUpdateCount: number;
  /** Bumped on dispose so a late notification finalizer cannot stomp a recycle. */
  notificationGeneration: number;
  /** Open ACP tool calls for the live turn (force-closed on Stop). */
  openToolCallIds: Set<string>;
  openToolTitles: Map<string, string>;
  openToolKinds: Map<string, string | undefined>;
  /** Cursor Task tool calls currently represented as agent runs. */
  openAgentRuns: Map<
    string,
    {
      readonly agentRunId: RuntimeAgentId;
      readonly label: string;
      readonly turnId: TurnId | undefined;
    }
  >;
  /** Turns already interrupted; late prompt RPCs must not re-open them. */
  interruptedTurnIds: Set<TurnId>;
  /**
   * After Stop / silent failure the ACP child may be wedged. Next sendTurn
   * recycles the process (Grok parity for long sessions).
   */
  acpCompromised: boolean;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  /**
   * Turns already force-settled by Stop/interrupt. Prompt completion must not
   * re-fire turn.completed for these ids (double-complete confuses Working).
   */
  forceSettledTurnIds: Set<string>;
  /**
   * Whether this ACP process was spawned with Toolport MCP in mcpServers.
   * Settings toggles update process.env immediately; mismatch triggers recycle.
   */
  injectsToolportMcp: boolean;
  /** MCP server name fingerprint at last ACP spawn. */
  mcpBindingCatalog: string;
  stopped: boolean;
}

/** Prefer the live turn; fall back to last bound turn for late ACP notifications. */
const resolveCursorNotificationTurnId = (ctx: CursorSessionContext): TurnId | undefined =>
  ctx.activeTurnId ?? ctx.lastNotificationTurnId;

/** Shared with the ACP runtime, which uses the same signal to decide what to emit. */
const isCursorSubagentTask = isAcpSubagentTaskToolCall;

/**
 * Whether a finished turn produced nothing the user could see.
 *
 * A healthy Cursor turn projects at least one visible event off the
 * notification stream — reasoning, assistant text, or a tool call. Zero of
 * them plus a clean `end_turn` is the signature of a stream that stopped
 * reaching the adapter: the prompt RPC still resolves, so the turn just ends
 * in silence with no error.
 * Cancelled turns are excluded; stopping early is expected to produce nothing.
 */
export function cursorTurnEndedWithoutOutput(input: {
  readonly projectedUpdateCount: number;
  readonly assistantText: string;
  readonly stopReason: string | null | undefined;
}): boolean {
  if (input.stopReason === "cancelled") {
    return false;
  }
  return input.projectedUpdateCount === 0 && input.assistantText.trim().length === 0;
}

function cursorSubagentLabel(toolCall: AcpToolCallState): string {
  const stripped = toolCall.title?.replace(/^task:\s*/i, "").trim();
  if (!stripped || stripped.toLowerCase() === "subagent task") {
    return "Cursor subagent";
  }
  return stripped;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cursor");
    const pendingApprovalTimeoutMs =
      options?.pendingApprovalTimeoutMs ?? CURSOR_PENDING_APPROVAL_TIMEOUT_MS;
    const pendingUserInputTimeoutMs =
      options?.pendingUserInputTimeoutMs ?? CURSOR_PENDING_USER_INPUT_TIMEOUT_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Cursor runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Cursor ACP extension event.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const emitCursorAgentLifecycle = Effect.fn("emitCursorAgentLifecycle")(function* (
      ctx: CursorSessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId | undefined,
      rawPayload: unknown,
    ) {
      if (!isCursorSubagentTask(toolCall)) {
        return;
      }
      const agentRunId = RuntimeAgentId.make(toolCall.toolCallId);
      const previous = ctx.openAgentRuns.get(toolCall.toolCallId);
      const terminal = toolCall.status === "completed" || toolCall.status === "failed";
      const label = cursorSubagentLabel(toolCall);
      const type = terminal ? "agent.completed" : previous ? "agent.updated" : "agent.started";
      const status =
        toolCall.status === "failed"
          ? ("failed" as const)
          : toolCall.status === "completed"
            ? ("completed" as const)
            : ("running" as const);

      if (terminal) {
        ctx.openAgentRuns.delete(toolCall.toolCallId);
      } else {
        ctx.openAgentRuns.set(toolCall.toolCallId, {
          agentRunId,
          label,
          turnId,
        });
      }

      yield* offerRuntimeEvent({
        type,
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        providerRefs: { agentRunId },
        payload: {
          agentRunId,
          status,
          label,
          canInspectThread: false,
        },
        raw: {
          source: "acp.jsonrpc",
          method: "session/update",
          payload: rawPayload,
        },
      });
    });

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const planTurnId = resolveCursorNotificationTurnId(ctx);
        const fingerprint = `${planTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: planTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const resolveLiveSession = (threadId: ThreadId): CursorSessionContext | undefined => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped ? ctx : undefined;
    };

    const disposeAcpProcess = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        const notificationFiber = ctx.notificationFiber;
        const scope = ctx.scope;
        // Invalidate in-flight notification finalizers before clearing the
        // fiber so a late ensuring cannot stomp a recycled consumer.
        ctx.notificationGeneration += 1;
        ctx.notificationFiber = undefined;
        if (notificationFiber) {
          yield* Fiber.interrupt(notificationFiber).pipe(Effect.ignore, Effect.forkChild);
        }
        yield* Effect.ignore(Scope.close(scope, Exit.void)).pipe(Effect.forkChild);
      });

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* disposeAcpProcess(ctx);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const wireAcpHandlers = (
      acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
      input: {
        readonly threadId: ThreadId;
        readonly runtimeMode: RuntimeMode;
        readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
        readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
      },
    ) =>
      Effect.gen(function* () {
        const activeTurnId = () => resolveLiveSession(input.threadId)?.activeTurnId;
        yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
          mapExtensionFailure(
            Effect.gen(function* () {
              yield* logNative(
                input.threadId,
                "cursor/ask_question",
                params,
                "acp.cursor.extension",
              );
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              input.pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: activeTurnId(),
                requestId: runtimeRequestId,
                payload: { questions: extractAskQuestions(params) },
                raw: {
                  source: "acp.cursor.extension",
                  method: "cursor/ask_question",
                  payload: params,
                },
              });
              const raceResult = yield* Effect.raceFirst(
                Deferred.await(answers).pipe(
                  Effect.map((value) => ({ _tag: "answered" as const, value })),
                ),
                Effect.sleep(`${pendingUserInputTimeoutMs} millis`).pipe(
                  Effect.as({ _tag: "timeout" as const }),
                ),
              );
              const resolved: ProviderUserInputAnswers =
                raceResult._tag === "timeout" ? {} : raceResult.value;
              if (raceResult._tag === "timeout") {
                yield* Deferred.succeed(answers, {}).pipe(Effect.ignore);
                yield* Effect.logWarning("Cursor user-input request timed out; auto-cancelled", {
                  threadId: input.threadId,
                  requestId,
                  timeoutMs: pendingUserInputTimeoutMs,
                });
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: activeTurnId(),
                  payload: {
                    message: `User input timed out after ${Math.round(pendingUserInputTimeoutMs / 1000)}s with no answer. Request was cancelled automatically.`,
                  },
                });
              }
              input.pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: activeTurnId(),
                requestId: runtimeRequestId,
                payload: {
                  answers: resolved,
                  resolvedBy: raceResult._tag === "timeout" ? "timeout" : "user",
                },
              });
              return { answers: resolved };
            }),
          ),
        );
        yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
          mapExtensionFailure(
            Effect.gen(function* () {
              yield* logNative(
                input.threadId,
                "cursor/create_plan",
                params,
                "acp.cursor.extension",
              );
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: activeTurnId(),
                payload: { planMarkdown: extractPlanMarkdown(params) },
                raw: {
                  source: "acp.cursor.extension",
                  method: "cursor/create_plan",
                  payload: params,
                },
              });
              return { accepted: true } as const;
            }),
          ),
        );
        yield* acp.handleExtNotification(
          "cursor/update_todos",
          CursorUpdateTodosRequest,
          (params) =>
            mapExtensionFailure(
              Effect.gen(function* () {
                yield* logNative(
                  input.threadId,
                  "cursor/update_todos",
                  params,
                  "acp.cursor.extension",
                );
                const live = resolveLiveSession(input.threadId);
                if (live) {
                  yield* emitPlanUpdate(
                    live,
                    extractTodosAsPlan(params),
                    params,
                    "acp.cursor.extension",
                    "cursor/update_todos",
                  );
                }
              }),
            ),
        );
        yield* acp.handleRequestPermission((params) =>
          mapExtensionFailure(
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params, "acp.jsonrpc");
              const runtimeMode =
                resolveLiveSession(input.threadId)?.session.runtimeMode ?? input.runtimeMode;
              if (runtimeMode === "full-access") {
                const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
                }
              }
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              input.pendingApprovals.set(requestId, {
                decision,
                kind: permissionRequest.kind,
              });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: activeTurnId(),
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail:
                    permissionRequest.detail ??
                    encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                    "[unserializable params]",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const raceResult = yield* Effect.raceFirst(
                Deferred.await(decision).pipe(
                  Effect.map((value) => ({ _tag: "decided" as const, value })),
                ),
                Effect.sleep(`${pendingApprovalTimeoutMs} millis`).pipe(
                  Effect.as({ _tag: "timeout" as const }),
                ),
              );
              const resolved: ProviderApprovalDecision =
                raceResult._tag === "timeout" ? "cancel" : raceResult.value;
              if (raceResult._tag === "timeout") {
                yield* Deferred.succeed(decision, "cancel").pipe(Effect.ignore);
                yield* Effect.logWarning("Cursor approval request timed out; auto-cancelled", {
                  threadId: input.threadId,
                  requestId,
                  timeoutMs: pendingApprovalTimeoutMs,
                });
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: activeTurnId(),
                  payload: {
                    message: `Permission request timed out after ${Math.round(pendingApprovalTimeoutMs / 1000)}s with no decision. Request was cancelled automatically.`,
                  },
                });
              }
              input.pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: activeTurnId(),
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                  resolvedBy: raceResult._tag === "timeout" ? "timeout" : "user",
                }),
              );
              return {
                outcome:
                  resolved === "cancel"
                    ? ({ outcome: "cancelled" } as const)
                    : {
                        outcome: "selected" as const,
                        optionId: acpPermissionOutcome(resolved),
                      },
              };
            }),
          ),
        );
      });

    const noteVisibleActivity = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        ctx.lastVisibleActivityAtMs = yield* Clock.currentTimeMillis;
        ctx.turnProjectedUpdateCount += 1;
      });

    const trackToolCallLifecycle = (
      ctx: CursorSessionContext,
      toolCall: {
        readonly toolCallId: string;
        readonly status?: "pending" | "inProgress" | "completed" | "failed";
        readonly title?: string;
        readonly kind?: string;
      },
    ) => {
      const toolCallId = toolCall.toolCallId;
      if (!toolCallId) {
        return;
      }
      if (toolCall.status === "completed" || toolCall.status === "failed") {
        ctx.openToolCallIds.delete(toolCallId);
        ctx.openToolTitles.delete(toolCallId);
        ctx.openToolKinds.delete(toolCallId);
        return;
      }
      // pending / inProgress / unknown: treat as open so Stop can force-close.
      ctx.openToolCallIds.add(toolCallId);
      if (toolCall.title?.trim()) {
        ctx.openToolTitles.set(toolCallId, toolCall.title.trim());
      }
      if (toolCall.kind !== undefined) {
        ctx.openToolKinds.set(toolCallId, toolCall.kind);
      }
    };

    /**
     * Stop must not leave ghost inProgress tool rows (long turns + MCP tools).
     * Shared product policy: shouldForceCloseOpenToolsOnStop().
     */
    const forceCloseOpenTools = (ctx: CursorSessionContext, threadId: ThreadId, turnId: TurnId) =>
      Effect.gen(function* () {
        if (!shouldForceCloseOpenToolsOnStop() || ctx.openToolCallIds.size === 0) {
          return;
        }
        const stamp = yield* makeEventStamp();
        const openIds = [...ctx.openToolCallIds];
        for (const toolCallId of openIds) {
          const kind = ctx.openToolKinds.get(toolCallId);
          const rawTitle = ctx.openToolTitles.get(toolCallId)?.trim() || "";
          const title =
            rawTitle.length > 0 && rawTitle !== "tool" && rawTitle !== kind ? rawTitle : undefined;
          yield* offerRuntimeEvent(
            makeAcpToolCallEvent({
              stamp,
              provider: PROVIDER,
              threadId,
              turnId,
              toolCall: {
                toolCallId,
                ...(title ? { title } : {}),
                ...(kind ? { kind } : {}),
                status: "failed",
                detail: "Tool did not complete before the turn stopped.",
                data: { toolCallId, forcedClose: true, ...(kind ? { kind } : {}) },
              },
              rawPayload: {
                source: "studio.open-tool-force-close",
                toolCallId,
                ...(title ? { title } : {}),
                ...(kind ? { kind } : {}),
              },
            }),
          );
          const agent = ctx.openAgentRuns.get(toolCallId);
          if (agent) {
            yield* offerRuntimeEvent({
              type: "agent.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: agent.turnId ?? turnId,
              providerRefs: { agentRunId: agent.agentRunId },
              payload: {
                agentRunId: agent.agentRunId,
                status: "stopped",
                label: agent.label,
                message: "Cursor subagent did not complete before the turn stopped.",
                canInspectThread: false,
              },
              raw: {
                source: "acp.jsonrpc",
                method: "studio.open-tool-force-close",
                payload: { toolCallId },
              },
            });
            ctx.openAgentRuns.delete(toolCallId);
          }
        }
        ctx.openToolCallIds.clear();
        ctx.openToolTitles.clear();
        ctx.openToolKinds.clear();
        ctx.openAgentRuns.clear();
      });

    const markAcpCompromised = (ctx: CursorSessionContext, reason: string) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.acpCompromised) {
          return;
        }
        ctx.acpCompromised = true;
        yield* Effect.logWarning("Cursor ACP marked compromised; will recycle before next turn", {
          threadId: ctx.threadId,
          reason,
        });
      });

    const startNotificationFiber = (ctx: CursorSessionContext) => {
      const generation = ctx.notificationGeneration;
      return Stream.runDrain(
        Stream.mapEffect(ctx.acp.getEvents(), (event) =>
          Effect.gen(function* () {
            const notificationTurnId = resolveCursorNotificationTurnId(ctx);
            switch (event._tag) {
              case "EventStreamBarrier":
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              case "ModeChanged":
                return;
              case "AssistantItemStarted":
                yield* noteVisibleActivity(ctx);
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                yield* noteVisibleActivity(ctx);
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                yield* noteVisibleActivity(ctx);
                yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                yield* emitPlanUpdate(
                  ctx,
                  event.payload,
                  event.rawPayload,
                  "acp.jsonrpc",
                  "session/update",
                );
                return;
              case "ToolCallUpdated":
                yield* noteVisibleActivity(ctx);
                trackToolCallLifecycle(ctx, event.toolCall);
                yield* logNative(ctx.threadId, "session/update", event.rawPayload, "acp.jsonrpc");
                const toolRuntimeEvent = makeAcpToolCallEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: notificationTurnId,
                  toolCall: event.toolCall,
                  rawPayload: event.rawPayload,
                });
                yield* offerRuntimeEvent(
                  isCursorSubagentTask(event.toolCall)
                    ? {
                        ...toolRuntimeEvent,
                        providerRefs: {
                          ...toolRuntimeEvent.providerRefs,
                          agentRunId: RuntimeAgentId.make(event.toolCall.toolCallId),
                        },
                      }
                    : toolRuntimeEvent,
                );
                // After the tool event, not before. Both carry the same id, so
                // the work log collapses them onto one row where the later
                // entry wins `itemType`. Emitting the tool event last dropped
                // `collab_agent_tool_call` from that row, which is the field
                // the timeline uses to keep the agent visible and deep-linked.
                yield* emitCursorAgentLifecycle(
                  ctx,
                  event.toolCall,
                  notificationTurnId,
                  event.rawPayload,
                );
                return;
              case "ContentDelta":
                // Skip native log for high-frequency text deltas (SOU-400 host tax).
                yield* noteVisibleActivity(ctx);
                if (event.text.length > 0) {
                  ctx.turnAssistantText = `${ctx.turnAssistantText}${event.text}`;
                }
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ThoughtDelta":
                // Provider-authored thinking/progress (ACP agent_thought_chunk).
                // Grok surfaces these as collapsible reasoning; Cursor previously
                // dropped them, so long thinking looked like a dead Working state.
                yield* noteVisibleActivity(ctx);
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    text: event.text,
                    streamKind: "reasoning_text",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "UsageUpdated": {
                const usageEvent = makeAcpTokenUsageUpdatedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: ctx.threadId,
                  turnId: notificationTurnId,
                  usedTokens: event.usedTokens,
                  maxTokens: event.maxTokens,
                  rawPayload: event.rawPayload,
                });
                if (usageEvent) {
                  yield* offerRuntimeEvent(usageEvent);
                }
                return;
              }
            }
          }),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to process Cursor runtime notification.", { cause }),
        ),
        // Grok parity. Without this the consumer could end and every later
        // session/update would vanish in silence: prompts still resolve, so
        // turns kept ending with no reply and nothing ever recycled the child.
        Effect.ensuring(
          Effect.gen(function* () {
            // Ignore finalizers from a disposed generation after recycle/stop.
            if (ctx.notificationGeneration !== generation || ctx.stopped) {
              return;
            }
            ctx.notificationFiber = undefined;
            yield* markAcpCompromised(ctx, "notification stream ended");
          }),
        ),
        // Fork into the session scope, not the caller's fiber. `forkChild`
        // made this consumer a child of the fiber running startSession, so it
        // was interrupted the moment startSession returned and every
        // session/update after that was lost. That is why a cursor turn
        // projected nothing at all, and why the compromise marking above then
        // recycled into a session/load the agent no longer knows about.
        Effect.forkIn(ctx.scope),
      );
    };

    /**
     * Recycle the Cursor ACP child while preserving resumeCursor when possible.
     * Used for MCP rebind and post-Stop compromise recovery (long-session reliability).
     */
    const recycleCursorAcp = (ctx: CursorSessionContext, reason: string) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        const env = options?.environment ?? process.env;
        const previousSessionId = parseCursorResume(ctx.session.resumeCursor)?.sessionId;
        const cwd = ctx.session.cwd;
        if (!cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "recycleCursorAcp",
            issue: "The Cursor session has no working directory to restart from.",
          });
        }

        yield* Effect.logInfo("Recycling Cursor ACP process", {
          threadId: ctx.threadId,
          reason,
          hadResumeCursor: previousSessionId !== undefined,
        });

        yield* disposeAcpProcess(ctx);

        const effectiveCursorSettings = options?.resolveSettings
          ? yield* options.resolveSettings
          : cursorSettings;
        const mcpBindings = McpProviderSession.readMcpProviderBindings(ctx.threadId, env);
        const injectsToolport = mcpBindings.some(
          (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
        );
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: ctx.threadId,
        });

        const sessionScope = yield* Scope.make("sequential");
        const acp = yield* makeCursorAcpRuntime({
          cursorSettings: effectiveCursorSettings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd,
          ...(previousSessionId ? { resumeSessionId: previousSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(mcpBindings.length > 0
            ? { mcpServers: McpProviderSession.toAcpMcpServers(mcpBindings) }
            : {}),
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: ctx.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        yield* wireAcpHandlers(acp, {
          threadId: ctx.threadId,
          runtimeMode: ctx.session.runtimeMode,
          pendingApprovals: ctx.pendingApprovals,
          pendingUserInputs: ctx.pendingUserInputs,
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/start", error),
          ),
        );
        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/start", error),
            ),
          );

        const modelSelection =
          ctx.session.model !== undefined
            ? { model: ctx.session.model, options: undefined }
            : undefined;
        yield* applyRequestedSessionConfiguration({
          runtime: acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: undefined,
          modelSelection,
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, method, cause),
        });

        ctx.scope = sessionScope;
        ctx.acp = acp;
        ctx.injectsToolportMcp = injectsToolport;
        ctx.mcpBindingCatalog = McpProviderSession.mcpBindingCatalogKey(
          McpProviderSession.readMcpProviderBindings(
            ctx.threadId,
            options?.environment ?? process.env,
          ),
        );
        ctx.acpCompromised = false;
        ctx.openToolCallIds.clear();
        ctx.openToolTitles.clear();
        ctx.openToolKinds.clear();
        ctx.session = {
          ...ctx.session,
          resumeCursor: {
            schemaVersion: CURSOR_RESUME_VERSION,
            sessionId: started.sessionId,
          },
          updatedAt: yield* nowIso,
        };
        ctx.promptsInFlight = 0;
        ctx.activeTurnId = undefined;
        if (ctx.session.activeTurnId !== undefined) {
          const { activeTurnId: _cleared, ...readySession } = ctx.session;
          ctx.session = {
            ...readySession,
            status: "ready",
            updatedAt: yield* nowIso,
          };
        }
        ctx.notificationFiber = yield* startNotificationFiber(ctx);
      });

    /**
     * MCP servers are spawn-time (ACP mcpServers). Toolport settings or preview
     * arming can change the catalog; recycle so the agent sees the new list.
     */
    const rebindCursorToolportMcpIfNeeded = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        const env = options?.environment ?? process.env;
        const nextCatalog = McpProviderSession.mcpBindingCatalogKey(
          McpProviderSession.readMcpProviderBindings(ctx.threadId, env),
        );
        if (nextCatalog === ctx.mcpBindingCatalog) {
          return;
        }

        yield* Effect.logInfo("Cursor MCP catalog changed; recycling ACP process", {
          threadId: ctx.threadId,
          from: ctx.mcpBindingCatalog,
          to: nextCatalog,
        });
        yield* recycleCursorAcp(ctx, "mcp-catalog-changed");
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const cursorModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the CursorSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { cursor: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveCursorSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : cursorSettings;

          const mcpBindings = McpProviderSession.readMcpProviderBindings(
            input.threadId,
            options?.environment ?? process.env,
          );
          const injectsToolportMcp = mcpBindings.some(
            (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
          );
          const acp = yield* makeCursorAcpRuntime({
            cursorSettings: effectiveCursorSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpBindings.length > 0
              ? { mcpServers: McpProviderSession.toAcpMcpServers(mcpBindings) }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          yield* wireAcpHandlers(acp, {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            pendingApprovals,
            pendingUserInputs,
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: CursorSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            lastNotificationTurnId: undefined,
            lastVisibleActivityAtMs: yield* Clock.currentTimeMillis,
            silentPromptWarningTurnId: undefined,
            turnAssistantText: "",
            turnProjectedUpdateCount: 0,
            notificationGeneration: 0,
            openToolCallIds: new Set(),
            openToolTitles: new Map(),
            openToolKinds: new Map(),
            openAgentRuns: new Map(),
            interruptedTurnIds: new Set(),
            acpCompromised: false,
            promptsInFlight: 0,
            forceSettledTurnIds: new Set(),
            injectsToolportMcp,
            mcpBindingCatalog: McpProviderSession.mcpBindingCatalogKey(mcpBindings),
            stopped: false,
          };

          // Register before starting the notification consumer so extension
          // callbacks during the first turn can resolve the live context.
          sessions.set(input.threadId, ctx);
          ctx.notificationFiber = yield* startNotificationFiber(ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Toolport MCP is fixed at ACP spawn; rebind before the next prompt so
        // Settings toggles apply without starting a brand-new thread.
        yield* rebindCursorToolportMcpIfNeeded(ctx);
        // After Stop the child may be wedged; recycle before new work so long
        // sessions cannot black-hole (Grok parity).
        if (ctx.acpCompromised) {
          yield* recycleCursorAcp(ctx, "compromised-before-send");
        }
        // A sendTurn while a prompt is in flight is a steer: the agent folds
        // the new prompt into the ongoing work, so the active turn id is
        // reused instead of opening a new turn (shared steer policy, SOU-428).
        const liveActiveTurnId = ctx.activeTurnId;
        const steeringTurnId = canSteerSendTurn({
          promptsInFlight: ctx.promptsInFlight,
          hasActiveTurnId: liveActiveTurnId !== undefined,
          activeTurnInterrupted:
            liveActiveTurnId !== undefined && ctx.interruptedTurnIds.has(liveActiveTurnId),
        })
          ? liveActiveTurnId
          : undefined;
        if (steeringTurnId === undefined && (ctx.promptsInFlight > 0 || liveActiveTurnId)) {
          ctx.promptsInFlight = 0;
          ctx.activeTurnId = undefined;
        }
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn; the matching
        // decrement is the `ensuring` below.
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveCursorAcpBaseModelId(model);

          // Mark running + emit turn.started before session config (set_model /
          // mode). Config can take seconds; delaying chrome left a blank hole
          // matching the pre-fix Claude path (Claude Desktop always shows live).
          ctx.activeTurnId = turnId;
          ctx.lastNotificationTurnId = turnId;
          ctx.lastVisibleActivityAtMs = yield* Clock.currentTimeMillis;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
            ctx.silentPromptWarningTurnId = undefined;
            ctx.turnAssistantText = "";
            ctx.turnProjectedUpdateCount = 0;
            ctx.openToolCallIds.clear();
            ctx.openToolTitles.clear();
            ctx.openToolKinds.clear();
            ctx.interruptedTurnIds.delete(turnId);
            ctx.forceSettledTurnIds.delete(String(turnId));
          }
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(resolvedModel ? { model: resolvedModel } : {}),
          };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });
          }

          // Dogfood: first-token delay and post-tool thinking can look dead.
          // Poll while the turn is live; warn once after sustained silence with
          // no open tools (quiet tools are valid long-running work).
          const silenceWatchTurnId = turnId;
          yield* Effect.gen(function* () {
            while (!ctx.stopped) {
              yield* Effect.sleep(`${CURSOR_SILENCE_POLL_MS} millis`);
              if (ctx.stopped) {
                return;
              }
              if (ctx.silentPromptWarningTurnId === String(silenceWatchTurnId)) {
                return;
              }
              const stillThisTurn =
                ctx.activeTurnId === silenceWatchTurnId ||
                (ctx.promptsInFlight > 0 && ctx.lastNotificationTurnId === silenceWatchTurnId);
              if (!stillThisTurn || ctx.promptsInFlight <= 0) {
                return;
              }
              if (ctx.openToolCallIds.size > 0) {
                continue;
              }
              const now = yield* Clock.currentTimeMillis;
              if (now - ctx.lastVisibleActivityAtMs < CURSOR_SILENT_PROMPT_WARNING_MS) {
                continue;
              }
              ctx.silentPromptWarningTurnId = String(silenceWatchTurnId);
              yield* offerRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: silenceWatchTurnId,
                payload: {
                  message:
                    "Cursor has gone silent with no open tools. The agent may still be thinking, or the stream may be stuck. Wait, or press Stop and send again.",
                },
              });
              return;
            }
          }).pipe(Effect.forkChild);

          yield* applyRequestedSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection:
              model === undefined
                ? undefined
                : {
                    model,
                    options: turnModelSelection?.options,
                  },
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            promptParts.push({ type: "text", text: input.input.trim() });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // ACP serializes session/prompt. Without preemption, a steer waits
          // for the entire current tool loop — not true interjection.
          if (steeringTurnId !== undefined) {
            yield* ctx.acp.preemptActivePrompt;
          }

          const result = yield* ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
              // Process/transport death must not leave Working stuck without a
              // typed surface (conformance: process-death-is-typed-error).
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  if (ctx.forceSettledTurnIds.has(String(turnId))) {
                    return;
                  }
                  if (ctx.promptsInFlight !== 1) {
                    return;
                  }
                  ctx.forceSettledTurnIds.add(String(turnId));
                  ctx.interruptedTurnIds.add(turnId);
                  ctx.activeTurnId = undefined;
                  ctx.lastNotificationTurnId = turnId;
                  yield* forceCloseOpenTools(ctx, input.threadId, turnId);
                  yield* markAcpCompromised(ctx, "prompt request failed");
                  const updatedAt = yield* nowIso;
                  const { activeTurnId: _cleared, ...readySession } = ctx.session;
                  ctx.session = {
                    ...readySession,
                    status: "ready",
                    updatedAt,
                    model: resolvedModel,
                  };
                  const message =
                    error instanceof Error ? error.message : "Cursor prompt request failed.";
                  yield* offerRuntimeEvent({
                    type: "turn.aborted",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { reason: message },
                  });
                  yield* offerRuntimeEvent({
                    type: "runtime.error",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      message,
                      class: "provider_error",
                    },
                  });
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: "failed",
                      errorMessage: message,
                    },
                  });
                }),
              ),
            );

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model: resolvedModel,
          };

          // Only the last remaining prompt settles the turn — a steer-
          // superseded prompt resolving (usually cancelled) while another is
          // in flight or pending must leave the merged turn running.
          // Skip if Stop already force-settled this turn.
          if (ctx.promptsInFlight === 1 && !ctx.forceSettledTurnIds.has(String(turnId))) {
            const updatedAt = yield* nowIso;
            ctx.activeTurnId = undefined;
            const { activeTurnId: _cleared, ...readySession } = ctx.session;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt,
              model: resolvedModel,
            };

            // Agent end_turn without tool completion still leaves open tools
            // in the work log unless we force-close them here.
            yield* forceCloseOpenTools(ctx, input.threadId, turnId);

            // Cursor (and some other ACP agents) can dump provider-side failures
            // (e.g. resource_exhausted for temporary model capacity/routing) as
            // ordinary agent_message_chunk text and still return end_turn.
            // Treat those as failed turns, not successful replies. Does not
            // mean the user's Cursor plan is necessarily depleted.
            const emittedFailure =
              result.stopReason === "cancelled"
                ? undefined
                : classifyProviderEmittedFailure(ctx.turnAssistantText);
            if (emittedFailure) {
              const message = formatProviderEmittedFailureMessage(emittedFailure, {
                providerLabel: "Cursor",
                model: resolvedModel,
              });
              yield* Effect.logWarning("Cursor turn completed with provider-emitted failure", {
                threadId: input.threadId,
                turnId,
                code: emittedFailure.code,
                model: resolvedModel,
              });
              yield* offerRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  message,
                  class: emittedFailure.class,
                },
              });
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  stopReason: result.stopReason ?? null,
                  errorMessage: message,
                },
              });
            } else {
              if (
                cursorTurnEndedWithoutOutput({
                  projectedUpdateCount: ctx.turnProjectedUpdateCount,
                  assistantText: ctx.turnAssistantText,
                  stopReason: result.stopReason ?? null,
                })
              ) {
                // Silent end_turn means the notification stream stopped
                // reaching us. Say so and recycle the child before the next
                // turn, instead of ending on an empty bubble with no error.
                yield* Effect.logWarning("Cursor turn ended without producing any output", {
                  threadId: input.threadId,
                  turnId,
                  stopReason: result.stopReason ?? null,
                });
                yield* markAcpCompromised(ctx, "turn produced no notifications");
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    message:
                      "Cursor ended this turn without sending any reply. The agent connection will be restarted before your next message.",
                  },
                });
              }
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: result.stopReason ?? null,
                },
              });
            }
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const settleTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        // Never block Stop on a wedged ACP child process.
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
          Effect.timeout("2 seconds"),
          Effect.ignore,
        );
        // Force-settle immediately so Working cannot stick if cancel never
        // resolves the in-flight prompt (Claude/Grok parity).
        if (settleTurnId !== undefined && !ctx.forceSettledTurnIds.has(String(settleTurnId))) {
          ctx.forceSettledTurnIds.add(String(settleTurnId));
          ctx.interruptedTurnIds.add(settleTurnId);
          // Clear live turn for Working chrome, but keep lastNotificationTurnId
          // so late ACP stream chunks after cancel still bind to this turn.
          ctx.activeTurnId = undefined;
          ctx.lastNotificationTurnId = settleTurnId;
          ctx.promptsInFlight = 0;
          yield* forceCloseOpenTools(ctx, threadId, settleTurnId);
          // Stop may leave the ACP child wedged mid-tool; recycle before the
          // next message so long sessions stay usable.
          yield* markAcpCompromised(ctx, "stop");
          const updatedAt = yield* nowIso;
          const { activeTurnId: _cleared, ...readySession } = ctx.session;
          ctx.session = {
            ...readySession,
            status: "ready",
            updatedAt,
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "cancelled",
              stopReason: "cancelled",
            },
          });
        } else if (
          settleTurnId === undefined &&
          (ctx.session.status === "running" || ctx.session.status === "connecting")
        ) {
          ctx.promptsInFlight = 0;
          yield* markAcpCompromised(ctx, "stop-without-active-turn");
          const updatedAt = yield* nowIso;
          const { activeTurnId: _cleared, ...readySession } = ctx.session;
          ctx.session = {
            ...readySession,
            status: "ready",
            updatedAt,
          };
        }
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Cursor session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}
