// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { isAcpSessionLoadNotFound, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyGrokAcpModelSelection,
  buildGrokAcpEnvironmentForStudio,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../acp/GrokAcpSupport.ts";
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
} from "../acp/XAiAcpExtension.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_RESUME_VERSION = 1 as const;
/** Cap rehydrated transcript so a long thread cannot blow the next prompt. */
const GROK_CONTEXT_REHYDRATION_MAX_CHARS = 60_000;
/**
 * Auto-stop only when a tool is still open and nothing streams (option C).
 * Pure thinking without open tools is allowed much longer.
 */
const GROK_SILENT_OPEN_TOOL_WATCHDOG_MS = 90_000;
/**
 * Grok occasionally leaves the prompt RPC pending after a tool has already
 * completed. This is distinct from a legitimate long initial think: once the
 * agent has entered the tool loop, two minutes of total ACP silence is enough
 * to treat the turn as wedged and recycle it.
 */
const GROK_SILENT_POST_TOOL_WATCHDOG_MS = 2 * 60_000;
/** Absolute ceiling so a pure-think wedge cannot run forever. */
const GROK_SILENT_THINK_WATCHDOG_MS = 15 * 60_000;
const GROK_SILENT_TURN_WATCHDOG_POLL_MS = 10_000;

export type GrokSilentTurnKind = "open-tool" | "post-tool" | "thinking" | null;

export function classifyGrokSilentTurn(input: {
  readonly silentMs: number;
  readonly openToolCount: number;
  readonly hasObservedToolCall: boolean;
}): GrokSilentTurnKind {
  if (input.openToolCount > 0 && input.silentMs >= GROK_SILENT_OPEN_TOOL_WATCHDOG_MS) {
    return "open-tool";
  }
  if (
    input.openToolCount === 0 &&
    input.hasObservedToolCall &&
    input.silentMs >= GROK_SILENT_POST_TOOL_WATCHDOG_MS
  ) {
    return "post-tool";
  }
  if (
    input.openToolCount === 0 &&
    !input.hasObservedToolCall &&
    input.silentMs >= GROK_SILENT_THINK_WATCHDOG_MS
  ) {
    return "thinking";
  }
  return null;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface GrokAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface GrokSessionContext {
  readonly threadId: ThreadId;
  acpSessionId: string;
  promptCapabilities:
    | NonNullable<EffectAcpSchema.InitializeResponse["agentCapabilities"]>["promptCapabilities"]
    | undefined;
  session: ProviderSession;
  scope: Scope.Closeable;
  acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  stopped: boolean;
  /**
   * Set after Stop force-cancels a prompt. The ACP child may still be wedged;
   * the next sendTurn recycles the process before prompting so follow-ups
   * cannot black-hole.
   */
  acpCompromised: boolean;
  /**
   * Visible assistant/tool stream events observed for the active turn. Used to
   * detect silent end_turn completions that leave the session looking dead.
   */
  turnVisibleUpdateCount: number;
  /** Wall-clock ms of the last ACP stream/tool event for the active turn. */
  lastTurnActivityAtMs: number;
  /** Open toolCallIds still pending/inProgress for the active turn. */
  openToolCallIds: Set<string>;
  /** Whether the active prompt has entered a tool loop, including completed tools. */
  hasObservedToolCall: boolean;
  /** Best-effort title of the most recent open tool (for logs / errors). */
  lastOpenToolTitle: string | undefined;
  /**
   * Bumped whenever the ACP process or notification consumer is replaced so
   * late finalizers from a disposed consumer cannot clear the live fiber.
   */
  notificationGeneration: number;
  /** True after disposeAcpProcess until a successful recycle/start rebinds ACP. */
  acpDisposed: boolean;
  /**
   * Studio-side transcript for this Grok session. Grok's on-disk session is
   * often gone after Stop (Path not found on session/load). When recycle falls
   * back to a blank session/new, the next prompt rehydrates from this log.
   */
  conversationLog: Array<GrokConversationTurn>;
  /** After recycle landed on a different session id, rehydrate once. */
  needsContextRehydration: boolean;
}

export type GrokConversationTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
};

