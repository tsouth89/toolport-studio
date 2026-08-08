/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  EventId,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type RequestResolutionSource,
  type RuntimeMode,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeAgentId,
  RuntimeRequestId,
  ProviderApprovalDecision,
  ThreadId,
  TurnId,
  ProviderSendTurnInput,
} from "@toolport-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@toolport-studio/shared/model";
import {
  classifyProviderEmittedFailure,
  extractProviderErrorMessage,
  formatProviderEmittedFailureMessage,
} from "@toolport-studio/shared/providerError";
import {
  OPEN_TOOL_FORCE_CLOSE_DETAIL,
  OPEN_TOOL_FORCE_CLOSE_SOURCE,
  shouldForceCloseRemainingOpenToolsOnSettle,
} from "../turnEngine/index.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { resolveAttachmentPath, resolveThreadAttachmentDirectory } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeCodexNativeProtocolLoggerFactory } from "./CodexNativeLogging.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");

function codexMcpLaunchOptions(
  bindings: ReadonlyArray<McpProviderSession.McpProviderBinding>,
  baseEnvironment: NodeJS.ProcessEnv,
): {
  readonly environment: NodeJS.ProcessEnv;
  readonly appServerArgs: ReadonlyArray<string>;
} {
  const environment = { ...baseEnvironment };
  const appServerArgs: Array<string> = [];

  bindings.forEach((binding, index) => {
    const prefix = `mcp_servers.${binding.name}`;
    if (binding.transport === "stdio") {
      appServerArgs.push("-c", `${prefix}.command=${JSON.stringify(binding.command)}`);
      if (binding.args.length > 0) {
        appServerArgs.push("-c", `${prefix}.args=${JSON.stringify(binding.args)}`);
      }
      for (const [name, value] of Object.entries(binding.env)) {
        appServerArgs.push("-c", `${prefix}.env.${name}=${JSON.stringify(value)}`);
      }
      return;
    }

    appServerArgs.push("-c", `${prefix}.url=${JSON.stringify(binding.url)}`);
    const authorization = binding.headers.Authorization;
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearerToken) {
      const tokenEnvironmentName = `TOOLPORT_STUDIO_MCP_BEARER_TOKEN_${index}`;
      environment[tokenEnvironmentName] = bearerToken;
      appServerArgs.push(
        "-c",
        `${prefix}.bearer_token_env_var=${JSON.stringify(tokenEnvironmentName)}`,
      );
    }
  });

  return { environment, appServerArgs };
}

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  /**
   * Driver kind this adapter instance is serving. Defaults to `codex`.
   *
   * The Codex runtime backs more than the first-party driver: a BYOK
   * instance runs a third-party endpoint through the same app-server with a
   * generated `CODEX_HOME`, and its snapshots, threads, and turn requests
   * are all stamped with its own driver kind. Without this the request
   * guard below rejects those turns as a provider mismatch.
   */
  readonly driverKind?: ProviderDriverKind;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Override pending permission auto-cancel (default 3 minutes). */
  readonly pendingApprovalTimeoutMs?: number;
  /** Override pending user-input auto-cancel (default 5 minutes). */
  readonly pendingUserInputTimeoutMs?: number;
}

type CodexOpenTool = {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly title: string | undefined;
  readonly turnId: string | undefined;
};

type CodexOpenAgent = {
  readonly agentRunId: RuntimeAgentId;
  readonly parentAgentRunId: RuntimeAgentId | undefined;
  readonly providerThreadId: string | undefined;
  readonly label: string | undefined;
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly turnId: string | undefined;
  readonly canInspectThread: boolean | undefined;
};

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  scope: Scope.Closeable;
  runtime: CodexSessionRuntimeShape;
  eventFiber: Fiber.Fiber<void, never>;
  /**
   * Whether this app-server process was launched with Toolport MCP config.
   * Settings toggles update process.env immediately; mismatch triggers recycle.
   */
  injectsToolportMcp: boolean;
  /** MCP server name fingerprint at last app-server launch. */
  mcpBindingCatalog: string;
  /** Launch inputs retained so Toolport MCP rebind can respawn app-server. */
  cwd: string;
  runtimeMode: RuntimeMode;
  model: string | undefined;
  serviceTier: ReturnType<typeof getCodexServiceTierOptionValue> | undefined;
  stopped: boolean;
  /** Open tool items for the live turn (force-closed on settle / Stop). */
  openTools: Map<string, CodexOpenTool>;
  /** Native subagents still active for the live turn. */
  openAgents: Map<string, CodexOpenAgent>;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
  /** Driver kind of the instance that failed (see `CodexAdapterLiveOptions.driverKind`). */
  provider: ProviderDriverKind = PROVIDER,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Join agentMessage item text for settle-time failure classification. */
