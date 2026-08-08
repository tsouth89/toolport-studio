import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeAgentId,
  type RuntimeAgentStatus,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@toolport-studio/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@toolport-studio/shared/model";
import {
  classifyProviderEmittedFailure,
  formatProviderEmittedFailureMessage,
} from "@toolport-studio/shared/providerError";

import { resolveAttachmentPath, resolveThreadAttachmentDirectory } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import {
  canSteerSendTurn,
  claimTurnSettlement,
  emptyTurnQueue,
  markTurnStopping,
  OPEN_TOOL_FORCE_CLOSE_DETAIL,
  OPEN_TOOL_FORCE_CLOSE_SOURCE,
  shouldForceCloseRemainingOpenToolsOnSettle,
  trackLiveTurn,
  type TurnQueueState,
} from "../turnEngine/index.ts";
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Self-heal windows for requests the user never answers, matching the values the other four
 * adapters already use (Claude, Codex, Cursor, Grok). Without these a `permission.asked` or
 * `question.asked` that nobody answers leaves the turn pending forever, because OpenCode waits on
 * the reply and Studio has nothing else to end the turn.
 *
 * The shape differs from the other adapters: they block a fiber on a `Deferred` and race it
 * against a sleep, whereas OpenCode is event-driven — the request arrives as a server event and
 * the answer goes back through a separate SDK call. So the timer here is a fiber per outstanding
 * request, armed when the request opens and interrupted when it is answered.
 */
const OPENCODE_PENDING_APPROVAL_TIMEOUT_MS = 3 * 60_000;
const OPENCODE_PENDING_USER_INPUT_TIMEOUT_MS = 5 * 60_000;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  return trimText(event.properties.info.title);
}

function openCodeSessionModel(session: Session): string | undefined {
  if (!session.model) {
    return undefined;
  }
  return `${session.model.providerID}/${session.model.id}`;
}

function openCodeAgentLabel(session: Session): string {
  return trimText(session.title) ?? trimText(session.agent) ?? "OpenCode agent";
}

function openCodeChildSessionInfo(event: OpenCodeSubscribedEvent): Session | undefined {
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return event.properties.info;
    default:
      return undefined;
  }
}

type OpenCodeOpenTool = {
  readonly callID: string;
  readonly tool: string;
  readonly title: string;
  readonly itemType: ToolLifecycleItemType;
};

type OpenCodeAgentRun = {
  readonly agentRunId: RuntimeAgentId;
  readonly providerThreadId: string;
  readonly parentAgentRunId: RuntimeAgentId | undefined;
  readonly turnId: TurnId | undefined;
  label: string;
  model: string | undefined;
  message: string | undefined;
  terminal: boolean;
};

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  /**
   * Self-heal timers for outstanding permission/question requests, keyed by request id. Armed
   * when a request opens, interrupted when it is answered or the turn settles.
   */
  readonly pendingRequestTimers: Map<string, Fiber.Fiber<void>>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  /** Tools still pending/running for the live turn (force-closed on settle). */
  readonly openTools: Map<string, OpenCodeOpenTool>;
  /** Native OpenCode child sessions surfaced as inspectable agent runs. */
  readonly agentRunsBySessionId: Map<string, OpenCodeAgentRun>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  /** Turn for which OpenCode has emitted session.status=busy. */
  providerBusyTurnId: TurnId | undefined;
  /** Shared authoritative owner for terminal turn effects (SBS-428). */
  turnLifecycle: TurnQueueState;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * Whether Toolport MCP was added to this OpenCode server for the session.
   * Settings toggles update process.env immediately; mismatch triggers rebind
   * via mcp.add / mcp.disconnect (local servers only).
   */
  injectsToolportMcp: boolean;
  /** MCP server name fingerprint after last add/disconnect. */
  mcpBindingCatalog: string;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

