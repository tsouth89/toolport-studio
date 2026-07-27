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
  GROK_DEFAULT_REASONING_EFFORT,
  type GrokReasoningEffort,
  resolveGrokReasoningEffort,
} from "./GrokProvider.ts";
import {
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
} from "../acp/XAiAcpExtension.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  appendConversationHistoryText,
  buildConversationRehydrationPrefix,
  DEFAULT_CONVERSATION_REHYDRATION_MAX_CHARS,
  type ConversationHistoryTurn,
} from "../conversationRehydration.ts";
import {
  classifyProviderEmittedFailure,
  formatProviderEmittedFailureMessage,
} from "@t3tools/shared/providerError";

import {
  beginTurn,
  canSteerSendTurn,
  disposeSendWhileRunning,
  emptyTurnQueue,
  formatInterjectionText,
  markTurnRunning,
  PROVIDER_TURN_CAPABILITIES,
  shouldEmitSyntheticFollowUpChrome,
  shouldForceCloseOpenToolsOnSteer,
  type QueuedTurnInput,
  type SendDisposition,
} from "../turnEngine/index.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_RESUME_VERSION = 1 as const;
/** Cap rehydrated transcript so a long thread cannot blow the next prompt. */
const GROK_CONTEXT_REHYDRATION_MAX_CHARS = DEFAULT_CONVERSATION_REHYDRATION_MAX_CHARS;
/**
 * Opt-in only: thresholds used when `killOpenToolsOnSilence` is true (tests or
 * future settings). Product default never auto-stops a turn while a tool is
 * still open — quiet tools are valid work (long MCP, shell, search).
 */
const GROK_SILENT_OPEN_TOOL_WATCHDOG_MS = 90_000;
/** Opt-in only when killOpenToolsOnSilence is enabled. */
const GROK_SILENT_OPEN_EXECUTE_TOOL_WATCHDOG_MS = 15 * 60_000;
/**
 * After tools have run, Grok often plans the next wave with no ACP stream tokens.
 * That is healthy multi-tool work, not a wedge.
 *
 * SOU-399: post-tool silence must use the long ceiling (same as pure-think), not a
 * short wall-clock kill. Dogfood 2026-07-26 false-stopped a live research turn at
 * ~122s when this was 2 minutes.
 *
 * Open tools are never silence-killed by default (user Stop or ACP process death
 * settles instead). Dead ACP children still compromise via notification-stream end.
 */
const GROK_SILENT_POST_TOOL_WATCHDOG_MS = 15 * 60_000;
/** Absolute ceiling so a pure-think wedge cannot run forever. */
const GROK_SILENT_THINK_WATCHDOG_MS = 15 * 60_000;
const GROK_SILENT_TURN_WATCHDOG_POLL_MS = 10_000;
/**
 * How long a permission dialog can sit without a user decision before Studio
 * auto-cancels it. Without this, approval-required turns can hang forever.
 */
const GROK_PENDING_APPROVAL_TIMEOUT_MS = 3 * 60_000;
/**
 * How long an ask-user-question can sit unanswered before auto-cancel.
 * Slightly longer than approval: multi-question forms need more read time.
 */
const GROK_PENDING_USER_INPUT_TIMEOUT_MS = 5 * 60_000;

export type GrokSilentTurnWatchdogConfig = {
  /**
   * When true, silence can auto-stop while tools are still open (historical
   * kill path). Product default is false: open tools are never timeout-killed.
   */
  readonly killOpenToolsOnSilence: boolean;
  /** Non-execute open tools (MCP, etc.): only used if killOpenToolsOnSilence. */
  readonly openToolMs: number;
  /** Execute/shell open tools: only used if killOpenToolsOnSilence. */
  readonly openExecuteToolMs: number;
  readonly postToolMs: number;
  readonly thinkMs: number;
  readonly pollMs: number;
};

const DEFAULT_GROK_SILENT_TURN_WATCHDOG: GrokSilentTurnWatchdogConfig = {
  killOpenToolsOnSilence: false,
  openToolMs: GROK_SILENT_OPEN_TOOL_WATCHDOG_MS,
  openExecuteToolMs: GROK_SILENT_OPEN_EXECUTE_TOOL_WATCHDOG_MS,
  postToolMs: GROK_SILENT_POST_TOOL_WATCHDOG_MS,
  thinkMs: GROK_SILENT_THINK_WATCHDOG_MS,
  pollMs: GROK_SILENT_TURN_WATCHDOG_POLL_MS,
};

export type GrokSilentTurnKind = "open-tool" | "post-tool" | "thinking" | null;

/** ACP execute/shell tools may legitimately run long without intermediate updates. */
export function isGrokLongRunningToolKind(kind: string | undefined): boolean {
  return kind === "execute";
}

/**
 * Pick open-tool silence threshold from the kinds of tools still open.
 * Any non-execute open tool keeps the short 90s path; only pure-execute sets
 * use the longer execute ceiling.
 */
export function resolveGrokOpenToolWatchdogMs(input: {
  readonly openToolKinds: ReadonlyArray<string | undefined>;
  readonly thresholds?: Partial<GrokSilentTurnWatchdogConfig>;
}): number {
  const openToolMs = input.thresholds?.openToolMs ?? GROK_SILENT_OPEN_TOOL_WATCHDOG_MS;
  const openExecuteToolMs =
    input.thresholds?.openExecuteToolMs ?? GROK_SILENT_OPEN_EXECUTE_TOOL_WATCHDOG_MS;
  if (input.openToolKinds.length === 0) {
    return openToolMs;
  }
  const allExecute = input.openToolKinds.every((kind) => isGrokLongRunningToolKind(kind));
  return allExecute ? openExecuteToolMs : openToolMs;
}