/** Append streamed/user text into a role-merged conversation log. Exported for tests. */
export function appendGrokConversationText(
  log: ReadonlyArray<GrokConversationTurn>,
  role: GrokConversationTurn["role"],
  text: string,
): Array<GrokConversationTurn> {
  // Assistant deltas are raw stream chunks (preserve spaces). User lines trim.
  const nextText = role === "assistant" ? text : text.trim();
  if (nextText.length === 0) {
    return [...log];
  }
  const last = log[log.length - 1];
  if (last && last.role === role) {
    const separator = role === "assistant" ? "" : "\n";
    return [...log.slice(0, -1), { role, text: `${last.text}${separator}${nextText}` }];
  }
  return [...log, { role, text: nextText }];
}

/**
 * Build a prompt prefix that restores Studio-known history when the provider
 * session could not be resumed. Exported for tests.
 */
export function buildGrokContextRehydrationPrefix(
  log: ReadonlyArray<GrokConversationTurn>,
  maxChars = GROK_CONTEXT_REHYDRATION_MAX_CHARS,
): string | undefined {
  if (log.length === 0 || maxChars <= 0) {
    return undefined;
  }
  const lines: string[] = [];
  let used = 0;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const turn = log[index];
    if (!turn) continue;
    const label = turn.role === "user" ? "User" : "Assistant";
    const block = `${label}:\n${turn.text}`;
    const cost = block.length + (lines.length > 0 ? 2 : 0);
    if (used + cost > maxChars && lines.length > 0) {
      break;
    }
    if (used + cost > maxChars) {
      const remaining = Math.max(0, maxChars - used - `${label}:\n`.length - 20);
      lines.unshift(`${label}:\n${turn.text.slice(-remaining)}\n…`);
      break;
    }
    lines.unshift(block);
    used += cost;
  }
  if (lines.length === 0) {
    return undefined;
  }
  return [
    "The previous Grok provider session was interrupted and could not be resumed (common after Stop).",
    "Here is the conversation so far from Toolport Studio. Treat it as your memory of this thread and continue without asking the user to restate it.",
    "",
    lines.join("\n\n"),
    "",
    "---",
    "Latest user message:",
    "",
  ].join("\n");
}

export function buildGrokImagePromptPart(input: {
  readonly data: string;
  readonly mimeType: string;
  readonly uri: string;
  readonly promptCapabilities: GrokSessionContext["promptCapabilities"];
}): EffectAcpSchema.ContentBlock {
  if (
    input.promptCapabilities?.image === false &&
    input.promptCapabilities.embeddedContext === true
  ) {
    return {
      type: "resource",
      resource: {
        uri: input.uri,
        blob: input.data,
        mimeType: input.mimeType,
      },
    };
  }

  return {
    type: "image",
    data: input.data,
    mimeType: input.mimeType,
    uri: input.uri,
  };
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

function parseGrokResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined || promptResponseHasMissingXAiStopReason(response)) {
    return null;
  }
  return response.stopReason;
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

/**
 * Whether a new sendTurn should continue the current live turn (steer) vs open
 * a fresh turn id. Stop/watchdog must never leave a cancelled turn eligible.
 */