export function collectCodexAssistantText(items: unknown): string {
  if (!Array.isArray(items)) {
    return "";
  }
  const chunks: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "agentMessage") continue;
    if (typeof record.text !== "string" || record.text.trim().length === 0) continue;
    chunks.push(record.text);
  }
  return chunks.join("\n");
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType, item?: CodexLifecycleItem): string | undefined {
  if (itemType === "mcp_tool_call" && item?.type === "mcpToolCall") {
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(itemType: CanonicalItemType, item: CodexLifecycleItem): string | undefined {
  const itemRecord = item as Record<string, unknown>;
  const action = itemRecord.action as Record<string, unknown> | undefined;
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [itemRecord.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

/**
 * Reads the Studio-side `resolvedBy` marker that CodexSessionRuntime stamps on
 * the synthetic notifications it emits when a pending request auto-cancels.
 * Absent on anything Codex itself sent, which is the intended signal: only
 * resolutions Studio made on the user's behalf are labelled.
 */
function readResolutionSource(payload: unknown): RequestResolutionSource | undefined {
  if (typeof payload !== "object" || payload === null || !("resolvedBy" in payload)) {
    return undefined;
  }
  const value = (payload as { readonly resolvedBy: unknown }).resolvedBy;
  return value === "user" || value === "timeout" || value === "aborted" ? value : undefined;
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

/**
 * High-frequency stream deltas dominate native logs and host IO under multi-
 * session dogfood (SOU-400). Keep lifecycle rows; skip per-token deltas.
 */
export function shouldLogCodexNativeEvent(event: ProviderEvent): boolean {
  switch (event.method) {
    case "item/agentMessage/delta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/plan/delta":
      return false;
    default:
      return true;
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.agentRunId) refs.agentRunId = event.agentRunId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function toRuntimeAgentStatus(
  status:
    | EffectCodexSchema.ServerNotification__CollabAgentStatus
    | "inProgress"
    | "completed"
    | "failed",
): "pending" | "running" | "completed" | "failed" | "interrupted" | "stopped" | "unknown" {
  switch (status) {
    case "pendingInit":
      return "pending";
    case "running":
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
    case "notFound":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "shutdown":
      return "stopped";
    default:
      return "unknown";
  }
}

function mapCollabAgentLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
): ReadonlyArray<ProviderRuntimeEvent> | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item || item.type !== "collabAgentToolCall") {
    return undefined;
  }

  const receiverThreadIds =
    item.receiverThreadIds.length > 0 ? item.receiverThreadIds : Object.keys(item.agentsStates);
  return receiverThreadIds.map((providerThreadId, index) => {
    const agentRunId = RuntimeAgentId.make(providerThreadId);
    const state = item.agentsStates[providerThreadId];
    const status = toRuntimeAgentStatus(state?.status ?? item.status);
    const type =
      status === "completed" ||
      status === "failed" ||
      status === "interrupted" ||
      status === "stopped"
        ? "agent.completed"
        : item.tool === "spawnAgent" && lifecycle === "item.started"
          ? "agent.started"
          : "agent.updated";
    const base = runtimeEventBase(event, canonicalThreadId);
    const prompt = trimText(item.prompt ?? undefined);
    const message = trimText(state?.message ?? undefined);
    return {
      ...base,
      eventId: EventId.make(`${event.id}:agent:${index}:${providerThreadId}`),
      type,
      providerRefs: {
        ...base.providerRefs,
        providerThreadId,
        agentRunId,
      },
      payload: {
        agentRunId,
        ...(event.agentRunId ? { parentAgentRunId: event.agentRunId } : {}),
        providerThreadId,
        status,
        label: `Agent ${index + 1}`,
        ...(item.tool === "spawnAgent" && prompt ? { prompt } : {}),
        ...(item.tool === "spawnAgent" && trimText(item.model ?? undefined)
          ? { model: trimText(item.model ?? undefined)! }
          : {}),
        ...(item.tool === "spawnAgent" && item.reasoningEffort
          ? { reasoningEffort: item.reasoningEffort }
          : {}),
        ...(message ? { message } : {}),
        canInspectThread: true,
      },
    } satisfies ProviderRuntimeEvent;
  });
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(itemType, item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType, item) ? { title: itemTitle(itemType, item) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const rawErrorMessage = trimText(payload.turn.error?.message);
    const errorMessage = rawErrorMessage ? extractProviderErrorMessage(rawErrorMessage) : undefined;
    const status = toTurnStatus(payload.turn.status);
    // When Codex marks the turn completed but the only assistant text is a
    // pure capacity/auth dump, settle as failed (Cursor/Grok/Claude parity).
    const emittedFailure =
      status === "completed" && !errorMessage
        ? classifyProviderEmittedFailure(collectCodexAssistantText(payload.turn.items))
        : undefined;
    const failureMessage = emittedFailure
      ? formatProviderEmittedFailureMessage(emittedFailure, { providerLabel: "Codex" })
      : undefined;
    const base = runtimeEventBase(event, canonicalThreadId);
    if (failureMessage && emittedFailure) {
      return [
        {
          ...base,
          type: "runtime.error" as const,
          payload: {
            message: failureMessage,
            class: emittedFailure.class,
          },
        },
        {
          ...base,
          type: "turn.completed" as const,
          payload: {
            state: "failed" as const,
            errorMessage: failureMessage,
          },
        },
      ];
    }
    return [
      {
        ...base,
        type: "turn.completed",
        payload: {
          state: status,
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const agents = mapCollabAgentLifecycle(event, canonicalThreadId, "item.started");
    if (agents) return agents;
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const agents = mapCollabAgentLifecycle(event, canonicalThreadId, "item.completed");
    if (agents) return agents;
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(itemType, item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    const resolvedBy = readResolutionSource(event.payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
          ...(resolvedBy ? { resolvedBy } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    const resolvedBy = readResolutionSource(event.payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
          ...(resolvedBy ? { resolvedBy } : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = extractProviderErrorMessage(
      payload?.error.message ?? event.message ?? "Provider runtime error",
    );
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const boundDriverKind = options?.driverKind ?? PROVIDER;
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* Effect.service(ServerConfig);
  const attachmentDirectoryForThread = (threadId: ThreadId): string | undefined =>
    resolveThreadAttachmentDirectory({
      attachmentsDir: serverConfig.attachmentsDir,
      threadId,
    }) ?? undefined;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const makeCodexNativeProtocolLogger = yield* makeCodexNativeProtocolLoggerFactory();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = crypto.randomUUIDv4.pipe(
    Effect.map((id) => EventId.make(id)),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: boundDriverKind,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Codex runtime identifier.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;

  const forceCloseCodexOpenTools = (
    session: CodexAdapterSessionContext,
    turnId: string | undefined,
    // Force-closes are emitted just before the terminal turn event, so they
    // share its timestamp rather than reading a wall clock outside Effect.
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (!shouldForceCloseRemainingOpenToolsOnSettle(session.openTools.size)) {
      session.openTools.clear();
      return [];
    }
    const stampBase = {
      provider: boundDriverKind,
      threadId: session.threadId,
      createdAt,
    };
    const open = [...session.openTools.values()].filter(
      (tool) => turnId === undefined || tool.turnId === undefined || tool.turnId === turnId,
    );
    for (const tool of open) {
      session.openTools.delete(tool.itemId);
    }
    // Clear any leftover for other turns when settling without a turn filter.
    if (turnId === undefined) {
      session.openTools.clear();
    }
    return open.map((tool, index) => {
      const resolvedTurnId = tool.turnId ?? turnId;
      return {
        ...stampBase,
        eventId: EventId.make(`codex-force-close-${tool.itemId}-${index}`),
        type: "item.completed" as const,
        ...(resolvedTurnId ? { turnId: TurnId.make(resolvedTurnId) } : {}),
        itemId: RuntimeItemId.make(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "failed" as const,
          ...(tool.title ? { title: tool.title } : {}),
          detail: OPEN_TOOL_FORCE_CLOSE_DETAIL,
          data: { forcedClose: true, source: OPEN_TOOL_FORCE_CLOSE_SOURCE },
        },
        raw: {
          source: "codex.app-server.notification" as const,
          method: OPEN_TOOL_FORCE_CLOSE_SOURCE,
          payload: { toolCallId: tool.itemId },
        },
      };
    });
  };

  const forceCloseCodexOpenAgents = (
    session: CodexAdapterSessionContext,
    turnId: string | undefined,
    createdAt: string,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const open = [...session.openAgents.values()].filter(
      (agent) => turnId === undefined || agent.turnId === undefined || agent.turnId === turnId,
    );
    for (const agent of open) {
      session.openAgents.delete(String(agent.agentRunId));
    }
    if (turnId === undefined) {
      session.openAgents.clear();
    }
    return open.map((agent, index) => {
      const resolvedTurnId = agent.turnId ?? turnId;
      return {
        eventId: EventId.make(`codex-force-close-agent-${agent.agentRunId}-${index}`),
        provider: PROVIDER,
        threadId: session.threadId,
        createdAt,
        type: "agent.completed" as const,
        ...(resolvedTurnId ? { turnId: TurnId.make(resolvedTurnId) } : {}),
        providerRefs: {
          ...(agent.providerThreadId ? { providerThreadId: agent.providerThreadId } : {}),
          agentRunId: agent.agentRunId,
        },
        payload: {
          agentRunId: agent.agentRunId,
          ...(agent.parentAgentRunId ? { parentAgentRunId: agent.parentAgentRunId } : {}),
          ...(agent.providerThreadId ? { providerThreadId: agent.providerThreadId } : {}),
          status: "stopped" as const,
          ...(agent.label ? { label: agent.label } : {}),
          ...(agent.prompt ? { prompt: agent.prompt } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          message: "Parent turn settled before the provider reported a terminal agent state.",
          ...(agent.canInspectThread !== undefined
            ? { canInspectThread: agent.canInspectThread }
            : {}),
        },
        raw: {
          source: "codex.app-server.notification" as const,
          method: OPEN_TOOL_FORCE_CLOSE_SOURCE,
          payload: { agentRunId: agent.agentRunId },
        },
      };
    });
  };

  const trackCodexOpenToolsFromEvents = (
    session: CodexAdapterSessionContext,
    events: ReadonlyArray<ProviderRuntimeEvent>,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const extras: ProviderRuntimeEvent[] = [];
    for (const runtimeEvent of events) {
      if (runtimeEvent.type === "item.started" && runtimeEvent.itemId) {
        const itemId = String(runtimeEvent.itemId);
        session.openTools.set(itemId, {
          itemId,
          itemType: runtimeEvent.payload.itemType,
          title:
            typeof runtimeEvent.payload.title === "string" ? runtimeEvent.payload.title : undefined,
          turnId: runtimeEvent.turnId ? String(runtimeEvent.turnId) : undefined,
        });
      } else if (runtimeEvent.type === "item.completed" && runtimeEvent.itemId) {
        session.openTools.delete(String(runtimeEvent.itemId));
      } else if (runtimeEvent.type === "agent.started" || runtimeEvent.type === "agent.updated") {
        const agentRunId = String(runtimeEvent.payload.agentRunId);
        const previous = session.openAgents.get(agentRunId);
        session.openAgents.set(agentRunId, {
          agentRunId: runtimeEvent.payload.agentRunId,
          parentAgentRunId: runtimeEvent.payload.parentAgentRunId ?? previous?.parentAgentRunId,
          providerThreadId: runtimeEvent.payload.providerThreadId ?? previous?.providerThreadId,
          label: runtimeEvent.payload.label ?? previous?.label,
          prompt: runtimeEvent.payload.prompt ?? previous?.prompt,
          model: runtimeEvent.payload.model ?? previous?.model,
          reasoningEffort: runtimeEvent.payload.reasoningEffort ?? previous?.reasoningEffort,
          turnId:
            (runtimeEvent.turnId ? String(runtimeEvent.turnId) : undefined) ?? previous?.turnId,
          canInspectThread: runtimeEvent.payload.canInspectThread ?? previous?.canInspectThread,
        });
      } else if (runtimeEvent.type === "agent.completed") {
        session.openAgents.delete(String(runtimeEvent.payload.agentRunId));
      } else if (runtimeEvent.type === "turn.completed" || runtimeEvent.type === "turn.aborted") {
        extras.push(
          ...forceCloseCodexOpenTools(
            session,
            runtimeEvent.turnId ? String(runtimeEvent.turnId) : undefined,
            runtimeEvent.createdAt,
          ),
          ...forceCloseCodexOpenAgents(
            session,
            runtimeEvent.turnId ? String(runtimeEvent.turnId) : undefined,
            runtimeEvent.createdAt,
          ),
        );
      }
    }
    // Force-closes must precede the terminal turn event so the UI never paints
    // Working + inProgress tool after the turn is dead.
    if (extras.length === 0) {
      return events;
    }
    const terminalIndex = events.findIndex(
      (event) => event.type === "turn.completed" || event.type === "turn.aborted",
    );
    if (terminalIndex < 0) {
      return [...events, ...extras];
    }
    return [...events.slice(0, terminalIndex), ...extras, ...events.slice(terminalIndex)];
  };

  const startEventFiber = (runtime: CodexSessionRuntimeShape, sessionScope: Scope.Closeable) =>
    Stream.runForEach(runtime.events, (event) =>
      Effect.gen(function* () {
        yield* writeNativeEvent(event);
        let runtimeEvents = mapToRuntimeEvents(event, event.threadId);
        if (runtimeEvents.length === 0) {
          yield* Effect.logDebug("ignoring unhandled Codex provider event", {
            method: event.method,
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
          });
          return;
        }
        const session = sessions.get(event.threadId);
        if (session) {
          runtimeEvents = trackCodexOpenToolsFromEvents(session, runtimeEvents);
        }
        yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
      }),
    ).pipe(
      // Fork into the session scope, never the caller's fiber. `forkChild` made
      // this consumer a child of the fiber running startSession, so it was
      // interrupted the moment startSession returned. Only notifications that
      // landed during startup were ever projected, which is why a codex or BYOK
      // thread showed thread/started and then sat on Working forever while the
      // app-server kept streaming a full turn at it.
      Effect.forkIn(sessionScope),
    );

  const disposeCodexProcess = (session: CodexAdapterSessionContext) =>
    Effect.gen(function* () {
      const eventFiber = session.eventFiber;
      const scope = session.scope;
      const runtime = session.runtime;
      yield* runtime.close.pipe(Effect.ignore);
      // Await scope close so stopSession finalizers (and tests that assert
      // them) observe teardown before returning. Recycle on rebind also needs
      // the prior process fully released before spawning the next one.
      yield* Effect.ignore(Scope.close(scope, Exit.void));
      yield* Fiber.interrupt(eventFiber).pipe(Effect.ignore);
    });

  /**
   * Toolport MCP is launch-time Codex app-server config (`-c mcp_servers.*`).
   * Settings toggles update process.env immediately; recycle the child so
   * Linear/etc apply without starting a brand-new thread (Grok/Cursor parity).
   */
  const rebindCodexToolportMcpIfNeeded = (session: CodexAdapterSessionContext) =>
    Effect.gen(function* () {
      if (session.stopped) {
        return;
      }
      const env = options?.environment ?? process.env;
      const desiredBindings = McpProviderSession.readMcpProviderBindings(session.threadId, env);
      const desiredCatalog = McpProviderSession.mcpBindingCatalogKey(desiredBindings);
      if (desiredCatalog === session.mcpBindingCatalog) {
        return;
      }

      yield* Effect.logInfo("Codex MCP catalog changed; recycling app-server process", {
        threadId: session.threadId,
        from: session.mcpBindingCatalog,
        to: desiredCatalog,
      });

      const previous = yield* session.runtime.getSession.pipe(Effect.orElseSucceed(() => null));
      const resumeCursor =
        previous !== null && isCodexResumeCursorSchema(previous.resumeCursor)
          ? previous.resumeCursor
          : undefined;

      yield* disposeCodexProcess(session);

      const mcpBindings = desiredBindings;
      const injectsToolportMcp = mcpBindings.some(
        (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
      );
      const mcpLaunchOptions =
        mcpBindings.length > 0 ? codexMcpLaunchOptions(mcpBindings, env) : undefined;
      const model = previous?.model ?? session.model;
      const attachmentDirectory = attachmentDirectoryForThread(session.threadId);
      const runtimeInput: CodexSessionRuntimeOptions = {
        threadId: session.threadId,
        providerInstanceId: boundInstanceId,
        driverKind: boundDriverKind,
        cwd: previous?.cwd ?? session.cwd,
        binaryPath: codexConfig.binaryPath,
        launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
        ...(options?.environment ? { environment: options.environment } : {}),
        ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
        ...(resumeCursor ? { resumeCursor } : {}),
        runtimeMode: previous?.runtimeMode ?? session.runtimeMode,
        ...(attachmentDirectory ? { attachmentDirectory } : {}),
        ...(model ? { model } : {}),
        ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
        ...mcpLaunchOptions,
        ...(options?.pendingApprovalTimeoutMs !== undefined
          ? { pendingApprovalTimeoutMs: options.pendingApprovalTimeoutMs }
          : {}),
        ...(options?.pendingUserInputTimeoutMs !== undefined
          ? { pendingUserInputTimeoutMs: options.pendingUserInputTimeoutMs }
          : {}),
        ...makeCodexNativeProtocolLogger({
          nativeEventLogger,
          provider: boundDriverKind,
          threadId: session.threadId,
        }),
      };

      const sessionScope = yield* Scope.make("sequential");
      const runtime = yield* createRuntime(runtimeInput).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: boundDriverKind,
              threadId: session.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const eventFiber = yield* startEventFiber(runtime, sessionScope);
      yield* runtime.start().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: boundDriverKind,
              threadId: session.threadId,
              detail: cause.message,
              cause,
            }),
        ),
        Effect.onError(() =>
          runtime.close.pipe(
            Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
            Effect.andThen(Fiber.interrupt(eventFiber)),
            Effect.ignore,
          ),
        ),
      );

      session.scope = sessionScope;
      session.runtime = runtime;
      session.eventFiber = eventFiber;
      session.injectsToolportMcp = injectsToolportMcp;
      session.mcpBindingCatalog = McpProviderSession.mcpBindingCatalogKey(mcpBindings);
      session.cwd = runtimeInput.cwd;
      session.runtimeMode = runtimeInput.runtimeMode;
      session.model = model;
    });

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== boundDriverKind) {
          return yield* new ProviderAdapterValidationError({
            provider: boundDriverKind,
            operation: "startSession",
            issue: `Expected provider '${boundDriverKind}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        const serviceTier =
          input.modelSelection?.instanceId === boundInstanceId
            ? getCodexServiceTierOptionValue(input.modelSelection)
            : undefined;
        const cwd = input.cwd ?? process.cwd();
        const model =
          input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : undefined;
        const mcpBindings = McpProviderSession.readMcpProviderBindings(
          input.threadId,
          options?.environment ?? process.env,
        );
        const injectsToolportMcp = mcpBindings.some(
          (binding) => binding.name === McpProviderSession.TOOLPORT_MCP_SERVER_NAME,
        );
        const mcpLaunchOptions =
          mcpBindings.length > 0
            ? codexMcpLaunchOptions(mcpBindings, options?.environment ?? process.env)
            : undefined;
        const attachmentDirectory = attachmentDirectoryForThread(input.threadId);
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          driverKind: boundDriverKind,
          cwd,
          binaryPath: codexConfig.binaryPath,
          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(attachmentDirectory ? { attachmentDirectory } : {}),
          ...(model ? { model } : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...mcpLaunchOptions,
          ...(options?.pendingApprovalTimeoutMs !== undefined
            ? { pendingApprovalTimeoutMs: options.pendingApprovalTimeoutMs }
            : {}),
          ...(options?.pendingUserInputTimeoutMs !== undefined
            ? { pendingUserInputTimeoutMs: options.pendingUserInputTimeoutMs }
            : {}),
          ...makeCodexNativeProtocolLogger({
            nativeEventLogger,
            provider: boundDriverKind,
            threadId: input.threadId,
          }),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: boundDriverKind,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const eventFiber = yield* startEventFiber(runtime, sessionScope);

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: boundDriverKind,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        sessions.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          injectsToolportMcp,
          mcpBindingCatalog: McpProviderSession.mcpBindingCatalogKey(mcpBindings),
          cwd,
          runtimeMode: input.runtimeMode,
          model,
          serviceTier,
          stopped: false,
          openTools: new Map(),
          openAgents: new Map(),
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: boundDriverKind,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: boundDriverKind,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    // Validate session before slow attachment IO so missing sessions fail fast
    // and Working chrome can flip to running during image read/encode.
    const sessionForRebind = yield* requireSession(input.threadId);
    // Toolport MCP is fixed at app-server launch; rebind before the next prompt
    // so Settings toggles apply without starting a brand-new thread.
    yield* rebindCodexToolportMcpIfNeeded(sessionForRebind);
    const prepStamp = yield* makeEventStamp();
    yield* Queue.offer(runtimeEventQueue, {
      type: "session.state.changed",
      eventId: prepStamp.eventId,
      provider: boundDriverKind,
      createdAt: prepStamp.createdAt,
      threadId: input.threadId,
      payload: {
        state: "running",
        reason: "Preparing Codex turn",
      },
    });

    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    ).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const failStamp = yield* makeEventStamp();
          yield* Queue.offer(runtimeEventQueue, {
            type: "session.state.changed",
            eventId: failStamp.eventId,
            provider: boundDriverKind,
            createdAt: failStamp.createdAt,
            threadId: input.threadId,
            payload: {
              state: "ready",
              reason: "Codex attachment preparation failed",
            },
          });
        }).pipe(Effect.ignore),
      ),
    );

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    return yield* session.runtime
      .sendTurn({
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        ...(input.conversationHistory !== undefined && input.conversationHistory.length > 0
          ? { conversationHistory: input.conversationHistory }
          : {}),
        ...(input.recentToolSummaries !== undefined && input.recentToolSummaries.length > 0
          ? { recentToolSummaries: input.recentToolSummaries }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) =>
          mapCodexRuntimeError(input.threadId, "turn/start", cause, boundDriverKind),
        ),
        // Attachment/prep path can leave session marked running without a turn
        // when turn/start fails; force ready so Working cannot stick.
        Effect.tapError(() =>
          Effect.gen(function* () {
            const failStamp = yield* makeEventStamp();
            yield* Queue.offer(runtimeEventQueue, {
              type: "session.state.changed",
              eventId: failStamp.eventId,
              provider: boundDriverKind,
              createdAt: failStamp.createdAt,
              threadId: input.threadId,
              payload: {
                state: "ready",
                reason: "Codex turn preparation failed",
              },
            });
          }).pipe(Effect.ignore),
        ),
      );
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: boundDriverKind,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.interruptTurn(turnId)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause, boundDriverKind),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause, boundDriverKind),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: boundDriverKind,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause, boundDriverKind),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause, boundDriverKind),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause, boundDriverKind),
      ),
    );

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    if (!shouldLogCodexNativeEvent(event)) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    sessions.delete(session.threadId);
    yield* disposeCodexProcess(session);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: boundDriverKind,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
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
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