/**
 * Classify a silent Grok turn for auto-stop.
 *
 * **Open tools are never silence-killed by default.** Quiet tools (long shell,
 * MCP, search) are valid work. User Stop, ACP process death, or hard errors
 * settle the turn; `forceCloseOpenTools` cleans ghost inProgress rows. Opt-in
 * `killOpenToolsOnSilence` keeps the old kill path for tests only.
 *
 * When open-tool kill is enabled, silence uses **tool activity only**
 * (`openToolSilentMs`) so thought/text stream cannot mask a truly stuck tool.
 *
 * Post-tool and pure-think share the long default ceiling (SOU-399): multi-tool
 * planning gaps must not hard-stop after ~2m of token silence while the prompt
 * is still open (and no tool is open).
 */
export function classifyGrokSilentTurn(input: {
  /** Silence since any stream activity (thoughts, text, tools). */
  readonly silentMs: number;
  /**
   * Silence since last tool_call update. Defaults to `silentMs` when omitted
   * (unit tests / callers that do not track a separate tool clock).
   */
  readonly openToolSilentMs?: number;
  readonly openToolCount: number;
  /**
   * Kinds of currently open tools (one entry per open toolCallId). Used to
   * choose short vs execute open-tool thresholds when kill is enabled.
   */
  readonly openToolKinds?: ReadonlyArray<string | undefined>;
  readonly hasObservedToolCall: boolean;
  readonly thresholds?: Partial<GrokSilentTurnWatchdogConfig>;
}): GrokSilentTurnKind {
  const postToolMs = input.thresholds?.postToolMs ?? GROK_SILENT_POST_TOOL_WATCHDOG_MS;
  const thinkMs = input.thresholds?.thinkMs ?? GROK_SILENT_THINK_WATCHDOG_MS;
  const openToolSilentMs = input.openToolSilentMs ?? input.silentMs;
  const killOpenToolsOnSilence =
    input.thresholds?.killOpenToolsOnSilence ??
    DEFAULT_GROK_SILENT_TURN_WATCHDOG.killOpenToolsOnSilence;

  if (input.openToolCount > 0) {
    // Product default: never auto-stop while a tool is still open.
    if (!killOpenToolsOnSilence) {
      return null;
    }
    const kinds =
      input.openToolKinds ??
      // Unknown kinds → short threshold (safer for stuck MCP when kill is on).
      Array.from({ length: input.openToolCount }, () => undefined);
    const openToolMs = resolveGrokOpenToolWatchdogMs({
      openToolKinds: kinds,
      thresholds: input.thresholds,
    });
    if (openToolSilentMs >= openToolMs) {
      return "open-tool";
    }
    return null;
  }
  if (input.hasObservedToolCall && input.silentMs >= postToolMs) {
    return "post-tool";
  }
  if (!input.hasObservedToolCall && input.silentMs >= thinkMs) {
    return "thinking";
  }
  return null;
}

const GROK_SILENT_WORK_SUMMARY_MAX_TOOLS = 6;
/** Keep native stream-delta logs small but still greppable in tests/forensics. */
const GROK_NATIVE_STREAM_DELTA_PREVIEW_CHARS = 160;

/**
 * Slim native log body for ContentDelta / ThoughtDelta.
 * Preserves a short text preview (for dogfood grepping) without serializing full
 * ACP payloads on every token.
 */
export function slimGrokStreamDeltaNativeLog(
  kind: "ContentDelta" | "ThoughtDelta",
  rawPayload: unknown,
): Record<string, unknown> {
  const preview = extractGrokStreamDeltaTextPreview(
    rawPayload,
    GROK_NATIVE_STREAM_DELTA_PREVIEW_CHARS,
  );
  return {
    kind,
    note: "high-frequency stream delta (payload slimmed)",
    ...(preview !== undefined ? { textPreview: preview } : {}),
  };
}

