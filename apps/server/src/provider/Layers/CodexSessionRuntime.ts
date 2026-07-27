import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { extractProviderErrorMessage } from "@t3tools/shared/providerError";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import { buildConversationRehydrationPrefix } from "../conversationRehydration.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
/** Auto-cancel unanswered permission prompts so multi-session dogfood cannot hang forever. */
const CODEX_PENDING_APPROVAL_TIMEOUT_MS = 3 * 60_000;
/** Slightly longer for multi-question forms. */
const CODEX_PENDING_USER_INPUT_TIMEOUT_MS = 5 * 60_000;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export function hasConfiguredMcpServer(appServerArgs: ReadonlyArray<string> | undefined): boolean {
  return appServerArgs?.some((argument) => argument.includes("mcp_servers.")) === true;
}

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly resumeCursor?: CodexResumeCursor;
  readonly appServerArgs?: ReadonlyArray<string>;
  /** Override pending permission auto-cancel (default 3 minutes). */
  readonly pendingApprovalTimeoutMs?: number;
  /** Override pending user-input auto-cancel (default 5 minutes). */
  readonly pendingUserInputTimeoutMs?: number;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
  /** Studio projected history for cold-start rehydration when thread resume missed. */
  readonly conversationHistory?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  readonly recentToolSummaries?: ReadonlyArray<string>;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
  // Always explicit: omitting the field on resume keeps the thread's previous
  // reviewer, which would leave auto_review sticky after switching modes.
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    approvalsReviewer: config.approvalsReviewer,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  const reasoningEffort = input.effort ?? "medium";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: buildCodexDeveloperInstructions(input.interactionMode, {
        model,
        reasoningEffort,
      }),
    },
  };
}

/**
 * Build the `input` array shared by `turn/start` and `turn/steer`.
 */
export function buildCodexTurnInput(input: {
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}): Array<EffectCodexSchema.V2TurnStartParams__UserInput> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({ type: "text", text: input.prompt });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }
  return turnInput;
}

/**
 * Whether a new `sendTurn` should fold into the live turn via `turn/steer`
 * instead of opening a new one with `turn/start`.
 *
 * Mirrors `canSteerGrokSendTurn`. Returns the turn id to steer, or undefined
 * when there is nothing live to steer into.
 */
export function canSteerCodexSendTurn(input: {
  readonly status: string;
  readonly activeTurnId: TurnId | undefined;
}): TurnId | undefined {
  if (input.status !== "running") {
    return undefined;
  }
  return input.activeTurnId;
}

/**
 * Whether a `turn/steer` rejection means "this turn cannot be steered" rather
 * than a transport failure.
 *
 * The app-server documents this case as: *"Returned when `turn/start` or
 * `turn/steer` is submitted while the current active turn cannot accept
 * same-turn steering, for example `/review` or manual `/compact`."* When it
 * fires, the correct behaviour is to fall back to opening a new turn, not to
 * surface an error — the user's message must never be dropped.
 */