function openCodeMcpConfigFromBinding(binding: McpProviderSession.McpProviderBinding):
  | {
      readonly type: "local";
      // Freshly built per call, and the OpenCode SDK's McpLocalConfig takes a
      // mutable array, so this must not be a ReadonlyArray.
      readonly command: string[];
      readonly environment: Record<string, string>;
    }
  | {
      readonly type: "remote";
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly oauth: false;
    } {
  return binding.transport === "stdio"
    ? {
        type: "local",
        command: [binding.command, ...binding.args],
        environment: { ...binding.env },
      }
    : {
        type: "remote",
        url: binding.url,
        headers: { ...binding.headers },
        oauth: false,
      };
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Overridable so tests can drive the self-heal without waiting minutes. */
  readonly pendingApprovalTimeoutMs?: number;
  readonly pendingUserInputTimeoutMs?: number;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

/**
 * Track open OpenCode tools for force-close on settle. Terminal statuses clear
 * the entry; pending/running keep it. Exported for unit tests.
 */
export function trackOpenCodeOpenTool(
  openTools: Map<string, OpenCodeOpenTool>,
  part: Extract<Part, { type: "tool" }>,
): void {
  if (part.state.status === "completed" || part.state.status === "error") {
    openTools.delete(part.callID);
    return;
  }
  const title = part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
  openTools.set(part.callID, {
    callID: part.callID,
    tool: part.tool,
    title,
    itemType: toToolLifecycleItemType(part.tool),
  });
}

/** Concatenate assistant text parts for settle-time failure classification. */
export function collectOpenCodeAssistantText(context: {
  readonly partById: ReadonlyMap<string, Part>;
  readonly emittedTextByPartId: ReadonlyMap<string, string>;
}): string {
  const chunks: string[] = [];
  for (const part of context.partById.values()) {
    if (part.type !== "text") continue;
    const text =
      context.emittedTextByPartId.get(part.id) ??
      (typeof part.text === "string" ? part.text : undefined) ??
      "";
    if (text.trim().length > 0) {
      chunks.push(text);
    }
  }
  return chunks.join("\n");
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* runOpenCodeSdk("session.abort", () =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }),
  ).pipe(Effect.ignore({ log: true }));

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const pendingApprovalTimeoutMs =
      options?.pendingApprovalTimeoutMs ?? OPENCODE_PENDING_APPROVAL_TIMEOUT_MS;
    const pendingUserInputTimeoutMs =
      options?.pendingUserInputTimeoutMs ?? OPENCODE_PENDING_USER_INPUT_TIMEOUT_MS;
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    /**
     * Take ownership of resolving a request, exactly once.
     *
     * The self-heal timer and the reply handlers both want to resolve the same request, and after
     * a timeout rejects upstream OpenCode echoes the reply back — so without a claim the client
     * sees two resolution events for one request. Membership of the pending map is the mutex, and
     * this check-and-delete is synchronous, so no fiber can interleave between the two halves.
     * Whoever removes the entry owns the emit; the loser stays silent.
     */
    const claimRequest = (
      context: OpenCodeSessionContext,
      requestId: string,
      kind: "approval" | "user-input",
    ): boolean => {
      const pending = kind === "approval" ? context.pendingPermissions : context.pendingQuestions;
      if (!pending.has(requestId)) return false;
      pending.delete(requestId);
      return true;
    };

    /** Disarm the self-heal timer for a request that has been answered by any route. */
    const cancelRequestTimer = Effect.fn("openCode.cancelRequestTimer")(function* (
      context: OpenCodeSessionContext,
      requestId: string,
    ) {
      const timer = context.pendingRequestTimers.get(requestId);
      if (timer === undefined) return;
      context.pendingRequestTimers.delete(requestId);
      yield* Fiber.interrupt(timer).pipe(Effect.ignore);
    });

    /** Disarm every outstanding timer, for turn settle and session teardown. */
    const cancelAllRequestTimers = Effect.fn("openCode.cancelAllRequestTimers")(function* (
      context: OpenCodeSessionContext,
    ) {
      const timers = [...context.pendingRequestTimers.values()];
      context.pendingRequestTimers.clear();
      yield* Effect.forEach(timers, (timer) => Fiber.interrupt(timer).pipe(Effect.ignore), {
        discard: true,
      });
    });

    const settlePendingRequestsAsAborted = Effect.fn("openCode.settlePendingRequestsAsAborted")(
      function* (context: OpenCodeSessionContext, turnId: TurnId | undefined) {
        // Stop owns every still-pending request. Claim them before emitting so a
        // late SDK echo cannot record the same cancellation as a user response.
        yield* cancelAllRequestTimers(context);
        const permissions = [...context.pendingPermissions.entries()];
        const questions = [...context.pendingQuestions.keys()];
        context.pendingPermissions.clear();
        context.pendingQuestions.clear();

        yield* Effect.forEach(
          permissions,
          ([requestId, request]) =>
            buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
            }).pipe(
              Effect.flatMap((base) =>
                emit({
                  ...base,
                  type: "request.resolved",
                  payload: {
                    requestType: mapPermissionToRequestType(request.permission),
                    decision: "cancel",
                    resolvedBy: "aborted",
                  },
                }),
              ),
            ),
          { discard: true },
        );
        yield* Effect.forEach(
          questions,
          (requestId) =>
            buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
            }).pipe(
              Effect.flatMap((base) =>
                emit({
                  ...base,
                  type: "user-input.resolved",
                  payload: { answers: {}, resolvedBy: "aborted" },
                }),
              ),
            ),
          { discard: true },
        );
      },
    );

    /**
     * Arm a self-heal timer for one outstanding request.
     *
     * On expiry this answers OpenCode itself before telling Studio, because OpenCode is a real
     * server blocked on the reply: resolving only our side would settle the turn in the UI and
     * leave the agent waiting. A failure to reach OpenCode is logged and still resolved locally —
     * a wedged request is worse than a mismatched one, and the session is already unhealthy.
     */
    const armRequestTimer = (input: {
      readonly context: OpenCodeSessionContext;
      readonly requestId: string;
      readonly turnId: TurnId | undefined;
      readonly kind: "approval" | "user-input";
    }) =>
      Effect.gen(function* () {
        const { context, requestId, turnId, kind } = input;
        const timeoutMs =
          kind === "approval" ? pendingApprovalTimeoutMs : pendingUserInputTimeoutMs;
        // A repeated `asked` event for the same id would otherwise overwrite the map entry and
        // leave the previous fiber running against a request it no longer owns, where it could
        // win the claim and time the freshly armed request out early. The orphan dies with the
        // session scope either way, but not before doing that.
        yield* cancelRequestTimer(context, requestId);
        const timer = yield* Effect.gen(function* () {
          yield* Effect.sleep(`${timeoutMs} millis`);

          // Claim and read in one synchronous step, before anything can yield. Losing the claim
          // means the user answered, or the turn settled and cleared the maps — either way there
          // is nothing left to heal and nothing to say.
          const claimed = yield* Effect.sync(() => {
            // Only the approval branch reads this, and it lives in the permissions map. Reading it
            // unconditionally would silently hand a `user-input` timeout an undefined it looks
            // entitled to.
            const request =
              kind === "approval" ? context.pendingPermissions.get(requestId) : undefined;
            const won = claimRequest(context, requestId, kind);
            context.pendingRequestTimers.delete(requestId);
            return won ? { request } : undefined;
          });
          if (claimed === undefined) return;

          const seconds = Math.round(timeoutMs / 1000);
          const message =
            kind === "approval"
              ? `Permission request timed out after ${seconds}s with no decision. Request was cancelled automatically.`
              : `User input timed out after ${seconds}s with no answer. Request was cancelled automatically.`;
          yield* Effect.logWarning(`OpenCode ${kind} request timed out; auto-cancelled`, {
            threadId: context.session.threadId,
            requestId,
            timeoutMs,
          });

          if (kind === "approval") {
            const request = claimed.request;
            yield* runOpenCodeSdk("permission.reply", () =>
              context.client.permission.reply({
                requestID: requestId,
                reply: toOpenCodePermissionReply("cancel"),
              }),
            ).pipe(Effect.ignore({ log: true }));
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId,
              })),
              type: "runtime.warning",
              payload: { message },
            });
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                requestId,
              })),
              type: "request.resolved",
              payload: {
                requestType:
                  request === undefined
                    ? "unknown"
                    : mapPermissionToRequestType(request.permission),
                decision: "cancel",
                resolvedBy: "timeout",
              },
            });
            return;
          }

          yield* runOpenCodeSdk("question.reject", () =>
            context.client.question.reject({ requestID: requestId }),
          ).pipe(Effect.ignore({ log: true }));
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
            })),
            type: "runtime.warning",
            payload: { message },
          });
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
            })),
            type: "user-input.resolved",
            payload: { answers: {}, resolvedBy: "timeout" },
          });
        }).pipe(
          // The self-heal is the last line of defence for a wedged request, so a genuine failure
          // must not vanish. Interruption is not a failure though: cancelling this timer is the
          // normal outcome, fired on every answered request and every turn settle, so logging it
          // as a failure would put a warning on the common path.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("OpenCode request self-heal failed", {
                  threadId: context.session.threadId,
                  requestId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.forkIn(context.sessionScope),
        );
        context.pendingRequestTimers.set(requestId, timer);
      }).pipe(
        // Arming runs inside the event pump, so a failure here would take the pump down with it
        // and strand the session mid-stream. The realistic cause is a request arriving as the
        // session scope closes, where there is nothing left to heal anyway — so record it and
        // let the pump carry on.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logDebug("OpenCode could not arm a request self-heal timer", {
                threadId: input.context.session.threadId,
                requestId: input.requestId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

    const emitAgentLifecycle = Effect.fn("emitOpenCodeAgentLifecycle")(function* (
      context: OpenCodeSessionContext,
      agent: OpenCodeAgentRun,
      type: "agent.started" | "agent.updated" | "agent.completed",
      status: RuntimeAgentStatus,
      raw: unknown,
      message?: string,
      createdAt?: string,
    ) {
      if (type === "agent.completed") {
        agent.terminal = true;
      }
      const resolvedMessage = trimText(message) ?? agent.message;
      if (resolvedMessage) {
        agent.message = resolvedMessage;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: agent.turnId,
          createdAt,
          raw,
        })),
        type,
        providerRefs: {
          providerThreadId: agent.providerThreadId,
          agentRunId: agent.agentRunId,
        },
        payload: {
          agentRunId: agent.agentRunId,
          ...(agent.parentAgentRunId ? { parentAgentRunId: agent.parentAgentRunId } : {}),
          providerThreadId: agent.providerThreadId,
          status,
          label: agent.label,
          ...(agent.model ? { model: agent.model } : {}),
          ...(resolvedMessage ? { message: resolvedMessage } : {}),
          canInspectThread: true,
        },
      });
    });

    const upsertOpenCodeAgent = Effect.fn("upsertOpenCodeAgent")(function* (
      context: OpenCodeSessionContext,
      session: Session,
      raw: unknown,
      lifecycle: "created" | "updated",
    ) {
      const existing = context.agentRunsBySessionId.get(session.id);
      const parentAgent = session.parentID
        ? context.agentRunsBySessionId.get(session.parentID)
        : undefined;
      const isDirectChild = session.parentID === context.openCodeSessionId;
      if (!existing && !isDirectChild && !parentAgent) {
        return undefined;
      }

      const agent =
        existing ??
        ({
          agentRunId: RuntimeAgentId.make(session.id),
          providerThreadId: session.id,
          parentAgentRunId: parentAgent?.agentRunId,
          turnId: context.activeTurnId,
          label: openCodeAgentLabel(session),
          model: openCodeSessionModel(session),
          message: undefined,
          terminal: false,
        } satisfies OpenCodeAgentRun);
      agent.label = openCodeAgentLabel(session);
      agent.model = openCodeSessionModel(session) ?? agent.model;
      context.agentRunsBySessionId.set(session.id, agent);

      if (agent.terminal) {
        return agent;
      }
      yield* emitAgentLifecycle(
        context,
        agent,
        existing ? "agent.updated" : "agent.started",
        "running",
        raw,
        undefined,
        isoFromEpochMs(lifecycle === "created" ? session.time.created : session.time.updated),
      );
      return agent;
    });

    const forceCloseOpenCodeAgents = Effect.fn("forceCloseOpenCodeAgents")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      for (const agent of context.agentRunsBySessionId.values()) {
        if (agent.terminal) {
          continue;
        }
        yield* emitAgentLifecycle(
          context,
          agent,
          "agent.completed",
          "stopped",
          {
            source: OPEN_TOOL_FORCE_CLOSE_SOURCE,
            providerThreadId: agent.providerThreadId,
          },
          message,
        );
      }
    });

    /**
     * Force-close tools still pending/running when a turn settles. OpenCode can
     * go idle or abort while a tool part never reaches completed/error, which
     * left ghost inProgress rows in the work log.
     */
    const forceCloseOpenTools = Effect.fn("forceCloseOpenTools")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId | undefined,
    ) {
      if (!shouldForceCloseRemainingOpenToolsOnSettle(context.openTools.size) || !turnId) {
        context.openTools.clear();
        return;
      }
      const open = [...context.openTools.values()];
      context.openTools.clear();
      for (const tool of open) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: tool.callID,
            raw: {
              source: OPEN_TOOL_FORCE_CLOSE_SOURCE,
              toolCallId: tool.callID,
              tool: tool.tool,
            },
          })),
          type: "item.completed",
          payload: {
            itemType: tool.itemType,
            status: "failed",
            title: tool.title,
            detail: OPEN_TOOL_FORCE_CLOSE_DETAIL,
            data: {
              tool: tool.tool,
              forcedClose: true,
            },
          },
        });
      }
    });

    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId =
        context.activeTurnId ??
        (context.turnLifecycle.activeTurnId
          ? TurnId.make(context.turnLifecycle.activeTurnId)
          : undefined);
      const settlement = turnId
        ? claimTurnSettlement(context.turnLifecycle, {
            turnId: String(turnId),
            reason: "error",
            mode: "active-turn-fallback",
          })
        : undefined;
      if (settlement?.claimed) {
        context.turnLifecycle = settlement.state;
      }
      const claimedTurnId = settlement?.claimed ? TurnId.make(settlement.turnId) : turnId;
      sessions.delete(context.session.threadId);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: claimedTurnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      if (settlement?.claimed) {
        yield* forceCloseOpenTools(context, claimedTurnId).pipe(Effect.ignore);
        yield* forceCloseOpenCodeAgents(
          context,
          "OpenCode exited before the child session reported a terminal state.",
        ).pipe(Effect.ignore);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: claimedTurnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* runOpenCodeSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.ignore({ log: true }));
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId = openCodeEventSessionId(event);
      const isRootSession = payloadSessionId === context.openCodeSessionId;
      const childInfo = openCodeChildSessionInfo(event);
      if (childInfo && !isRootSession && event.type !== "session.deleted") {
        yield* upsertOpenCodeAgent(
          context,
          childInfo,
          event,
          event.type === "session.created" ? "created" : "updated",
        );
      }
      const childAgent = payloadSessionId
        ? context.agentRunsBySessionId.get(payloadSessionId)
        : undefined;
      if (!isRootSession && !childAgent) {
        return;
      }

      const turnId = childAgent?.turnId ?? context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: payloadSessionId ?? context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      if (childAgent) {
        switch (event.type) {
          case "session.created":
          case "session.updated":
            break;

          case "session.deleted":
            if (!childAgent.terminal) {
              yield* emitAgentLifecycle(
                context,
                childAgent,
                "agent.completed",
                "stopped",
                event,
                "OpenCode removed the child session.",
                isoFromEpochMs(event.properties.info.time.updated),
              );
            }
            break;

          case "session.status":
            if (childAgent.terminal) {
              break;
            }
            if (event.properties.status.type === "idle") {
              yield* emitAgentLifecycle(context, childAgent, "agent.completed", "completed", event);
            } else {
              yield* emitAgentLifecycle(
                context,
                childAgent,
                "agent.updated",
                "running",
                event,
                event.properties.status.type === "retry"
                  ? event.properties.status.message
                  : undefined,
              );
            }
            break;

          case "session.idle":
            if (!childAgent.terminal) {
              yield* emitAgentLifecycle(context, childAgent, "agent.completed", "completed", event);
            }
            break;

          case "session.error":
            if (!childAgent.terminal) {
              yield* emitAgentLifecycle(
                context,
                childAgent,
                "agent.completed",
                "failed",
                event,
                sessionErrorMessage(event.properties.error),
              );
            }
            break;

          case "message.part.updated": {
            const part = event.properties.part;
            if (part.type === "text") {
              const message = trimText(part.text);
              if (message && !childAgent.terminal) {
                yield* emitAgentLifecycle(
                  context,
                  childAgent,
                  "agent.updated",
                  "running",
                  event,
                  message,
                  part.time ? isoFromEpochMs(part.time.start) : undefined,
                );
              }
              break;
            }
            if (part.type !== "tool") {
              break;
            }
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              providerRefs: {
                providerThreadId: childAgent.providerThreadId,
                agentRunId: childAgent.agentRunId,
              },
              payload: {
                itemType,
                ...(part.state.status === "error"
                  ? { status: "failed" as const }
                  : part.state.status === "completed"
                    ? { status: "completed" as const }
                    : { status: "inProgress" as const }),
                ...(title ? { title } : {}),
                ...(detail ? { detail } : {}),
                data: {
                  tool: part.tool,
                  state: part.state,
                },
              },
            });
            break;
          }

          default:
            break;
        }
        return;
      }

      switch (event.type) {
        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }

        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "tool") {
            trackOpenCodeOpenTool(context.openTools, part);
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail:
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission,
              args: event.properties.metadata,
            },
          });
          yield* armRequestTimer({
            context,
            requestId: event.properties.id,
            turnId,
            kind: "approval",
          });
          break;
        }

        case "permission.replied": {
          // A timeout that already resolved this request rejected it upstream, and OpenCode
          // echoes that back here. Without the claim the client sees two resolutions.
          const owned = claimRequest(context, event.properties.requestID, "approval");
          yield* cancelRequestTimer(context, event.properties.requestID);
          if (!owned) break;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          yield* armRequestTimer({
            context,
            requestId: event.properties.id,
            turnId,
            kind: "user-input",
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          const owned = claimRequest(context, event.properties.requestID, "user-input");
          yield* cancelRequestTimer(context, event.properties.requestID);
          if (!owned) break;
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers, resolvedBy: "user" },
          });
          break;
        }

        case "question.rejected": {
          const owned = claimRequest(context, event.properties.requestID, "user-input");
          yield* cancelRequestTimer(context, event.properties.requestID);
          if (!owned) break;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            // The timer's own `question.reject` echoes back here, but it lost
            // the claim above, so reaching this point means a real rejection.
            payload: { answers: {}, resolvedBy: "user" },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            context.providerBusyTurnId = turnId;
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          const idleTurnId = context.providerBusyTurnId;
          if (event.properties.status.type === "idle" && idleTurnId) {
            const emittedFailure = classifyProviderEmittedFailure(
              collectOpenCodeAssistantText(context),
            );
            const settlement = claimTurnSettlement(context.turnLifecycle, {
              turnId: String(idleTurnId),
              reason: emittedFailure ? "error" : "completed",
            });
            if (!settlement.claimed) {
              break;
            }
            context.turnLifecycle = settlement.state;
            context.providerBusyTurnId = undefined;
            yield* forceCloseOpenTools(context, idleTurnId);
            yield* forceCloseOpenCodeAgents(
              context,
              "Parent turn settled before OpenCode reported a terminal child-session state.",
            );
            context.activeTurnId = undefined;
            // Pure provider failure dumps as assistant text + idle must not
            // settle as successful replies (Cursor/Grok/Claude parity).
            const failureMessage = emittedFailure
              ? formatProviderEmittedFailureMessage(emittedFailure, {
                  providerLabel: "OpenCode",
                  ...(context.session.model ? { model: context.session.model } : {}),
                })
              : undefined;
            if (emittedFailure && failureMessage) {
              yield* Effect.logWarning("OpenCode turn completed with provider-emitted failure", {
                threadId: context.session.threadId,
                turnId: idleTurnId,
                code: emittedFailure.code,
                model: context.session.model,
              });
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId: idleTurnId,
                  raw: event,
                })),
                type: "runtime.error",
                payload: {
                  message: failureMessage,
                  class: emittedFailure.class,
                },
              });
            }
            yield* updateProviderSession(
              context,
              {
                status: "ready",
                ...(failureMessage ? { lastError: failureMessage } : {}),
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: idleTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: failureMessage
                ? {
                    state: "failed",
                    errorMessage: failureMessage,
                  }
                : {
                    state: "completed",
                  },
            });
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const settlement = activeTurnId
            ? claimTurnSettlement(context.turnLifecycle, {
                turnId: String(activeTurnId),
                reason: "error",
              })
            : undefined;
          if (activeTurnId && !settlement?.claimed) {
            break;
          }
          if (settlement?.claimed) {
            context.turnLifecycle = settlement.state;
            yield* forceCloseOpenTools(context, activeTurnId);
            yield* forceCloseOpenCodeAgents(context, message);
            context.activeTurnId = undefined;
            context.providerBusyTurnId = undefined;
          }
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId && settlement?.claimed) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const attachmentDirectory =
          resolveThreadAttachmentDirectory({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
          }) ?? undefined;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const mcpBindings = McpProviderSession.readMcpProviderBindings(
                input.threadId,
                options?.environment ?? process.env,
              );
              if (!server.external) {
                for (const binding of mcpBindings) {
                  yield* runOpenCodeSdk("mcp.add", () =>
                    client.mcp.add({
                      name: binding.name,
                      config: openCodeMcpConfigFromBinding(binding),
                    }),
                  );
                }
              }
              const injectsToolportMcp =
                !server.external &&
                mcpBindings.some(
                  (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
                );
              const mcpBindingCatalog = server.external
                ? ""
                : McpProviderSession.mcpBindingCatalogKey(mcpBindings);
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(
                        input.runtimeMode,
                        attachmentDirectory,
                      ),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(
                        input.runtimeMode,
                        attachmentDirectory,
                      ),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    permission: buildOpenCodePermissionRules(
                      input.runtimeMode,
                      attachmentDirectory,
                    ),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
                injectsToolportMcp,
                mcpBindingCatalog,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        // Guard against a concurrent startSession call that may have raced
        // and already inserted a session while we were awaiting async work.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another call won the race — clean up. Only abort the remote
          // session if we created it here; a resumed one is shared upstream
          // state the winner is now using.
          if (started.created) {
            yield* runOpenCodeSdk("session.abort", () =>
              started.client.session.abort({
                sessionID: started.openCodeSession.id,
              }),
            ).pipe(Effect.ignore);
          }
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          pendingRequestTimers: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          openTools: new Map(),
          agentRunsBySessionId: new Map(),
          turns: [],
          activeTurnId: undefined,
          providerBusyTurnId: undefined,
          turnLifecycle: emptyTurnQueue(),
          activeAgent: undefined,
          activeVariant: undefined,
          injectsToolportMcp: started.injectsToolportMcp,
          mcpBindingCatalog: started.mcpBindingCatalog,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    /**
     * MCP is added at session start via mcp.add (local servers only). When
     * Toolport settings or preview arming change the catalog, add/disconnect
     * so the agent sees the new list without a brand-new thread.
     */
    const rebindOpenCodeToolportMcpIfNeeded = Effect.fn("rebindOpenCodeToolportMcpIfNeeded")(
      function* (context: OpenCodeSessionContext) {
        if (yield* Ref.get(context.stopped)) {
          return;
        }
        const env = options?.environment ?? process.env;
        const desiredBindings = McpProviderSession.readMcpProviderBindings(
          context.session.threadId,
          env,
        );
        const desiredCatalog = McpProviderSession.mcpBindingCatalogKey(desiredBindings);
        if (desiredCatalog === context.mcpBindingCatalog) {
          return;
        }

        // External OpenCode servers are user-managed; Studio cannot inject MCP.
        if (context.server.external) {
          context.mcpBindingCatalog = desiredCatalog;
          context.injectsToolportMcp = McpProviderSession.isToolportMcpInjectionEnabled(env);
          return;
        }

        yield* Effect.logInfo("OpenCode MCP catalog changed; rebinding MCP servers", {
          threadId: context.session.threadId,
          from: context.mcpBindingCatalog,
          to: desiredCatalog,
        });

        // Only real server names are disconnect targets. The catalog key also
        // carries descriptive tags, so decoding belongs to the module that
        // builds the key rather than to a split() here.
        const previousNames = McpProviderSession.mcpBindingNamesFromCatalogKey(
          context.mcpBindingCatalog,
        );
        const desiredNames = new Set(desiredBindings.map((binding) => binding.name));
        for (const name of previousNames) {
          if (!desiredNames.has(name)) {
            yield* runOpenCodeSdk("mcp.disconnect", () =>
              context.client.mcp.disconnect({ name }),
            ).pipe(Effect.ignore);
          }
        }
        for (const binding of desiredBindings) {
          if (!previousNames.has(binding.name)) {
            yield* runOpenCodeSdk("mcp.add", () =>
              context.client.mcp.add({
                name: binding.name,
                config: openCodeMcpConfigFromBinding(binding),
              }),
            );
          }
        }
        context.mcpBindingCatalog = desiredCatalog;
        context.injectsToolportMcp = desiredBindings.some(
          (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
        );
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      // Toolport MCP is fixed at session start for local servers; rebind before
      // the next prompt so Settings toggles apply without a new thread.
      yield* rebindOpenCodeToolportMcpIfNeeded(context).pipe(Effect.mapError(toRequestError));
      // A sendTurn while a turn is active is a steer: OpenCode queues the
      // prompt into the busy session and the work continues as one turn, so
      // the active turn id is reused instead of opening a new turn.
      // Steer eligibility is shared turn-engine policy (SOU-428).
      const steeringTurnId = canSteerSendTurn({
        promptsInFlight: context.activeTurnId !== undefined ? 1 : 0,
        hasActiveTurnId: context.activeTurnId !== undefined,
        activeTurnInterrupted: false,
      })
        ? context.activeTurnId
        : undefined;
      const turnId = steeringTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.activeTurnId = turnId;
      context.activeAgent = agent;
      context.activeVariant = variant;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        context.turnLifecycle = trackLiveTurn(context.turnLifecycle, String(turnId));
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
      }

      yield* runOpenCodeSdk("session.promptAsync", () =>
        context.client.session.promptAsync({
          sessionID: context.openCodeSessionId,
          model: parsedModel,
          ...(context.activeAgent ? { agent: context.activeAgent } : {}),
          ...(context.activeVariant ? { variant: context.activeVariant } : {}),
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
        }),
      ).pipe(
        Effect.mapError(toRequestError),
        // On failure of a fresh turn: clear active-turn state, flip the
        // session back to ready with lastError set, emit turn.aborted, then
        // let the typed error propagate. We don't need to rebuild the error
        // here — `toRequestError` already produced the right shape. A failed
        // steer leaves the still-running original turn untouched.
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                const settlement = claimTurnSettlement(context.turnLifecycle, {
                  turnId: String(turnId),
                  reason: "error",
                });
                if (!settlement.claimed) {
                  return;
                }
                context.turnLifecycle = settlement.state;
                context.activeTurnId = undefined;
                context.providerBusyTurnId = undefined;
                context.activeAgent = undefined;
                context.activeVariant = undefined;
                yield* updateProviderSession(
                  context,
                  {
                    status: "ready",
                    model: modelSelection?.model ?? context.session.model,
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestError.detail,
                  },
                });
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        // Re-surface the durable cursor on every turn so the persisted binding
        // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const settleTurnId =
          turnId ??
          context.activeTurnId ??
          (context.turnLifecycle.activeTurnId
            ? TurnId.make(context.turnLifecycle.activeTurnId)
            : undefined);
        context.turnLifecycle = markTurnStopping(context.turnLifecycle);

        // Drop pending interactive waits so Stop cannot leave the composer
        // stuck on an approval/question while the turn settles (Cursor/Grok).
        yield* settlePendingRequestsAsAborted(context, settleTurnId);

        // Reserve terminal ownership before abort: OpenCode answers abort with
        // session.status=idle, and that notification must not race Stop into a
        // successful completion.
        const settlement = settleTurnId
          ? claimTurnSettlement(context.turnLifecycle, {
              turnId: String(settleTurnId),
              reason: "cancelled",
              mode: "active-turn-fallback",
            })
          : undefined;
        if (settlement?.claimed) {
          context.turnLifecycle = settlement.state;
        }

        // Never block Stop on a wedged OpenCode server.
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.timeout("2 seconds"), Effect.ignore);

        if (!settlement?.claimed) {
          // Recovery still owns session honesty when transport state says
          // running but no lifecycle turn can be terminalized. There is no
          // turn event to emit, but Stop must clear stale Working state.
          context.activeTurnId = undefined;
          context.providerBusyTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          return;
        }
        const claimedTurnId = TurnId.make(settlement.turnId);

        // Close ghost tool rows before clearing the turn (Stop settle order).
        yield* forceCloseOpenTools(context, claimedTurnId);
        yield* forceCloseOpenCodeAgents(context, "Parent turn was cancelled.");

        // Force session ready even if OpenCode never emits session.status idle.
        // Leaving activeTurnId set after Stop makes the next send look like a
        // steer into a dead turn and breaks long multi-turn sessions.
        context.activeTurnId = undefined;
        context.providerBusyTurnId = undefined;
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });

        if (settlement.claimed) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: claimedTurnId,
            })),
            type: "turn.completed",
            payload: {
              state: "cancelled",
              stopReason: "cancelled",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        yield* forceCloseOpenCodeAgents(context, "OpenCode session stopped.");
        const stopped = yield* stopOpenCodeContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