export function canSteerGrokSendTurn(input: {
  readonly promptsInFlight: number;
  readonly activeTurnId: TurnId | undefined;
  readonly interruptedTurnIds: ReadonlySet<TurnId>;
}): boolean {
  return (
    input.promptsInFlight > 0 &&
    input.activeTurnId !== undefined &&
    !input.interruptedTurnIds.has(input.activeTurnId)
  );
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Grok runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Grok ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

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

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // Still drop leftover prompt slots on explicit cancel/interrupt so a
          // follow-up cannot "steer" into a dead turn (Stop → next message
          // fails with "interrupted during preparation").
          if (options?.settleAllPrompts) {
            liveCtx.promptsInFlight = 0;
          }
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
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
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Grok notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const disposeAcpProcess = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (ctx.acpDisposed) {
          return;
        }
        const notificationFiber = ctx.notificationFiber;
        const scope = ctx.scope;
        // Invalidate in-flight notification finalizers before clearing the fiber
        // so a late ensuring cannot stomp a recycled consumer.
        ctx.notificationGeneration += 1;
        ctx.notificationFiber = undefined;
        ctx.acpDisposed = true;
        if (notificationFiber) {
          // Never block teardown on a stuck notification consumer. Scope
          // finalizers can be uninterruptible, so fork rather than timeout.
          yield* Fiber.interrupt(notificationFiber).pipe(Effect.ignore, Effect.forkChild);
        }
        // Fire-and-forget process teardown. Waiting on Scope.close can hang
        // forever when the ACP child is wedged (uninterruptible finalizers).
        yield* Effect.ignore(Scope.close(scope, Exit.void)).pipe(Effect.forkChild);
      });

    const stopSessionInternal = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
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
        readonly runtimeMode: ProviderSession["runtimeMode"];
        readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
        readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
      },
    ) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
          (method) =>
            acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, method, params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const resolution = yield* Deferred.make<PendingUserInputResolution>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  input.pendingUserInputs.set(requestId, { resolution });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { questions: extractXAiAskUserQuestions(params) },
                    raw: {
                      source: "acp.grok.extension",
                      method,
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(resolution);
                  input.pendingUserInputs.delete(requestId);
                  const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolvedAnswers },
                    raw: {
                      source: "acp.grok.extension",
                      method,
                      payload: params,
                    },
                  });
                  switch (resolved._tag) {
                    case "answered":
                      return makeXAiAskUserQuestionResponse(params, resolved.answers);
                    case "cancelled":
                      return makeXAiAskUserQuestionCancelledResponse();
                  }
                }),
              ),
            ),
          { discard: true },
        );
        yield* acp.handleRequestPermission((params) =>
          mapAcpCallbackFailure(
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              if (input.runtimeMode === "full-access") {
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
              const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
              input.pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
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
              const resolved = yield* Deferred.await(decision);
              input.pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const selectedOptionId =
                resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
              return {
                outcome: selectedOptionId
                  ? {
                      outcome: "selected" as const,
                      optionId: selectedOptionId,
                    }
                  : ({ outcome: "cancelled" } as const),
              };
            }),
          ),
        );
      });

    const markAcpCompromised = (ctx: GrokSessionContext, reason: string) =>
      Effect.gen(function* () {
        if (ctx.stopped || ctx.acpCompromised) {
          return;
        }
        ctx.acpCompromised = true;
        yield* Effect.logWarning("Grok ACP marked compromised; will recycle before next turn", {
          threadId: ctx.threadId,
          reason,
        });
      });

    const startNotificationFiber = (ctx: GrokSessionContext) => {
      const generation = ctx.notificationGeneration;
      return Stream.runDrain(
        Stream.mapEffect(ctx.acp.getEvents(), (event) =>
          Effect.gen(function* () {
            if (event._tag === "EventStreamBarrier") {
              yield* Deferred.succeed(event.acknowledge, undefined).pipe(Effect.ignore);
              return;
            }
            if (
              event._tag === "PlanUpdated" ||
              event._tag === "ToolCallUpdated" ||
              event._tag === "ContentDelta" ||
              event._tag === "ThoughtDelta" ||
              event._tag === "AssistantItemStarted" ||
              event._tag === "AssistantItemCompleted"
            ) {
              ctx.lastTurnActivityAtMs = yield* Clock.currentTimeMillis;
            }
            if (
              event._tag === "PlanUpdated" ||
              event._tag === "ToolCallUpdated" ||
              event._tag === "ContentDelta" ||
              event._tag === "ThoughtDelta"
            ) {
              yield* logNative(ctx.threadId, "session/update", event.rawPayload);
            }

            if (event._tag === "ModeChanged") {
              return;
            }

            const notificationTurnId = resolveNotificationTurnId(ctx);
            if (
              notificationTurnId === undefined ||
              ctx.interruptedTurnIds.has(notificationTurnId)
            ) {
              return;
            }
            const stamp = yield* makeEventStamp();

            switch (event._tag) {
              case "AssistantItemStarted":
                ctx.turnVisibleUpdateCount += 1;
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                ctx.turnVisibleUpdateCount += 1;
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                ctx.turnVisibleUpdateCount += 1;
                yield* emitPlanUpdate(
                  ctx,
                  notificationTurnId,
                  stamp,
                  event.payload,
                  event.rawPayload,
                  "session/update",
                );
                return;
              case "ToolCallUpdated": {
                ctx.turnVisibleUpdateCount += 1;
                ctx.hasObservedToolCall = true;
                const toolCallId = event.toolCall.toolCallId;
                const toolStatus = event.toolCall.status;
                if (toolStatus === "completed" || toolStatus === "failed") {
                  ctx.openToolCallIds.delete(toolCallId);
                  if (ctx.openToolCallIds.size === 0) {
                    ctx.lastOpenToolTitle = undefined;
                  }
                } else if (toolStatus === "pending" || toolStatus === "inProgress") {
                  ctx.openToolCallIds.add(toolCallId);
                  const title = event.toolCall.title?.trim();
                  if (title) {
                    ctx.lastOpenToolTitle = title;
                  } else if (!ctx.lastOpenToolTitle) {
                    ctx.lastOpenToolTitle = event.toolCall.kind ?? "tool";
                  }
                }
                yield* offerRuntimeEvent(
                  makeAcpToolCallEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              }
              case "ContentDelta":
                ctx.turnVisibleUpdateCount += 1;
                if (event.text.length > 0) {
                  ctx.conversationLog = appendGrokConversationText(
                    ctx.conversationLog,
                    "assistant",
                    event.text,
                  );
                }
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp,
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
                // Native Grok terminal shows these as collapsible Thinking blocks.
                // Emit as reasoning_text so ingestion can surface a collapsible
                // progress row without merging into the assistant reply body.
                ctx.turnVisibleUpdateCount += 1;
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    text: event.text,
                    streamKind: "reasoning_text",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
            }
          }).pipe(
            // One bad notification must not kill the consumer for later turns
            // (silent multi-turn death after Stop + one good follow-up).
            Effect.catch((cause) =>
              Effect.logError("Failed to process Grok runtime notification event.", {
                cause,
                threadId: ctx.threadId,
              }),
            ),
          ),
        ),
      ).pipe(
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
        Effect.forkChild,
      );
    };

    /**
     * Kill a wedged ACP child and open a fresh process. Prefer session/load of
     * the prior Grok session id so Stop → follow-up keeps conversation history.
     * Reusing the cancelled *process* is what black-holed multi-turn; a new
     * process + load restores disk history. If load misses (Path not found),
     * AcpSessionRuntime already falls back to session/new.
     */
    const recycleCompromisedAcp = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (!ctx.acpCompromised || ctx.stopped) {
          return;
        }
        const previousSessionId =
          ctx.acpSessionId.trim() ||
          parseGrokResume(ctx.session.resumeCursor)?.sessionId ||
          undefined;
        const cwd = ctx.session.cwd;
        if (cwd === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "recycleCompromisedAcp",
            issue: "The Grok session has no working directory to restart from.",
          });
        }
        yield* disposeAcpProcess(ctx);

        const mcpBindings = McpProviderSession.readMcpProviderBindings(
          ctx.threadId,
          options?.environment ?? process.env,
        );
        const injectsToolportGateway = mcpBindings.some(
          (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
        );
        const grokEnvironment = buildGrokAcpEnvironmentForStudio(
          options?.environment,
          injectsToolportGateway,
        );
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: ctx.threadId,
        });

        const startRecycledAcp = (resumeSessionId: string | undefined) =>
          Effect.gen(function* () {
            const sessionScope = yield* Scope.make("sequential");
            const acp = yield* makeGrokAcpRuntime({
              grokSettings,
              ...(grokEnvironment ? { environment: grokEnvironment } : {}),
              childProcessSpawner,
              cwd,
              // Prefer resume so Stop→follow-up keeps history. Soft miss falls
              // back inside AcpSessionRuntime; recycle also retries without
              // resume if start still fails with Path not found.
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
            return { sessionScope, acp, started } as const;
          });

        const recycled = yield* startRecycledAcp(previousSessionId).pipe(
          Effect.catchIf(
            (error) =>
              previousSessionId !== undefined &&
              (isAcpSessionLoadNotFound(error) ||
                isAcpSessionLoadNotFound(error instanceof Error ? error.message : String(error))),
            (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "Grok ACP recycle resume failed after Stop; retrying with a blank session/new",
                  {
                    threadId: ctx.threadId,
                    previousSessionId,
                    detail: error instanceof Error ? error.message : String(error),
                  },
                );
                return yield* startRecycledAcp(undefined);
              }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Grok ACP recycle failed after Stop", {
              threadId: ctx.threadId,
              detail: error instanceof Error ? error.message : String(error),
              previousSessionId,
            }),
          ),
        );

        const reboundModelId = yield* applyGrokAcpModelSelection({
          runtime: recycled.acp,
          currentModelId: currentGrokModelIdFromSessionSetup(recycled.started.sessionSetupResult),
          requestedModelId: ctx.currentModelId
            ? resolveGrokAcpBaseModelId(ctx.currentModelId)
            : undefined,
          mapError: (cause) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/set_model", cause),
        });

        ctx.scope = recycled.sessionScope;
        ctx.acp = recycled.acp;
        ctx.acpSessionId = recycled.started.sessionId;
        ctx.promptCapabilities =
          recycled.started.initializeResult.agentCapabilities?.promptCapabilities ?? undefined;
        ctx.currentModelId = reboundModelId;
        ctx.session = {
          ...ctx.session,
          ...(reboundModelId ? { model: resolveGrokAcpBaseModelId(reboundModelId) } : {}),
          resumeCursor: {
            schemaVersion: GROK_RESUME_VERSION,
            sessionId: recycled.started.sessionId,
          },
          updatedAt: yield* nowIso,
        };
        ctx.turnVisibleUpdateCount = 0;
        ctx.lastTurnActivityAtMs = yield* Clock.currentTimeMillis;
        ctx.openToolCallIds = new Set();
        ctx.hasObservedToolCall = false;
        ctx.lastOpenToolTitle = undefined;
        // Only a successful session/load proves Grok restored history. A
        // fallback session/new may legally reuse the same opaque id, so id
        // equality alone cannot distinguish a blank replacement session.
        if (!recycled.started.resumedExistingSession) {
          ctx.needsContextRehydration = true;
          yield* Effect.logWarning(
            "Grok ACP recycle started a new session; next turn will rehydrate Studio transcript",
            {
              threadId: ctx.threadId,
              previousSessionId,
              newSessionId: recycled.started.sessionId,
              conversationTurns: ctx.conversationLog.length,
            },
          );
        } else {
          ctx.needsContextRehydration = false;
        }
        // Generation already bumped in dispose; start consumer on the new process.
        ctx.notificationFiber = yield* startNotificationFiber(ctx);
        ctx.acpDisposed = false;
        ctx.acpCompromised = false;
        // Fresh ACP process: drop residual Stop/watchdog interrupt bookkeeping so
        // the next user message cannot steer into a cancelled turn id and fail
        // preparation with "Grok prompt was interrupted during preparation."
        ctx.promptsInFlight = 0;
        ctx.activeTurnId = undefined;
        ctx.interruptedTurnIds.clear();
        if (ctx.session.activeTurnId !== undefined) {
          const { activeTurnId: _clearedActiveTurnId, ...readySession } = ctx.session;
          ctx.session = {
            ...readySession,
            status: "ready",
            updatedAt: yield* nowIso,
          };
        }
      });

    const startSession: GrokAdapterShape["startSession"] = (input) =>
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
          const grokModelSelection =
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

          const resumeSessionId = parseGrokResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpBindings = McpProviderSession.readMcpProviderBindings(
            input.threadId,
            options?.environment ?? process.env,
          );
          const injectsToolportGateway = mcpBindings.some(
            (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
          );
          const grokEnvironment = buildGrokAcpEnvironmentForStudio(
            options?.environment,
            injectsToolportGateway,
          );
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(grokEnvironment ? { environment: grokEnvironment } : {}),
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
          const started = yield* Effect.gen(function* () {
            yield* wireAcpHandlers(acp, {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              pendingApprovals,
              pendingUserInputs,
            });
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined;
          const boundModelId = yield* applyGrokAcpModelSelection({
            runtime: acp,
            currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveGrokAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: GrokSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            promptCapabilities:
              started.initializeResult.agentCapabilities?.promptCapabilities ?? undefined,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            stopped: false,
            acpCompromised: false,
            turnVisibleUpdateCount: 0,
            lastTurnActivityAtMs: yield* Clock.currentTimeMillis,
            openToolCallIds: new Set(),
            hasObservedToolCall: false,
            lastOpenToolTitle: undefined,
            notificationGeneration: 0,
            acpDisposed: false,
            conversationLog: [],
            needsContextRehydration: false,
          };

          ctx.notificationFiber = yield* startNotificationFiber(ctx);
          sessions.set(input.threadId, ctx);
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
            payload: { state: "ready", reason: "Grok ACP session ready" },
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

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // After Stop (or silent empty end_turn) the child may be wedged.
            // Recycle before any new work so turns cannot black-hole.
            if (ctx.acpCompromised) {
              yield* recycleCompromisedAcp(ctx);
            }
            // A sendTurn while a live (non-interrupted) prompt is in flight is a
            // steer: the agent folds the new prompt into the ongoing work.
            // Never reuse a turn that Stop/watchdog already cancelled — that is
            // the "next message after Stop always errors" race.
            const liveActiveTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            const steeringTurnId = canSteerGrokSendTurn({
              promptsInFlight: ctx.promptsInFlight,
              activeTurnId: liveActiveTurnId,
              interruptedTurnIds: ctx.interruptedTurnIds,
            })
              ? liveActiveTurnId
              : undefined;
            if (steeringTurnId === undefined && (ctx.promptsInFlight > 0 || liveActiveTurnId)) {
              // Drop residual slots/ids from a cancelled or half-settled turn so
              // follow-up preparation starts clean.
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
            }
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            if (steeringTurnId === undefined) {
              ctx.turnVisibleUpdateCount = 0;
            }
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const currentModelId = yield* applyGrokAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });

              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
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
                    return buildGrokImagePromptPart({
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                      uri: NodeURL.pathToFileURL(attachmentPath).href,
                      promptCapabilities: ctx.promptCapabilities,
                    });
                  }),
              );
              // When Stop forced a blank session/new, inject Studio-side history
              // so Grok still has prior turns (session/load often Path not found).
              const rehydrationPrefix =
                steeringTurnId === undefined && ctx.needsContextRehydration
                  ? buildGrokContextRehydrationPrefix(ctx.conversationLog)
                  : undefined;
              const usesContextRehydration = rehydrationPrefix !== undefined;
              const promptText =
                text && rehydrationPrefix
                  ? `${rehydrationPrefix}${text}`
                  : rehydrationPrefix
                    ? `${rehydrationPrefix}(continue)`
                    : text;
              if (steeringTurnId === undefined && text) {
                ctx.conversationLog = appendGrokConversationText(ctx.conversationLog, "user", text);
              }
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(promptText ? [{ type: "text" as const, text: promptText }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
                usesContextRehydration,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          // Reset activity clock at prompt start so prior turn silence cannot trip us.
          const activityCtx = sessions.get(input.threadId);
          if (activityCtx) {
            activityCtx.lastTurnActivityAtMs = yield* Clock.currentTimeMillis;
            activityCtx.openToolCallIds = new Set();
            activityCtx.hasObservedToolCall = false;
            activityCtx.lastOpenToolTitle = undefined;
          }

          const silenceWatchdog = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(`${GROK_SILENT_TURN_WATCHDOG_POLL_MS} millis`);
              const live = sessions.get(input.threadId);
              if (
                !live ||
                live.stopped ||
                live.acpSessionId !== prepared.acpSessionId ||
                live.interruptedTurnIds.has(prepared.turnId)
              ) {
                // Parent fiber will interrupt this race arm when prompt settles.
                continue;
              }
              const silentMs = (yield* Clock.currentTimeMillis) - live.lastTurnActivityAtMs;
              const openToolCount = live.openToolCallIds.size;
              const silentTurnKind = classifyGrokSilentTurn({
                silentMs,
                openToolCount,
                hasObservedToolCall: live.hasObservedToolCall,
              });
              if (silentTurnKind === null) {
                continue;
              }
              const toolLabel = live.lastOpenToolTitle?.trim() || "a tool";
              yield* Effect.logWarning("Grok silent-turn watchdog fired", {
                threadId: input.threadId,
                turnId: prepared.turnId,
                silentMs,
                openToolCount,
                hasObservedToolCall: live.hasObservedToolCall,
                silentTurnKind,
                lastOpenToolTitle: live.lastOpenToolTitle,
              });
              live.acpCompromised = true;
              live.interruptedTurnIds.add(prepared.turnId);
              yield* live.acp.cancel.pipe(Effect.timeout("2 seconds"), Effect.ignore);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail:
                  silentTurnKind === "open-tool"
                    ? `Grok went silent for ${Math.round(silentMs / 1000)}s while ${toolLabel} was still running. Turn was stopped automatically — try a smaller task or Send again.`
                    : silentTurnKind === "post-tool"
                      ? `Grok stopped responding after its last tool completed. The turn was stopped automatically after ${Math.round(silentMs / 1000)}s with no progress — Send again to continue.`
                      : `Grok went silent for ${Math.round(silentMs / 60000)}+ minutes with no tools or stream updates. Turn was stopped automatically — try again.`,
              });
            }
          });

          const result = yield* Effect.raceFirst(
            prepared.acp
              .prompt({
                prompt: prepared.promptParts,
              })
              .pipe(
                Effect.tap((promptResult) =>
                  Effect.all([
                    Ref.set(promptRpcSucceeded, true),
                    Ref.set(promptResultRef, promptResult),
                  ]),
                ),
                Effect.tapError((error) =>
                  Ref.set(
                    promptFailureMessageRef,
                    mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                  ).pipe(
                    Effect.andThen(
                      prepared.acp.drainEvents.pipe(Effect.timeout("2 seconds"), Effect.ignore),
                    ),
                  ),
                ),
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
              ),
            silenceWatchdog.pipe(
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  error instanceof Error ? error.message : String(error),
                ),
              ),
            ),
          );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Grok session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok session changed before the turn completed.",
                });
              }
              if (prepared.usesContextRehydration) {
                // Keep the replay armed until the ACP prompt actually returns.
                // Preparation can fail or be interrupted before the blank
                // replacement session receives any Studio history.
                ctx.needsContextRehydration = false;
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              // If Stop already settled this turn, skip drain entirely. drainEvents
              // can hang on a wedged notification consumer even with a timeout when
              // finalizers are uninterruptible.
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }
              // Bound drain so a dead notification consumer cannot pin the
              // thread lock and block Stop / follow-up turns forever.
              yield* prepared.acp.drainEvents.pipe(Effect.timeout("2 seconds"), Effect.ignore);
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const completedStopReason = completedStopReasonFromPromptResponse(result);
                const cancelled = result.stopReason === "cancelled";
                const silentEmptyCompletion = !cancelled && ctx.turnVisibleUpdateCount === 0;
                if (silentEmptyCompletion) {
                  // Real Grok sessions after Stop/recycle can return end_turn with
                  // zero stream updates. Treat that as failure + compromise so the
                  // next message recycles instead of silently "working" forever.
                  yield* markAcpCompromised(ctx, "silent empty end_turn");
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    payload: {
                      state: "failed",
                      errorMessage:
                        "Grok finished without any visible response. The next message will reconnect the agent.",
                    },
                  });
                } else {
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    payload: {
                      state: cancelled ? "cancelled" : "completed",
                      stopReason: completedStopReason,
                    },
                  });
                }
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Grok session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    const cancelled = promptResult.stopReason === "cancelled";
                    const silentEmptyCompletion = !cancelled && ctx.turnVisibleUpdateCount === 0;
                    if (silentEmptyCompletion) {
                      yield* markAcpCompromised(ctx, "silent empty end_turn (ensuring)");
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage:
                            "Grok finished without any visible response. The next message will reconnect the agent.",
                        },
                      );
                      return;
                    }
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const ctx = sessions.get(input.threadId);
                  if (ctx && !ctx.stopped) {
                    yield* markAcpCompromised(ctx, "prompt request failed");
                  }
                  yield* settlePromptInFlight(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    {
                      errorMessage: errorMessage ?? "Grok prompt request failed.",
                    },
                  );
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return { _tag: "Ignore" as const };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        const cancelTarget = yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return Option.none<GrokSessionContext>();
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return Option.none<GrokSessionContext>();
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return Option.none<GrokSessionContext>();
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            // Settle local turn state before talking to the agent process. Cancel
            // can hang when Grok is wedged; the UI must still leave the running
            // state and accept follow-up messages.
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
            return Option.some(ctx);
          }),
        );

        // Never hold the thread lock across process cancel. Cancel can take up
        // to its timeout, and the interrupted sendTurn needs the lock to settle.
        if (Option.isSome(cancelTarget)) {
          const ctx = cancelTarget.value;
          yield* ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
            Effect.timeout("2 seconds"),
            Effect.ignore,
          );
          // Always recycle after Stop. Cooperative cancel is not trustworthy:
          // the child can still be wedged and black-hole the next user message
          // while the UI shows "working" with no stream (SOU-351 / SOU-358).
          // Next sendTurn starts a fresh process and session/load's the prior
          // session id so conversation history survives (not a blank agent).
          ctx.acpCompromised = true;
          yield* disposeAcpProcess(ctx);
        }
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
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

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
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
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Grok ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
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
    } satisfies GrokAdapterShape;
  });
}