export function isCodexTurnNotSteerable(cause: unknown): boolean {
  const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  return (
    message.includes("same-turn steering") ||
    message.includes("cannot accept") ||
    message.includes("not steerable") ||
    // Precondition failure: expectedTurnId no longer matches the active turn.
    message.includes("expectedturnid")
  );
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput = buildCodexTurnInput({
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/start" },
      ),
    ),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export type OpenCodexThreadResult = {
  readonly response: CodexThreadOpenResponse;
  /** False when we started fresh (no resume, or resume soft-missed). */
  readonly resumedExistingThread: boolean;
};

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<OpenCodexThreadResult, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
  });

  if (resumeThreadId === undefined) {
    return input.client
      .request("thread/start", startParams)
      .pipe(Effect.map((response) => ({ response, resumedExistingThread: false })));
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.map((response) => ({ response, resumedExistingThread: true as const })),
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error,
        }).pipe(
          Effect.andThen(
            input.client
              .request("thread/start", startParams)
              .pipe(Effect.map((response) => ({ response, resumedExistingThread: false }))),
          ),
        ),
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...updates,
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const pendingApprovalTimeoutMs =
      options.pendingApprovalTimeoutMs ?? CODEX_PENDING_APPROVAL_TIMEOUT_MS;
    const pendingUserInputTimeoutMs =
      options.pendingUserInputTimeoutMs ?? CODEX_PENDING_USER_INPUT_TIMEOUT_MS;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    /** Turns force-settled by Stop so late turn/completed notifications do not double-fire. */
    const forceSettledTurnIdsRef = yield* Ref.make(new Set<string>());
    /**
     * Turns for which we already emitted synthetic turn/started after turn/start
     * so a later native notification does not double-fire turn.started in the UI.
     */
    const earlyTurnStartedIdsRef = yield* Ref.make(new Set<string>());
    /**
     * When true, the next sendTurn may inject Studio conversationHistory
     * (fresh thread start or recoverable resume miss).
     */
    const needsContextRehydrationRef = yield* Ref.make(false);
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...options.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const extendEnv = options.environment === undefined;
    const appServerArgs = codexSessionAppServerArgs(options.appServerArgs, options.launchArgs);
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
      env,
      extendEnv,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          extendEnv,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = (purpose: CodexErrors.CodexAppServerIdentifierPurpose) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerIdentifierGenerationError({
              purpose,
              cause,
            }),
        ),
      );

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4("provider-event");
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const awaitApprovalDecision = (
      decision: Deferred.Deferred<ProviderApprovalDecision>,
      meta: {
        readonly requestId: ApprovalRequestId;
        readonly requestKind: ProviderRequestKind;
        readonly turnId?: TurnId;
        readonly itemId?: ProviderItemId;
      },
    ) =>
      Effect.gen(function* () {
        const raceResult = yield* Effect.raceFirst(
          Deferred.await(decision).pipe(
            Effect.map((value) => ({ _tag: "decided" as const, value })),
          ),
          Effect.sleep(`${pendingApprovalTimeoutMs} millis`).pipe(
            Effect.as({ _tag: "timeout" as const }),
          ),
        );
        if (raceResult._tag === "timeout") {
          yield* Deferred.succeed(decision, "cancel").pipe(Effect.ignore);
          yield* Effect.logWarning("Codex approval request timed out; auto-cancelled", {
            threadId: options.threadId,
            requestId: meta.requestId,
            timeoutMs: pendingApprovalTimeoutMs,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "process/stderr",
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            message: `Permission request timed out after ${Math.round(pendingApprovalTimeoutMs / 1000)}s with no decision. Request was cancelled automatically.`,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: meta.requestId,
            requestKind: meta.requestKind,
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            ...(meta.itemId ? { itemId: meta.itemId } : {}),
            payload: {
              requestId: meta.requestId,
              requestKind: meta.requestKind,
              decision: "cancel" as const,
            },
          });
          return "cancel" as const satisfies ProviderApprovalDecision;
        }
        return raceResult.value;
      });

    const awaitUserInputAnswers = (
      answers: Deferred.Deferred<ProviderUserInputAnswers>,
      meta: {
        readonly requestId: ApprovalRequestId;
        readonly turnId?: TurnId;
        readonly itemId?: ProviderItemId;
      },
    ) =>
      Effect.gen(function* () {
        const raceResult = yield* Effect.raceFirst(
          Deferred.await(answers).pipe(
            Effect.map((value) => ({ _tag: "answered" as const, value })),
          ),
          Effect.sleep(`${pendingUserInputTimeoutMs} millis`).pipe(
            Effect.as({ _tag: "timeout" as const }),
          ),
        );
        if (raceResult._tag === "timeout") {
          yield* Deferred.succeed(answers, {}).pipe(Effect.ignore);
          yield* Effect.logWarning("Codex user-input request timed out; auto-cancelled", {
            threadId: options.threadId,
            requestId: meta.requestId,
            timeoutMs: pendingUserInputTimeoutMs,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "process/stderr",
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            message: `User input timed out after ${Math.round(pendingUserInputTimeoutMs / 1000)}s with no answer. Request was cancelled automatically.`,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: meta.requestId,
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            ...(meta.itemId ? { itemId: meta.itemId } : {}),
            payload: {
              answers: {},
            },
          });
          return {} as ProviderUserInputAnswers;
        }
        return raceResult.value;
      });

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const payload = notification.params;
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        if (childParentTurnId && shouldSuppressChildConversationNotification(notification.method)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);

        // Stop may already have force-settled this turn; skip the late
        // turn/completed event so Working does not double-complete.
        if (notification.method === "turn/completed" && turnId !== undefined) {
          const forceSettled = yield* Ref.get(forceSettledTurnIdsRef);
          if (forceSettled.has(String(turnId))) {
            return;
          }
        }

        // sendTurn already emitted synthetic turn/started for chrome honesty;
        // drop the native duplicate so the UI does not see two start events.
        if (notification.method === "turn/started" && turnId !== undefined) {
          const earlyStarted = yield* Ref.get(earlyTurnStartedIdsRef);
          if (earlyStarted.has(String(turnId))) {
            yield* Ref.update(earlyTurnStartedIdsRef, (current) => {
              const next = new Set(current);
              next.delete(String(turnId));
              return next;
            });
            return;
          }
        }

        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? extractProviderErrorMessage(payload.turn.error.message)
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = extractProviderErrorMessage(payload.error.message);
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("command-approval-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* awaitApprovalDecision(decision, {
          requestId,
          requestKind: "command",
          turnId,
          itemId,
        }).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(
          yield* randomUUIDv4("file-change-approval-request"),
        );
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* awaitApprovalDecision(decision, {
          requestId,
          requestKind: "file-change",
          turnId,
          itemId,
        }).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* awaitUserInputAnswers(answers, {
          requestId,
          turnId,
          itemId,
        }).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      yield* Ref.set(needsContextRehydrationRef, !opened.resumedExistingThread);
      if (!opened.resumedExistingThread) {
        yield* Effect.logInfo(
          "Codex thread started without native resume; Studio history rehydration armed",
          {
            threadId: options.threadId,
            hadResumeCursor: readResumeCursorThreadId(options.resumeCursor) !== undefined,
            providerThreadId: opened.response.thread.id,
          },
        );
      }

      const providerThreadId = opened.response.thread.id;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.response.cwd,
        model: opened.response.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          if (hasConfiguredMcpServer(options.appServerArgs)) {
            yield* client.request("config/mcpServer/reload", undefined).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to refresh Codex MCP tool catalog before turn.", {
                  cause,
                }),
              ),
            );
          }
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );

          let promptText = input.input;
          const needsRehydration = yield* Ref.get(needsContextRehydrationRef);
          if (needsRehydration) {
            const history = input.conversationHistory ?? [];
            const toolSummaries = input.recentToolSummaries ?? [];
            if (history.length > 0 || toolSummaries.length > 0) {
              const prefix = buildConversationRehydrationPrefix(history, {
                reason:
                  "This Toolport Studio thread has prior conversation history that is not loaded in the current Codex thread (common after app restart, update, or resume miss).",
                ...(toolSummaries.length > 0 ? { toolSummaries } : {}),
              });
              if (prefix) {
                const latest = promptText?.trim() ?? "";
                promptText = latest.length > 0 ? `${prefix}${latest}` : `${prefix}(continue)`;
                yield* Effect.logInfo("Codex cold-start rehydration applied from Studio history", {
                  threadId: options.threadId,
                  historyTurns: history.length,
                  toolSummaries: toolSummaries.length,
                });
              }
            }
            yield* Ref.set(needsContextRehydrationRef, false);
          }

          // Steer the live turn when one is active. Codex exposes a native
          // `turn/steer`; without it a mid-turn send opened a second competing
          // turn while the first was still running (SOU-421), which is not what
          // the composer's "Following up" chrome promises.
          const liveSession = yield* Ref.get(sessionRef);
          const steerTargetTurnId = canSteerCodexSendTurn({
            status: liveSession.status,
            activeTurnId: liveSession.activeTurnId,
          });
          if (steerTargetTurnId) {
            const steerInput = buildCodexTurnInput({
              ...(promptText ? { prompt: promptText } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
            });
            const steered = yield* client.raw
              .request("turn/steer", {
                threadId: providerThreadId,
                expectedTurnId: String(steerTargetTurnId),
                input: steerInput,
              })
              .pipe(
                Effect.asSome,
                Effect.catchCause(() => Effect.succeed(Option.none())),
              );

            if (Option.isSome(steered)) {
              const resumedThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
              return {
                threadId: options.threadId,
                // Same turn id: the message folded into the live turn.
                turnId: steerTargetTurnId,
                ...(resumedThreadId ? { resumeCursor: { threadId: resumedThreadId } } : {}),
              } satisfies ProviderTurnStartResult;
            }
            // Steer rejected (turn not steerable, or the precondition no longer
            // holds). Fall through to turn/start so the message is never lost.
            yield* Effect.logInfo("Codex turn/steer rejected; opening a new turn instead", {
              threadId: options.threadId,
              expectedTurnId: String(steerTargetTurnId),
            });
          }

          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(promptText ? { prompt: promptText } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          });
          const rawResponse = yield* client.raw.request("turn/start", params);
          const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                "decode-response-payload",
                error,
                { method: "turn/start" },
              ),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
          // Surface Working chrome as soon as turn/start returns; native
          // turn/started can lag slightly after the RPC response.
          yield* Ref.update(earlyTurnStartedIdsRef, (current) => {
            const next = new Set(current);
            next.add(String(turnId));
            return next;
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "turn/started",
            turnId,
            payload: {
              turn: response.turn,
              threadId: providerThreadId,
            },
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;

          // Clear open permission / user-input waits so Stop never leaves the
          // UI on a dead approval panel (Cursor/Grok parity).
          yield* settlePendingApprovals("cancel");
          yield* settlePendingUserInputs({});

          if (!effectiveTurnId) {
            // Still force ready if session is stuck running without a turn id.
            if (session.status === "running" || session.status === "starting") {
              yield* updateSession(sessionRef, {
                status: "ready",
                activeTurnId: undefined,
              });
            }
            return;
          }

          // Force-settle before turn/interrupt. App-server interrupt can hang;
          // Working must clear even when the RPC never returns.
          const alreadySettled = (yield* Ref.get(forceSettledTurnIdsRef)).has(
            String(effectiveTurnId),
          );
          if (!alreadySettled) {
            yield* Ref.update(forceSettledTurnIdsRef, (current) => {
              const next = new Set(current);
              next.add(String(effectiveTurnId));
              return next;
            });
            yield* updateSession(sessionRef, {
              status: "ready",
              activeTurnId: undefined,
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              turnId: effectiveTurnId,
              method: "turn/completed",
              payload: {
                threadId: providerThreadId,
                turn: {
                  id: String(effectiveTurnId),
                  status: "interrupted",
                  items: [],
                },
              },
            });
          }

          yield* client
            .request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: effectiveTurnId,
            })
            .pipe(Effect.timeout("2 seconds"), Effect.ignore);
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          return parseThreadSnapshot(response);
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