function extractGrokStreamDeltaTextPreview(
  rawPayload: unknown,
  maxChars: number,
): string | undefined {
  if (rawPayload === null || typeof rawPayload !== "object") {
    return undefined;
  }
  const asRecord = rawPayload as Record<string, unknown>;
  const candidates: unknown[] = [asRecord];
  if (asRecord.update !== undefined) {
    candidates.push(asRecord.update);
  }
  if (
    asRecord.update !== null &&
    typeof asRecord.update === "object" &&
    "content" in (asRecord.update as object)
  ) {
    candidates.push((asRecord.update as { content?: unknown }).content);
  }
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const text = (candidate as { text?: unknown; content?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
    }
    const content = (candidate as { content?: unknown }).content;
    if (typeof content === "string" && content.length > 0) {
      return content.length <= maxChars ? content : `${content.slice(0, maxChars)}…`;
    }
    if (content !== null && typeof content === "object" && "text" in content) {
      const nested = (content as { text?: unknown }).text;
      if (typeof nested === "string" && nested.length > 0) {
        return nested.length <= maxChars ? nested : `${nested.slice(0, maxChars)}…`;
      }
    }
  }
  // Fallback: search JSON string for short runs (tests emit plain "late after cancel").
  try {
    const encoded = JSON.stringify(rawPayload);
    if (typeof encoded === "string" && encoded.length > 0 && encoded.length <= maxChars * 2) {
      const textMatch = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(encoded);
      if (textMatch?.[1]) {
        const unescaped = textMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        return unescaped.length <= maxChars ? unescaped : `${unescaped.slice(0, maxChars)}…`;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Format completed tool titles for auto-stop recovery copy (no CoT). */
export function formatGrokSilentTurnWorkSummary(
  completedToolTitles: ReadonlyArray<string>,
): string | undefined {
  const titles = completedToolTitles
    .map((title) => title.trim())
    .filter((title) => title.length > 0);
  if (titles.length === 0) {
    return undefined;
  }
  const shown = titles.slice(-GROK_SILENT_WORK_SUMMARY_MAX_TOOLS);
  const omitted = titles.length - shown.length;
  const list = shown.join("; ");
  const omittedSuffix = omitted > 0 ? ` (+${omitted} earlier)` : "";
  return `Work before stop: ${list}${omittedSuffix}.`;
}

export function buildGrokSilentTurnStopMessage(input: {
  readonly silentTurnKind: Exclude<GrokSilentTurnKind, null>;
  readonly silentMs: number;
  readonly toolLabel?: string;
  readonly completedToolTitles?: ReadonlyArray<string>;
}): string {
  const toolLabel = input.toolLabel?.trim() || "a tool";
  const seconds = Math.max(1, Math.round(input.silentMs / 1000));
  const minutes = Math.max(1, Math.round(input.silentMs / 60_000));
  let base: string;
  if (input.silentTurnKind === "open-tool") {
    base = `Grok went silent for ${seconds}s while ${toolLabel} was still running. Turn was stopped automatically — try a smaller task or Send again.`;
  } else if (input.silentTurnKind === "post-tool") {
    base = `Grok stopped responding after its last tool completed. The turn was stopped automatically after ${seconds}s with no progress — Send again to continue.`;
  } else {
    base = `Grok went silent for ${minutes}+ minutes with no tools or stream updates. Turn was stopped automatically — try again.`;
  }
  const workSummary = formatGrokSilentTurnWorkSummary(input.completedToolTitles ?? []);
  return workSummary ? `${base} ${workSummary}` : base;
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
  /** Test-only overrides for silence auto-stop timings. */
  readonly silentTurnWatchdog?: Partial<GrokSilentTurnWatchdogConfig>;
  /** Override pending permission auto-cancel (default 3 minutes). */
  readonly pendingApprovalTimeoutMs?: number;
  /** Override pending user-input auto-cancel (default 5 minutes). */
  readonly pendingUserInputTimeoutMs?: number;
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
  /**
   * Reasoning effort the ACP child was spawned with (`grok agent --reasoning-effort`).
   * Changing effort requires recycling the process (not a mid-session config option).
   */
  currentReasoningEffort: GrokReasoningEffort;
  stopped: boolean;
  /**
   * Set after Stop force-cancels a prompt. The ACP child may still be wedged;
   * the next sendTurn recycles the process before prompting so follow-ups
   * cannot black-hole.
   */
  acpCompromised: boolean;
  /**
   * Whether this ACP process was spawned with Toolport MCP injected.
   * Settings toggles update process.env; long-lived children must recycle
   * when this no longer matches {@link McpProviderSession.isToolportMcpInjectionEnabled}.
   */
  injectsToolportMcp: boolean;
  /**
   * Visible assistant/tool stream events observed for the active turn. Used to
   * detect silent end_turn completions that leave the session looking dead.
   */
  turnVisibleUpdateCount: number;
  /** Wall-clock ms of the last ACP stream/tool event for the active turn. */
  lastTurnActivityAtMs: number;
  /**
   * Wall-clock ms of the last tool_call update only. Used for open-tool
   * watchdog so thought/text stream cannot mask a stuck tool.
   */
  lastToolActivityAtMs: number;
  /** Open toolCallIds still pending/inProgress for the active turn. */
  openToolCallIds: Set<string>;
  /** Titles for open tools (force-close + errors). */
  openToolTitles: Map<string, string>;
  /** ACP tool kinds for open tools (execute vs short-timeout tools). */
  openToolKinds: Map<string, string | undefined>;
  /** Whether the active prompt has entered a tool loop, including completed tools. */
  hasObservedToolCall: boolean;
  /** Best-effort title of the most recent open tool (for logs / errors). */
  lastOpenToolTitle: string | undefined;
  /**
   * Completed/failed tool titles for the active turn (checkpoint on auto-stop).
   * Capped in the formatter; order is completion order.
   */
  completedToolTitles: string[];
  /**
   * User-facing reason when the silence watchdog (or equivalent) auto-stops a
   * turn. Must be settled into turn.completed even if cancel makes the prompt
   * RPC return success first — otherwise the UI stays on Working forever.
   */
  silentTurnStopMessage: string | undefined;
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

export type GrokConversationTurn = ConversationHistoryTurn;

/** Append streamed/user text into a role-merged conversation log. Exported for tests. */
export function appendGrokConversationText(
  log: ReadonlyArray<GrokConversationTurn>,
  role: GrokConversationTurn["role"],
  text: string,
): Array<GrokConversationTurn> {
  return appendConversationHistoryText(log, role, text);
}

/**
 * Build a prompt prefix that restores Studio-known history when the provider
 * session could not be resumed. Exported for tests.
 */
export function buildGrokContextRehydrationPrefix(
  log: ReadonlyArray<GrokConversationTurn>,
  maxChars = GROK_CONTEXT_REHYDRATION_MAX_CHARS,
  toolSummaries?: ReadonlyArray<string>,
): string | undefined {
  return buildConversationRehydrationPrefix(log, {
    maxChars,
    reason:
      "The previous Grok provider session was interrupted and could not be resumed (common after Stop, app restart, or update).",
    ...(toolSummaries !== undefined && toolSummaries.length > 0 ? { toolSummaries } : {}),
  });
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
 * Delegates to the shared turn-engine steer policy (SOU-428).
 */
export function canSteerGrokSendTurn(input: {
  readonly promptsInFlight: number;
  readonly activeTurnId: TurnId | undefined;
  readonly interruptedTurnIds: ReadonlySet<TurnId>;
}): boolean {
  return canSteerSendTurn({
    promptsInFlight: input.promptsInFlight,
    hasActiveTurnId: input.activeTurnId !== undefined,
    activeTurnInterrupted:
      input.activeTurnId !== undefined && input.interruptedTurnIds.has(input.activeTurnId),
  });
}

/**
 * Engine-owned disposition for a Grok send that may land while a turn is live.
 *
 * Composes local steer eligibility (prompt slots + interrupted ids) with the
 * shared TurnQueue + capability matrix. Grok currently declares
 * `sendWhileRunning: "steer"`, so the live path is steer; `queued` is refused
 * until drain is wired.
 */
export function resolveGrokSendDisposition(input: {
  readonly promptsInFlight: number;
  readonly activeTurnId: TurnId | undefined;
  readonly interruptedTurnIds: ReadonlySet<TurnId>;
  readonly nextTurn: QueuedTurnInput;
}): SendDisposition {
  const canSteer = canSteerGrokSendTurn({
    promptsInFlight: input.promptsInFlight,
    activeTurnId: input.activeTurnId,
    interruptedTurnIds: input.interruptedTurnIds,
  });
  if (!canSteer || input.activeTurnId === undefined) {
    return { _tag: "start-new" };
  }

  let queue = beginTurn(emptyTurnQueue(), String(input.activeTurnId));
  queue = markTurnRunning(queue);
  return disposeSendWhileRunning(queue, {
    sendWhileRunning: PROVIDER_TURN_CAPABILITIES.grok.sendWhileRunning,
    nextTurn: input.nextTurn,
  }).disposition;
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const silentTurnWatchdog: GrokSilentTurnWatchdogConfig = {
      killOpenToolsOnSilence:
        options?.silentTurnWatchdog?.killOpenToolsOnSilence ??
        DEFAULT_GROK_SILENT_TURN_WATCHDOG.killOpenToolsOnSilence,
      openToolMs:
        options?.silentTurnWatchdog?.openToolMs ?? DEFAULT_GROK_SILENT_TURN_WATCHDOG.openToolMs,
      openExecuteToolMs:
        options?.silentTurnWatchdog?.openExecuteToolMs ??
        DEFAULT_GROK_SILENT_TURN_WATCHDOG.openExecuteToolMs,
      postToolMs:
        options?.silentTurnWatchdog?.postToolMs ?? DEFAULT_GROK_SILENT_TURN_WATCHDOG.postToolMs,
      thinkMs: options?.silentTurnWatchdog?.thinkMs ?? DEFAULT_GROK_SILENT_TURN_WATCHDOG.thinkMs,
      pollMs: options?.silentTurnWatchdog?.pollMs ?? DEFAULT_GROK_SILENT_TURN_WATCHDOG.pollMs,
    };
    const pendingApprovalTimeoutMs =
      options?.pendingApprovalTimeoutMs ?? GROK_PENDING_APPROVAL_TIMEOUT_MS;
    const pendingUserInputTimeoutMs =
      options?.pendingUserInputTimeoutMs ?? GROK_PENDING_USER_INPUT_TIMEOUT_MS;
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

    /**
     * When a turn ends (Stop, silence watchdog, failure, or completion) any
     * tool still pending/inProgress must be force-closed. Otherwise the work
     * log leaves ghost "Tool" rows forever — looks like tools are stuck even
     * after the turn is dead.
     */
    const forceCloseOpenTools = (ctx: GrokSessionContext, threadId: ThreadId, turnId: TurnId) =>
      Effect.gen(function* () {
        if (ctx.openToolCallIds.size === 0) {
          return;
        }
        const stamp = yield* makeEventStamp();
        const openIds = [...ctx.openToolCallIds];
        for (const toolCallId of openIds) {
          const kind = ctx.openToolKinds.get(toolCallId);
          const rawTitle =
            ctx.openToolTitles.get(toolCallId)?.trim() || ctx.lastOpenToolTitle?.trim() || "";
          // Prefer a real title; if we only stored the wire kind ("execute"),
          // leave title empty so makeAcpToolCallEvent maps kind → "Running command".
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
          ctx.completedToolTitles.push(`${title ?? kind ?? "tool"} (stopped)`);
        }
        ctx.openToolCallIds.clear();
        ctx.openToolTitles.clear();
        ctx.openToolKinds.clear();
        ctx.lastOpenToolTitle = undefined;
      });

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
          // Stop/watchdog must still force ready + emit a terminal event when
          // the live turn id already moved. Otherwise orchestration keeps
          // session.status=running and Stop looks like a no-op in the UI.
          const forceTerminalOnInterrupt =
            options?.settleAllPrompts === true &&
            options?.emitTurnCompletion !== false &&
            (options?.errorMessage !== undefined || options?.completedStopReason !== undefined);
          if (forceTerminalOnInterrupt) {
            const wasLive =
              liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
            // Only emit when still live. A second settle after Stop already
            // forced ready must not double-fire turn.completed.
            if (!wasLive) {
              return;
            }
            const updatedAt = yield* nowIso;
            const { activeTurnId: _cleared, ...readySession } = liveCtx.session;
            liveCtx.activeTurnId = undefined;
            liveCtx.session = {
              ...readySession,
              status: "ready",
              updatedAt,
            };
            yield* forceCloseOpenTools(liveCtx, threadId, turnId);
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
            return;
          }
          // Non-interrupt late settlement for a non-live turn: skip quietly.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            yield* forceCloseOpenTools(liveCtx, threadId, turnId);
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
          // Still close open tools so a suppressed completion cannot leave
          // ghost inProgress rows after Stop/watchdog.
          yield* forceCloseOpenTools(liveCtx, threadId, settleTurnId);
          return;
        }
        // Close tools before the terminal turn event so the UI never paints
        // Working + inProgress tool after the turn is already dead.
        yield* forceCloseOpenTools(liveCtx, threadId, settleTurnId);
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

    /**
     * Finish an interrupted turn. Silence-watchdog auto-stops must always emit
     * turn.completed (failed) even when cancel makes the prompt RPC return
     * success first — otherwise the UI stays on Working forever.
     * User Stop already settles via interruptTurn; this is then a safe no-op.
     */
    const settleInterruptedPrompt = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      ctx: GrokSessionContext,
    ) =>
      Effect.gen(function* () {
        const silenceMessage = ctx.silentTurnStopMessage;
        if (silenceMessage) {
          yield* settlePromptInFlight(threadId, turnId, expectedAcpSessionId, {
            errorMessage: silenceMessage,
            settleAllPrompts: true,
          });
          ctx.silentTurnStopMessage = undefined;
          return { _tag: "silence" as const, message: silenceMessage };
        }
        // User Stop / external interrupt: interruptTurn should already have
        // settled. Re-settle only if the turn is still active.
        if (
          ctx.activeTurnId === turnId ||
          ctx.session.activeTurnId === turnId ||
          ctx.session.status === "running" ||
          ctx.session.status === "connecting"
        ) {
          yield* settlePromptInFlight(threadId, turnId, expectedAcpSessionId, {
            completedStopReason: "cancelled",
            settleAllPrompts: true,
          });
        }
        return { _tag: "cancelled" as const };
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
                  const raceResult = yield* Effect.raceFirst(
                    Deferred.await(resolution).pipe(
                      Effect.map((value) => ({ _tag: "answered" as const, value })),
                    ),
                    Effect.sleep(`${pendingUserInputTimeoutMs} millis`).pipe(
                      Effect.as({ _tag: "timeout" as const }),
                    ),
                  );
                  const resolved: PendingUserInputResolution =
                    raceResult._tag === "timeout" ? { _tag: "cancelled" } : raceResult.value;
                  if (raceResult._tag === "timeout") {
                    yield* Deferred.succeed(resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
                    yield* Effect.logWarning("Grok user-input request timed out; auto-cancelled", {
                      threadId: input.threadId,
                      requestId,
                      timeoutMs: pendingUserInputTimeoutMs,
                    });
                    yield* offerRuntimeEvent({
                      type: "runtime.warning",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: {
                        message: `User input timed out after ${Math.round(pendingUserInputTimeoutMs / 1000)}s with no answer. Request was cancelled automatically.`,
                      },
                    });
                  }
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
                yield* Effect.logWarning("Grok approval request timed out; auto-cancelled", {
                  threadId: input.threadId,
                  requestId,
                  timeoutMs: pendingApprovalTimeoutMs,
                });
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
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
            // High-frequency text/thought deltas are not written to the native
            // event log at all. Even slim previews still serialize + fsync on
            // every token and starve multi-session UI under disk IO. Keep
            // tool/plan updates only (lower rate, high debug value).
            if (event._tag === "PlanUpdated" || event._tag === "ToolCallUpdated") {
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
                ctx.lastToolActivityAtMs = yield* Clock.currentTimeMillis;
                const toolCallId = event.toolCall.toolCallId;
                const toolStatus = event.toolCall.status;
                const toolKind = event.toolCall.kind;
                if (toolStatus === "completed" || toolStatus === "failed") {
                  ctx.openToolCallIds.delete(toolCallId);
                  const finishedTitle =
                    event.toolCall.title?.trim() ||
                    ctx.openToolTitles.get(toolCallId) ||
                    ctx.lastOpenToolTitle ||
                    event.toolCall.kind ||
                    "tool";
                  ctx.openToolTitles.delete(toolCallId);
                  ctx.openToolKinds.delete(toolCallId);
                  ctx.completedToolTitles.push(
                    toolStatus === "failed" ? `${finishedTitle} (failed)` : finishedTitle,
                  );
                  if (ctx.openToolCallIds.size === 0) {
                    ctx.lastOpenToolTitle = undefined;
                  }
                } else if (
                  toolStatus === "pending" ||
                  toolStatus === "inProgress" ||
                  // Grok sometimes omits status on the first tool_call; still track.
                  toolStatus === undefined
                ) {
                  ctx.openToolCallIds.add(toolCallId);
                  if (toolKind !== undefined || !ctx.openToolKinds.has(toolCallId)) {
                    ctx.openToolKinds.set(
                      toolCallId,
                      toolKind ?? ctx.openToolKinds.get(toolCallId),
                    );
                  }
                  const title = event.toolCall.title?.trim();
                  if (title) {
                    ctx.lastOpenToolTitle = title;
                    ctx.openToolTitles.set(toolCallId, title);
                  } else if (!ctx.openToolTitles.has(toolCallId)) {
                    const fallback = event.toolCall.kind ?? ctx.lastOpenToolTitle ?? "tool";
                    ctx.openToolTitles.set(toolCallId, fallback);
                    if (!ctx.lastOpenToolTitle) {
                      ctx.lastOpenToolTitle = fallback;
                    }
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
              reasoningEffort: ctx.currentReasoningEffort,
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
        const recycleNow = yield* Clock.currentTimeMillis;
        ctx.lastTurnActivityAtMs = recycleNow;
        ctx.lastToolActivityAtMs = recycleNow;
        ctx.openToolCallIds = new Set();
        ctx.openToolTitles = new Map();
        ctx.openToolKinds = new Map();
        ctx.hasObservedToolCall = false;
        ctx.lastOpenToolTitle = undefined;
        ctx.completedToolTitles = [];
        ctx.silentTurnStopMessage = undefined;
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
        ctx.injectsToolportMcp = injectsToolportGateway;
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
          const startReasoningEffort = resolveGrokReasoningEffort(grokModelSelection);
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(grokEnvironment ? { environment: grokEnvironment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            reasoningEffort: startReasoningEffort,
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
            currentReasoningEffort: startReasoningEffort,
            stopped: false,
            acpCompromised: false,
            injectsToolportMcp: injectsToolportGateway,
            turnVisibleUpdateCount: 0,
            lastTurnActivityAtMs: yield* Clock.currentTimeMillis,
            lastToolActivityAtMs: yield* Clock.currentTimeMillis,
            openToolCallIds: new Set(),
            openToolTitles: new Map(),
            openToolKinds: new Map(),
            hasObservedToolCall: false,
            lastOpenToolTitle: undefined,
            completedToolTitles: [],
            silentTurnStopMessage: undefined,
            notificationGeneration: 0,
            acpDisposed: false,
            conversationLog: [],
            // True resume keeps Grok's own history. session/new (cold start,
            // failed load, no resume cursor) needs Studio rehydration on the
            // next prompt if the thread has projected messages.
            needsContextRehydration: !started.resumedExistingSession,
          };

          ctx.notificationFiber = yield* startNotificationFiber(ctx);
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          if (ctx.needsContextRehydration) {
            yield* Effect.logInfo(
              "Grok session started without native resume; Studio history rehydration armed",
              {
                threadId: input.threadId,
                hadResumeCursor: resumeSessionId !== undefined,
                sessionId: started.sessionId,
              },
            );
          }

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
            const turnModelSelectionForEffort =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const requestedReasoningEffort = resolveGrokReasoningEffort(
              turnModelSelectionForEffort,
            );
            // Reasoning effort is a spawn-time CLI flag; recycle when it changes
            // so the next prompt runs at the level the user selected.
            if (
              turnModelSelectionForEffort !== undefined &&
              requestedReasoningEffort !== ctx.currentReasoningEffort
            ) {
              yield* Effect.logInfo("Grok reasoning effort changed; recycling ACP process", {
                threadId: input.threadId,
                from: ctx.currentReasoningEffort,
                to: requestedReasoningEffort,
              });
              ctx.currentReasoningEffort = requestedReasoningEffort;
              ctx.acpCompromised = true;
            }
            // Toolport MCP is also spawn-time (ACP mcpServers). Settings toggles
            // update process.env immediately; existing children must recycle so
            // Linear/etc become available without starting a brand-new thread.
            const wantsToolportMcp = McpProviderSession.isToolportMcpInjectionEnabled(
              options?.environment ?? process.env,
            );
            if (wantsToolportMcp !== ctx.injectsToolportMcp) {
              yield* Effect.logInfo("Grok Toolport MCP setting changed; recycling ACP process", {
                threadId: input.threadId,
                from: ctx.injectsToolportMcp,
                to: wantsToolportMcp,
              });
              ctx.acpCompromised = true;
            }
            // After Stop (or silent empty end_turn) the child may be wedged.
            // Recycle before any new work so turns cannot black-hole.
            if (ctx.acpCompromised) {
              yield* recycleCompromisedAcp(ctx);
            }
            // A sendTurn while a live (non-interrupted) prompt is in flight is a
            // steer: the agent folds the new prompt into the ongoing work.
            // Never reuse a turn that Stop/watchdog already cancelled — that is
            // the "next message after Stop always errors" race.
            // Disposition is engine-owned (SOU-428 TurnQueue + capabilities).
            const liveActiveTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            const nextTurnId = TurnId.make(yield* randomUUIDv4);
            const disposition = resolveGrokSendDisposition({
              promptsInFlight: ctx.promptsInFlight,
              activeTurnId: liveActiveTurnId,
              interruptedTurnIds: ctx.interruptedTurnIds,
              nextTurn: {
                id: String(nextTurnId),
                text: typeof input.input === "string" ? input.input : "",
                enqueuedAtMs: yield* Clock.currentTimeMillis,
              },
            });
            if (disposition._tag === "queued") {
              // Capability matrix must not declare queue until drain is wired.
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue:
                  "Grok turn queue drain is not implemented; sendWhileRunning must not be queue.",
              });
            }
            const steeringTurnId = disposition._tag === "steer" ? liveActiveTurnId : undefined;
            if (steeringTurnId === undefined && (ctx.promptsInFlight > 0 || liveActiveTurnId)) {
              // Drop residual slots/ids from a cancelled or half-settled turn so
              // follow-up preparation starts clean.
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
            }
            const turnId = steeringTurnId ?? nextTurnId;
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            if (steeringTurnId === undefined) {
              ctx.turnVisibleUpdateCount = 0;
              ctx.lastPlanFingerprint = undefined;
            }
            // Surface live chrome before set_model / attachment IO (can take
            // seconds). Preparation failure settles via the tapCause below.
            const provisionalModel =
              input.modelSelection?.instanceId === boundInstanceId && input.modelSelection.model
                ? resolveGrokAcpBaseModelId(input.modelSelection.model)
                : ctx.currentModelId
                  ? resolveGrokAcpBaseModelId(ctx.currentModelId)
                  : undefined;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(provisionalModel ? { model: provisionalModel } : {}),
            };
            if (steeringTurnId === undefined) {
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: provisionalModel ? { model: provisionalModel } : {},
              });
            }

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
              // When Stop/cold-start forced a blank session/new, inject Studio
              // history so Grok still has prior turns (session/load often Path
              // not found; in-memory log is empty after app restart).
              if (
                steeringTurnId === undefined &&
                ctx.needsContextRehydration &&
                ctx.conversationLog.length === 0 &&
                input.conversationHistory !== undefined &&
                input.conversationHistory.length > 0
              ) {
                ctx.conversationLog = input.conversationHistory.map((turn) => ({
                  role: turn.role,
                  text: turn.text,
                }));
              }
              const rehydrationPrefix =
                steeringTurnId === undefined && ctx.needsContextRehydration
                  ? buildGrokContextRehydrationPrefix(
                      ctx.conversationLog,
                      GROK_CONTEXT_REHYDRATION_MAX_CHARS,
                      input.recentToolSummaries,
                    )
                  : undefined;
              const usesContextRehydration = rehydrationPrefix !== undefined;
              // Mid-turn framing is decided once in the turn engine (SOU-428).
              // Default is raw user text so additive constraints do not destroy
              // long-running work.
              const steeredText =
                text !== undefined && text.length > 0
                  ? formatInterjectionText({
                      userText: text,
                      isSteering: steeringTurnId !== undefined,
                    })
                  : text;
              const promptText =
                steeredText && rehydrationPrefix
                  ? `${rehydrationPrefix}${steeredText}`
                  : rehydrationPrefix
                    ? `${rehydrationPrefix}(continue)`
                    : steeredText;
              // Always record raw user text (no lead-in), including mid-turn
              // steers, so resume/rehydration keep the interjection they sent.
              if (text) {
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
                // turn.started already fired; emit cancelled so Working settles.
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: true,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
                usesContextRehydration,
                isSteering: steeringTurnId !== undefined,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  // turn.started already fired above — always emit terminal
                  // completion so Working cannot stick after prep failure.
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: true,
                    settleAllPrompts: true,
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
          // Force-closing open tools on steer destroys real in-flight work to
          // paper over projection ghosts (SOU-428). Only clear tool tracking on
          // a brand-new turn, or when policy explicitly allows close-on-steer.
          const activityCtx = sessions.get(input.threadId);
          if (activityCtx) {
            const closeOpenTools = !prepared.isSteering || shouldForceCloseOpenToolsOnSteer();
            if (closeOpenTools && activityCtx.openToolCallIds.size > 0) {
              yield* forceCloseOpenTools(activityCtx, input.threadId, prepared.turnId);
            }
            const activityNow = yield* Clock.currentTimeMillis;
            activityCtx.lastTurnActivityAtMs = activityNow;
            activityCtx.lastToolActivityAtMs = activityNow;
            if (closeOpenTools) {
              activityCtx.openToolCallIds = new Set();
              activityCtx.openToolTitles = new Map();
              activityCtx.openToolKinds = new Map();
              activityCtx.hasObservedToolCall = false;
              activityCtx.lastOpenToolTitle = undefined;
              activityCtx.completedToolTitles = [];
            }
            activityCtx.silentTurnStopMessage = undefined;
          }

          const silenceWatchdog = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(`${silentTurnWatchdog.pollMs} millis`);
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
              const nowMs = yield* Clock.currentTimeMillis;
              const silentMs = nowMs - live.lastTurnActivityAtMs;
              const openToolSilentMs = nowMs - live.lastToolActivityAtMs;
              const openToolCount = live.openToolCallIds.size;
              const openToolKinds = [...live.openToolKinds.values()];
              const silentTurnKind = classifyGrokSilentTurn({
                silentMs,
                openToolSilentMs,
                openToolCount,
                openToolKinds,
                hasObservedToolCall: live.hasObservedToolCall,
                thresholds: silentTurnWatchdog,
              });
              if (silentTurnKind === null) {
                continue;
              }
              const watchdogSilentMs = silentTurnKind === "open-tool" ? openToolSilentMs : silentMs;
              const detail = buildGrokSilentTurnStopMessage({
                silentTurnKind,
                silentMs: watchdogSilentMs,
                toolLabel: live.lastOpenToolTitle,
                completedToolTitles: live.completedToolTitles,
              });
              yield* Effect.logWarning("Grok silent-turn watchdog fired", {
                threadId: input.threadId,
                turnId: prepared.turnId,
                silentMs,
                openToolSilentMs,
                openToolCount,
                openToolKinds,
                openToolWatchdogMs: resolveGrokOpenToolWatchdogMs({
                  openToolKinds,
                  thresholds: silentTurnWatchdog,
                }),
                hasObservedToolCall: live.hasObservedToolCall,
                silentTurnKind,
                lastOpenToolTitle: live.lastOpenToolTitle,
              });
              // Persist before cancel: cancel often completes the prompt RPC
              // successfully first, so the success path must still settle with
              // this message (zombie Working bug).
              live.silentTurnStopMessage = detail;
              live.acpCompromised = true;
              live.interruptedTurnIds.add(prepared.turnId);
              yield* live.acp.cancel.pipe(Effect.timeout("2 seconds"), Effect.ignore);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail,
              });
            }
          });

          // Full interjection loop (not a soft queue):
          // 1) Preempt the in-flight session/prompt (ACP serializes prompts).
          // 2) Send the new prompt on the same Studio turn.
          // Synthetic "Following up" chrome is intentionally not emitted —
          // silence beats invention (turn-engine InterjectionPolicy).
          if (prepared.isSteering) {
            const liveForSteer = sessions.get(input.threadId);
            if (liveForSteer) {
              const nowMs = yield* Clock.currentTimeMillis;
              liveForSteer.lastTurnActivityAtMs = nowMs;
              liveForSteer.lastToolActivityAtMs = nowMs;
              liveForSteer.turnVisibleUpdateCount += 1;
            }
            yield* prepared.acp.preemptActivePrompt;
            if (shouldEmitSyntheticFollowUpChrome()) {
              const textPart = prepared.promptParts.find(
                (part) => part && typeof part === "object" && part.type === "text",
              );
              const raw =
                textPart && "text" in textPart && typeof textPart.text === "string"
                  ? textPart.text.trim()
                  : "";
              const preview =
                raw.length === 0
                  ? "new message"
                  : raw.length > 96
                    ? `${raw.slice(0, 95).trimEnd()}…`
                    : raw;
              yield* offerRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: {
                  message: `Following up: ${preview}`,
                },
              });
            }
          }

          // When the silence watchdog wins, prefer a controlled settle over
          // failing the whole sendTurn: the UI keys off turn.completed failed.
          // Cancel often completes the prompt RPC successfully first; the
          // success path settles via interruptedTurnIds + silentTurnStopMessage.
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
                  error instanceof Error
                    ? // Prefer detail for tagged adapter errors (user-facing copy).
                      "detail" in error && typeof error.detail === "string"
                      ? error.detail
                      : error.message
                    : String(error),
                ),
              ),
              // Convert watchdog failure into a cancelled prompt result so the
              // success settle path emits turn.completed and sendTurn returns.
              Effect.catch(() =>
                Effect.succeed({ stopReason: "cancelled" } as EffectAcpSchema.PromptResponse),
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
              // Interrupted (Stop or silence watchdog): always settle. Cancel
              // often completes the prompt RPC successfully first; returning
              // here without settle left the UI on Working for minutes.
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                // Emit turn.completed (failed for silence, cancelled for Stop)
                // then return success so sendTurn does not double-report via the
                // reactor recovery path. Events drive UI readiness.
                yield* settleInterruptedPrompt(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  ctx,
                );
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
                yield* settleInterruptedPrompt(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  ctx,
                );
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
                  yield* settleInterruptedPrompt(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    ctx,
                  );
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
                // Agent end_turn without tool completion still leaves open tools
                // in the work log unless we force-close them here.
                yield* forceCloseOpenTools(ctx, input.threadId, prepared.turnId);
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
                  // Same contract as Cursor: pure capacity/quota dumps as assistant
                  // text + end_turn must not settle as successful replies.
                  const lastAssistantText = (() => {
                    for (let index = ctx.conversationLog.length - 1; index >= 0; index -= 1) {
                      const entry = ctx.conversationLog[index];
                      if (entry?.role === "assistant") {
                        return entry.text;
                      }
                    }
                    return "";
                  })();
                  const emittedFailure = cancelled
                    ? undefined
                    : classifyProviderEmittedFailure(lastAssistantText);
                  if (emittedFailure) {
                    const message = formatProviderEmittedFailureMessage(emittedFailure, {
                      providerLabel: "Grok",
                      model: prepared.displayModel,
                    });
                    yield* Effect.logWarning("Grok turn completed with provider-emitted failure", {
                      threadId: input.threadId,
                      turnId: prepared.turnId,
                      code: emittedFailure.code,
                      model: prepared.displayModel,
                    });
                    yield* offerRuntimeEvent({
                      type: "runtime.error",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: prepared.turnId,
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
                      turnId: prepared.turnId,
                      payload: {
                        state: "failed",
                        stopReason: completedStopReason,
                        errorMessage: message,
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
                      // Silence watchdog often loses the race to a successful
                      // cancelled prompt RPC; still emit turn.completed failed.
                      yield* settleInterruptedPrompt(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        ctx,
                      );
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
                  // Prefer the silence-watchdog copy when present so ensuring
                  // still surfaces a clear auto-stop reason if the race failed.
                  const silenceMessage = ctx?.silentTurnStopMessage;
                  if (ctx && silenceMessage) {
                    yield* settleInterruptedPrompt(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      ctx,
                    );
                    return;
                  }
                  yield* settlePromptInFlight(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    {
                      errorMessage: errorMessage ?? "Grok prompt request failed.",
                      settleAllPrompts: true,
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
              // No turn id to attach to turn.completed — still force ready so a
              // stuck "running" adapter cannot leave the UI unstoppable.
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
