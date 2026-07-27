// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  appendGrokConversationText,
  buildGrokContextRehydrationPrefix,
  buildGrokImagePromptPart,
  buildGrokSilentTurnStopMessage,
  canSteerGrokSendTurn,
  classifyGrokSilentTurn,
  formatGrokSilentTurnWorkSummary,
  grokPromptSettlementBelongsToContext,
  isGrokLongRunningToolKind,
  makeGrokAdapter,
  resolveGrokOpenToolWatchdogMs,
  slimGrokStreamDeltaNativeLog,
} from "./GrokAdapter.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

it("classifies Grok silence by active tool, completed tool loop, or pure thinking", () => {
  // Product default: never auto-stop while a tool is still open (quiet tools are valid work).
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 90_000,
      openToolCount: 1,
      hasObservedToolCall: true,
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5_000,
      openToolSilentMs: 90_000,
      openToolCount: 1,
      hasObservedToolCall: true,
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5_000,
      openToolSilentMs: 15 * 60_000,
      openToolCount: 1,
      openToolKinds: ["execute"],
      hasObservedToolCall: true,
    }),
    null,
  );
  // Opt-in kill path (tests / future setting): tool clock only, not stream thought.
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 90_000,
      openToolCount: 1,
      hasObservedToolCall: true,
      thresholds: { killOpenToolsOnSilence: true },
    }),
    "open-tool",
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5_000,
      openToolSilentMs: 90_000,
      openToolCount: 1,
      hasObservedToolCall: true,
      thresholds: { killOpenToolsOnSilence: true },
    }),
    "open-tool",
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 90_000,
      openToolSilentMs: 10_000,
      openToolCount: 1,
      hasObservedToolCall: true,
      thresholds: { killOpenToolsOnSilence: true },
    }),
    null,
  );
  // Execute tools get a longer ceiling when kill is enabled; 90s is not enough.
  assert.isTrue(isGrokLongRunningToolKind("execute"));
  assert.isFalse(isGrokLongRunningToolKind("search"));
  assert.equal(resolveGrokOpenToolWatchdogMs({ openToolKinds: ["execute"] }), 15 * 60_000);
  assert.equal(resolveGrokOpenToolWatchdogMs({ openToolKinds: ["search"] }), 90_000);
  assert.equal(resolveGrokOpenToolWatchdogMs({ openToolKinds: ["execute", "search"] }), 90_000);
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5_000,
      openToolSilentMs: 120_000,
      openToolCount: 1,
      openToolKinds: ["execute"],
      hasObservedToolCall: true,
      thresholds: { killOpenToolsOnSilence: true },
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5_000,
      openToolSilentMs: 15 * 60_000,
      openToolCount: 1,
      openToolKinds: ["execute"],
      hasObservedToolCall: true,
      thresholds: { killOpenToolsOnSilence: true },
    }),
    "open-tool",
  );
  // SOU-399: multi-tool planning gaps of several minutes must not hard-stop.
  // Default post-tool ceiling matches pure-think (15m), not the old 2m knife.
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 122_000,
      openToolCount: 0,
      hasObservedToolCall: true,
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 5 * 60_000,
      openToolCount: 0,
      hasObservedToolCall: true,
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 15 * 60_000,
      openToolCount: 0,
      hasObservedToolCall: true,
    }),
    "post-tool",
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 120_000,
      openToolCount: 0,
      hasObservedToolCall: false,
    }),
    null,
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 15 * 60_000,
      openToolCount: 0,
      hasObservedToolCall: false,
    }),
    "thinking",
  );
  assert.equal(
    classifyGrokSilentTurn({
      silentMs: 250,
      openToolCount: 0,
      hasObservedToolCall: true,
      thresholds: { postToolMs: 200 },
    }),
    "post-tool",
  );
  assert.match(
    buildGrokSilentTurnStopMessage({
      silentTurnKind: "post-tool",
      silentMs: 125_000,
    }),
    /stopped responding after its last tool completed/i,
  );
  assert.equal(
    formatGrokSilentTurnWorkSummary(["Terminal", "Grep"]),
    "Work before stop: Terminal; Grep.",
  );
  assert.match(
    buildGrokSilentTurnStopMessage({
      silentTurnKind: "post-tool",
      silentMs: 125_000,
      completedToolTitles: ["Terminal", "Grep"],
    }),
    /Work before stop: Terminal; Grep\./,
  );
  assert.match(
    buildGrokSilentTurnStopMessage({
      silentTurnKind: "open-tool",
      silentMs: 90_000,
      toolLabel: "Search",
    }),
    /while Search was still running/i,
  );
});

it("slims high-frequency stream delta native logs but keeps text previews", () => {
  const slim = slimGrokStreamDeltaNativeLog("ContentDelta", {
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "late after cancel" },
    },
  });
  assert.equal(slim.kind, "ContentDelta");
  assert.equal(slim.textPreview, "late after cancel");
  assert.isFalse(JSON.stringify(slim).includes("sessionUpdate"));
});

it("refuses to steer into a cancelled/interrupted turn after Stop", () => {
  const liveTurn = TurnId.make("turn-live");
  const cancelledTurn = TurnId.make("turn-cancelled");
  assert.isTrue(
    canSteerGrokSendTurn({
      promptsInFlight: 1,
      activeTurnId: liveTurn,
      interruptedTurnIds: new Set(),
    }),
  );
  assert.isFalse(
    canSteerGrokSendTurn({
      promptsInFlight: 1,
      activeTurnId: cancelledTurn,
      interruptedTurnIds: new Set([cancelledTurn]),
    }),
  );
  assert.isFalse(
    canSteerGrokSendTurn({
      promptsInFlight: 0,
      activeTurnId: liveTurn,
      interruptedTurnIds: new Set(),
    }),
  );
  assert.isFalse(
    canSteerGrokSendTurn({
      promptsInFlight: 1,
      activeTurnId: undefined,
      interruptedTurnIds: new Set(),
    }),
  );
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

/** Spawn the ACP mock agent under Node. Script binaries are launched via process.execPath. */
function makeMockGrokBinaryAndEnv(extraEnv?: Record<string, string>): {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
} {
  return {
    binaryPath: mockAgentPath,
    environment: {
      ...process.env,
      ...extraEnv,
    },
  };
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie);

const makeMockTestAdapter = (
  extraEnv?: Record<string, string>,
  options?: Omit<NonNullable<Parameters<typeof makeGrokAdapter>[1]>, "environment">,
) => {
  const { binaryPath, environment } = makeMockGrokBinaryAndEnv(extraEnv);
  return makeTestAdapter(binaryPath, { ...options, environment });
};

it("merges consecutive conversation turns of the same role", () => {
  const withUser = appendGrokConversationText([], "user", "hello");
  const withAssistant = appendGrokConversationText(withUser, "assistant", "hi ");
  const withMoreAssistant = appendGrokConversationText(withAssistant, "assistant", "there");
  assert.deepStrictEqual(withMoreAssistant, [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
  ]);
});

it("builds a rehydration prefix from Studio-side conversation history", () => {
  const prefix = buildGrokContextRehydrationPrefix([
    { role: "user", text: "Secret code is zebra-42" },
    { role: "assistant", text: "Got it, zebra-42." },
  ]);
  assert.isString(prefix);
  assert.include(prefix ?? "", "Secret code is zebra-42");
  assert.include(prefix ?? "", "Got it, zebra-42.");
  assert.include(prefix ?? "", "Latest user message:");
  assert.isUndefined(buildGrokContextRehydrationPrefix([]));
});

it("requires a settlement to match the live Grok turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("uses an embedded resource when Grok disables native image prompt blocks", () => {
  assert.deepStrictEqual(
    buildGrokImagePromptPart({
      data: "aW1hZ2U=",
      mimeType: "image/png",
      uri: "file:///tmp/screenshot.png",
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: true,
      },
    }),
    {
      type: "resource",
      resource: {
        uri: "file:///tmp/screenshot.png",
        blob: "aW1hZ2U=",
        mimeType: "image/png",
      },
    },
  );
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("treats interrupting an unknown session as an idempotent no-op", () =>
    Effect.gen(function* () {
      const adapter = yield* makeMockTestAdapter();
      yield* adapter.interruptTurn(
        ThreadId.make("missing-grok-session"),
        TurnId.make("missing-grok-turn"),
      );
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mock-thread");
      const adapter = yield* makeMockTestAdapter();

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "grok");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello grok",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EXIT_LOG_PATH: exitLogPath,
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      // Process teardown is fire-and-forget on a forked fiber. On Windows the
      // child may exit without a POSIX SIGTERM delivery, so only assert that
      // stopSession completed and the session is gone.
      const sessions = yield* adapter.listSessions();
      assert.isUndefined(sessions.find((session) => session.threadId === threadId));
      void exitLogPath;
    }).pipe(TestClock.withLive),
  );

  it.effect("reports a Grok session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-ready-after-prompt");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_TOOL_CALLS: "1",
      });
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-cancels a permission request that sits unanswered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-approval-timeout");
      const adapter = yield* makeMockTestAdapter(
        {
          T3_ACP_EMIT_TOOL_CALLS: "1",
        },
        {
          // Short timeout so the test does not wait minutes.
          pendingApprovalTimeoutMs: 250,
        },
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened = yield* Deferred.make<void>();
      const requestResolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(requestOpened, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "request.resolved" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(requestResolved, event).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // Do not call respondToRequest — timeout must clear the hang.
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval then continue", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      const resolved = yield* Deferred.await(requestResolved).pipe(Effect.timeout("5 seconds"));
      assert.equal(resolved.payload.decision, "cancel");
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("8 seconds"));
      yield* Fiber.join(sendFiber).pipe(Effect.timeout("5 seconds"));

      const warnings = runtimeEvents.filter(
        (event) =>
          event.type === "runtime.warning" &&
          String(event.payload.message ?? "").includes("Permission request timed out"),
      );
      assert.isAtLeast(warnings.length, 1);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-preparation-failure-while-connecting");
      const adapter = yield* makeMockTestAdapter();

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      // Early turn.started means prep failure must still emit turn.completed so
      // Working cannot stick after a bad attachment/config.
      assert.equal(turnCompletedEvent?.type, "turn.completed");
      if (turnCompletedEvent?.type === "turn.completed") {
        assert.equal(turnCompletedEvent.payload.state, "failed");
        assert.match(String(turnCompletedEvent.payload.errorMessage ?? ""), /preparation failed/i);
      }
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes a Grok turn from xAI prompt completion when the prompt RPC hangs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-fallback");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "exercise fallback",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const eventTypes = runtimeEvents.map((event) => event.type);
      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join("");
      const terminalIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const assistantCompletionIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.threadId) === String(threadId) &&
          event.turnId === turnCompletedEvent?.turnId,
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterTerminal = runtimeEvents
        .slice(terminalIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );
      const toolTitles = runtimeEvents.flatMap((event) =>
        event.type === "item.updated" && event.payload.title ? [event.payload.title] : [],
      );

      assert.equal(sendTurnResult.threadId, threadId);
      assert.include(eventTypes, "turn.completed");
      assert.equal(content, "hello from mock");
      assert.isAtLeast(terminalIndex, 0);
      assert.isAtLeast(assistantCompletionIndex, 0);
      assert.isBelow(assistantCompletionIndex, terminalIndex);
      assert.deepEqual(outputAfterTerminal, []);
      assert.notInclude(toolTitles, "Child-only tool");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retains turn transcript when sendTurn is interrupted after prompt success", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-send-turn-interrupt-after-prompt");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
      });
      const contentDelta = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "interrupt after prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(contentDelta);
      for (let yieldAttempt = 0; yieldAttempt < 6; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(sendTurnFiber);
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not report a synthetic stop reason when xAI omits one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-missing-stop-reason");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: "1",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise missing stop reason",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.isNull(turnCompletedEvent?.payload.stopReason);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent Grok prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-after-full-silence");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-stop-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      // Only the intentional hang prompt blocks; after Stop the adapter recycles
      // the ACP process, so HANG_FIRST would re-hang the follow-up on a new process.
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_HANG_PROMPT_TEXT: "hang forever",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sessionIdBeforeStop = (session.resumeCursor as { sessionId?: string } | undefined)
        ?.sessionId;
      assert.equal(sessionIdBeforeStop, "mock-session-1");

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "hang forever",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("3 seconds"));
      // Do not require the cancelled sendTurn fiber to fully unwind before the
      // follow-up: dispose can leave late drain work racing, and the adapter
      // must accept the next message while the prior fiber settles.
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("3 seconds"), Effect.ignore);

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter
        .sendTurn({
          threadId,
          input: "continue after stop",
          attachments: [],
        })
        .pipe(Effect.timeout("10 seconds"));

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      // Fresh process after Stop must session/load the prior id so Grok keeps
      // conversation history (not a blank agent that forgot prior turns).
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/load"');
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some((entry) => {
          if (entry.method !== "session/load") return false;
          // Mock agent request log is raw JSON-RPC wire: method + params.
          const params = entry.params;
          return (
            typeof params === "object" &&
            params !== null &&
            "sessionId" in params &&
            (params as { sessionId?: unknown }).sessionId === sessionIdBeforeStop
          );
        }),
        "expected session/load of the pre-Stop Grok session after recycle",
      );
      const sessionsAfterFollowUp = yield* adapter.listSessions();
      const sessionAfterFollowUp = sessionsAfterFollowUp.find(
        (entry) => entry.threadId === threadId,
      );
      assert.deepStrictEqual(sessionAfterFollowUp?.resumeCursor, {
        schemaVersion: 1,
        sessionId: sessionIdBeforeStop,
      });

      // Same recovered thread must accept further multi-turn prompts (not just
      // the first follow-up after Stop).
      const secondFollowUpBefore = runtimeEvents.length;
      yield* adapter
        .sendTurn({
          threadId,
          input: "second message after recovered follow-up",
          attachments: [],
        })
        .pipe(Effect.timeout("5 seconds"));
      const secondFollowUpCompleted = runtimeEvents
        .slice(secondFollowUpBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(secondFollowUpCompleted, 1);
      assert.equal(secondFollowUpCompleted[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not silence-kill an open tool; Stop force-closes and settles", () =>
    Effect.gen(function* () {
      // Tool starts and never completes. Default product policy must leave it
      // running (no timeout kill). User Stop force-closes the tool and settles.
      const threadId = ThreadId.make("grok-open-tool-no-auto-kill");
      const adapter = yield* makeMockTestAdapter(
        {
          T3_ACP_EMIT_TOOL_START_THEN_HANG: "1",
        },
        {
          silentTurnWatchdog: {
            // Even with aggressive timers, open-tool kill stays off by default.
            openToolMs: 100,
            openExecuteToolMs: 100,
            postToolMs: 100,
            thinkMs: 100,
            pollMs: 40,
          },
        },
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const toolOpened = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<TurnId>();
      const toolForceClosed = yield* Deferred.make<void>();
      const turnCancelled =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "item.updated" &&
              (event.payload.status === "inProgress" || event.payload.status === "pending") &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(toolOpened, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "item.completed" &&
              event.payload.status === "failed" &&
              String(event.threadId) === String(threadId) &&
              (String(event.payload.detail ?? "").includes("did not complete") ||
                (event.payload.data as { forcedClose?: unknown } | undefined)?.forcedClose === true)
              ? Deferred.succeed(toolForceClosed, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "turn.completed" &&
              (event.payload.state === "cancelled" || event.payload.state === "failed") &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCancelled, event).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const hangFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "start a tool that never finishes",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const startedTurnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("8 seconds"));
      yield* Deferred.await(toolOpened).pipe(Effect.timeout("8 seconds"));

      // Wait well past the aggressive silence timers — must still be running.
      yield* Effect.sleep("600 millis");
      const sessionsWhileOpen = yield* adapter.listSessions();
      const openSession = sessionsWhileOpen.find((entry) => entry.threadId === threadId);
      assert.equal(openSession?.status, "running");
      assert.isUndefined(
        runtimeEvents.find(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        "open tool must not be silence-killed",
      );

      yield* adapter.interruptTurn(threadId, startedTurnId);
      const completed = yield* Deferred.await(turnCancelled).pipe(Effect.timeout("8 seconds"));
      assert.ok(
        completed.payload.state === "cancelled" || completed.payload.state === "failed",
        `expected cancelled or failed, got ${completed.payload.state}`,
      );
      yield* Deferred.await(toolForceClosed).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      const forceClosedEvents = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" &&
          event.payload.status === "failed" &&
          (String(event.payload.detail ?? "").includes("did not complete") ||
            (event.payload.data as { forcedClose?: unknown } | undefined)?.forcedClose === true),
      );
      assert.isAtLeast(forceClosedEvents.length, 1, "expected force-closed open tool after Stop");
      yield* Fiber.join(hangFiber).pipe(Effect.timeout("5 seconds"), Effect.ignore);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("opt-in killOpenToolsOnSilence still force-closes a stuck open tool", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-open-tool-stuck-watchdog");
      const adapter = yield* makeMockTestAdapter(
        {
          T3_ACP_EMIT_TOOL_START_THEN_HANG: "1",
        },
        {
          silentTurnWatchdog: {
            killOpenToolsOnSilence: true,
            openToolMs: 300,
            openExecuteToolMs: 300,
            postToolMs: 30_000,
            thinkMs: 30_000,
            pollMs: 50,
          },
        },
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const toolOpened = yield* Deferred.make<void>();
      const toolForceClosed = yield* Deferred.make<void>();
      const turnFailed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "item.updated" &&
              (event.payload.status === "inProgress" || event.payload.status === "pending") &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(toolOpened, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "item.completed" &&
              event.payload.status === "failed" &&
              String(event.threadId) === String(threadId) &&
              (String(event.payload.detail ?? "").includes("did not complete") ||
                (event.payload.data as { forcedClose?: unknown } | undefined)?.forcedClose === true)
              ? Deferred.succeed(toolForceClosed, undefined).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "turn.completed" &&
              event.payload.state === "failed" &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnFailed, event).pipe(Effect.ignore, Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const hangFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "start a tool that never finishes",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(toolOpened).pipe(Effect.timeout("8 seconds"));
      const failedEvent = yield* Deferred.await(turnFailed).pipe(Effect.timeout("10 seconds"));
      assert.match(
        String(failedEvent.payload.errorMessage ?? ""),
        /while .* was still running|still running/i,
      );
      yield* Deferred.await(toolForceClosed).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      const forceClosedEvents = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" &&
          event.payload.status === "failed" &&
          (String(event.payload.detail ?? "").includes("did not complete") ||
            (event.payload.data as { forcedClose?: unknown } | undefined)?.forcedClose === true),
      );
      assert.isAtLeast(forceClosedEvents.length, 1, "expected force-closed open tool");
      yield* Fiber.join(hangFiber).pipe(Effect.timeout("5 seconds"));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "auto-stops after post-tool silence and settles turn.completed without manual Stop",
    () =>
      Effect.gen(function* () {
        // Repro: tool completes, Grok goes silent, cancel wins the prompt RPC
        // as success — Studio must still emit failed turn.completed (not zombie Working).
        const threadId = ThreadId.make("grok-post-tool-silence-watchdog");
        const adapter = yield* makeMockTestAdapter(
          {
            T3_ACP_EMIT_TOOL_THEN_HANG: "1",
          },
          {
            silentTurnWatchdog: {
              openToolMs: 5_000,
              postToolMs: 400,
              thinkMs: 30_000,
              pollMs: 50,
            },
          },
        );

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const toolCompleted = yield* Deferred.make<void>();
        const turnFailed =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "item.completed" &&
                event.payload.itemType !== "assistant_message" &&
                String(event.threadId) === String(threadId)
                ? Deferred.succeed(toolCompleted, undefined).pipe(Effect.ignore, Effect.asVoid)
                : Effect.void,
            ),
            Effect.andThen(
              event.type === "turn.completed" &&
                event.payload.state === "failed" &&
                String(event.threadId) === String(threadId)
                ? Deferred.succeed(turnFailed, event).pipe(Effect.ignore, Effect.asVoid)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const hangFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "run a tool then go silent",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(toolCompleted).pipe(Effect.timeout("5 seconds"));
        const failedEvent = yield* Deferred.await(turnFailed).pipe(Effect.timeout("8 seconds"));
        assert.match(
          String(failedEvent.payload.errorMessage ?? ""),
          /stopped responding after its last tool completed/i,
        );
        assert.match(String(failedEvent.payload.errorMessage ?? ""), /Work before stop:/i);

        // sendTurn should complete (settle) without the parent needing Stop.
        yield* Fiber.join(hangFiber).pipe(Effect.timeout("5 seconds"));

        const sessions = yield* adapter.listSessions();
        const session = sessions.find((entry) => entry.threadId === threadId);
        assert.equal(session?.status, "ready");
        assert.isUndefined(session?.activeTurnId);

        // Follow-up must work without the user having pressed Stop.
        const followUpBefore = runtimeEvents.length;
        yield* adapter
          .sendTurn({
            threadId,
            input: "continue after auto-stop",
            attachments: [],
          })
          .pipe(Effect.timeout("10 seconds"));
        const followUpCompleted = runtimeEvents
          .slice(followUpBefore)
          .filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
              event.type === "turn.completed" &&
              String(event.threadId) === String(threadId) &&
              event.payload.state === "completed",
          );
        assert.lengthOf(followUpCompleted, 1);

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
  );

  it.effect("steers a mid-turn message by preempting the in-flight prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-steer-preempt");
      // First prompt hangs until cancel; steer must cancel it and run immediately.
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_HANG_PROMPT_TEXT: "work forever",
        T3_ACP_PROMPT_RESPONSE_TEXT: "steered reply",
      });

      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const steerCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "turn.started") {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(steerCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const hangFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "work forever on this task",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const liveTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("8 seconds"));

      // Without preemption this would block until the hang ends (never).
      const steered = yield* adapter
        .sendTurn({
          threadId,
          input: "stop and do this instead",
          attachments: [],
        })
        .pipe(Effect.timeout("12 seconds"));

      assert.equal(String(steered.turnId), String(liveTurnId));
      const completed = yield* Deferred.await(steerCompleted).pipe(Effect.timeout("8 seconds"));
      assert.equal(String(completed.turnId), String(liveTurnId));
      // Steer keeps one turn; hang fiber should also release after preempt.
      yield* Fiber.join(hangFiber).pipe(Effect.timeout("8 seconds"), Effect.ignore);

      // UI must learn the interjection immediately (not only when tools finish).
      const followingUp = runtimeEvents.find(
        (event) =>
          event.type === "runtime.warning" &&
          typeof event.payload?.message === "string" &&
          event.payload.message.includes("Following up:") &&
          event.payload.message.includes("stop and do this instead"),
      );
      assert.ok(followingUp, "steer must emit a Following up runtime.warning");

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "accepts an immediate follow-up after session-scoped Stop without preparation interrupt",
    () =>
      Effect.gen(function* () {
        // Mirrors production: ProviderCommandReactor interrupts by thread only
        // (no provider turn id). Follow-up must not reuse the cancelled turn.
        const threadId = ThreadId.make("grok-stop-session-scoped-followup");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-session-stop-followup-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const adapter = yield* makeMockTestAdapter({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_PROMPT: "1",
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const turnStarted = yield* Deferred.make<TurnId>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.started" &&
                event.turnId !== undefined &&
                String(event.threadId) === String(threadId)
                ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const hangFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "hang forever",
            attachments: [],
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
        // Session-scoped interrupt (no turn id), then follow-up without waiting
        // for the cancelled hang fiber — the user-visible Stop → Send path.
        yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("3 seconds"));

        // Must succeed (not fail preparation with the cancelled hang turn id).
        yield* adapter
          .sendTurn({
            threadId,
            input: "are you stuck? what happened?",
            attachments: [],
          })
          .pipe(Effect.timeout("10 seconds"));

        const prepFailures = runtimeEvents.filter(
          (event) =>
            event.type === "turn.completed" &&
            event.payload.state === "failed" &&
            String(event.payload.errorMessage ?? "").includes("interrupted during preparation"),
        );
        assert.lengthOf(
          prepFailures,
          0,
          "follow-up must not fail with interrupted-during-preparation",
        );
        const followUpCompleted = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" &&
            String(event.threadId) === String(threadId) &&
            event.payload.state === "completed",
        );
        assert.isAtLeast(followUpCompleted.length, 1);

        yield* Fiber.join(hangFiber).pipe(Effect.timeout("3 seconds"), Effect.ignore);
        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
  );

  it.effect("fails silent empty end_turn and recycles before the next message", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-silent-empty-end-turn");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMPTY_PROMPT_RESPONSE: "1",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "please respond",
          attachments: [],
        })
        .pipe(Effect.timeout("5 seconds"));

      const firstCompleted = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(firstCompleted, 1);
      assert.equal(firstCompleted[0]?.payload.state, "failed");
      assert.match(firstCompleted[0]?.payload.errorMessage ?? "", /without any visible response/i);

      // Next sendTurn must recycle and accept work. Keep empty responses so
      // recycle path is exercised even when the agent stays silent.
      const secondBefore = runtimeEvents.length;
      yield* adapter
        .sendTurn({
          threadId,
          input: "retry after silent failure",
          attachments: [],
        })
        .pipe(Effect.timeout("8 seconds"));
      const secondCompleted = runtimeEvents
        .slice(secondBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(secondCompleted, 1);
      assert.equal(secondCompleted[0]?.payload.state, "failed");

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_HANG_PROMPT_TEXT: "cancel this prompt",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"), Effect.ignore);
      // Follow-up may recycle the ACP process after force-cancel; allow extra time.
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("15 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("10 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-drop-late-cancelled-notifications");
      // Content deltas are not written to the native event log (stream perf).
      // Wait for the mock's post-cancel late update via wall clock, then assert
      // it never became a runtime content event.
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_HANG_PROMPT_FOREVER: "1",
        T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      // Allow prompt preparation to enter the hung ACP prompt before Stop so
      // cancel races the live prompt (not the early prep interrupt path).
      yield* Effect.sleep("200 millis");
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      // Mock emits the late update shortly after cancel; give the notification
      // consumer a beat to drop it.
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("lets Stop cancel during the xAI completion drain window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-during-completion-drain");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined);
      const trailingChunkTurnId = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started") {
            yield* Ref.set(activeTurnIdRef, event.turnId);
          }
          if (event.type !== "content.delta" || event.payload.delta !== "mock") {
            return;
          }
          const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef));
          if (turnId === undefined) {
            return;
          }
          yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel during completion drain",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-completion-before-next-turn");
      const adapter = yield* makeMockTestAdapter();
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a Grok session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-prompt-failure-ready");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_FAIL_PROMPT: "1",
      });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a Grok session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-load-replay-filter");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_EMIT_LOAD_REPLAY: "1",
      });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to a fresh session when the persisted Grok session path is gone", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stale-resume-path");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_FAIL_LOAD_SESSION_NOT_FOUND: "1",
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "stale-pre-rebuild-session" },
      });

      // session/load Path not found → session/new; resumeCursor points at the new id.
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.notEqual(
        (session.resumeCursor as { sessionId?: string } | undefined)?.sessionId,
        "stale-pre-rebuild-session",
      );

      yield* adapter.sendTurn({
        threadId,
        input: "hello after rebuild",
        attachments: [],
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps transcript rehydration armed when a post-Stop turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-rehydrate-after-stop");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-rehydrate-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      // Load always fails after recycle → blank session/new → must rehydrate.
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_HANG_PROMPT_TEXT: "hang forever",
        T3_ACP_HANG_PROMPT_TEXT_EXACT: "1",
        T3_ACP_FAIL_LOAD_SESSION_NOT_FOUND: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const hangTurnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId) &&
              // First completed turn is the seed; hang is the second turn.started
              runtimeEvents.some(
                (entry) =>
                  entry.type === "turn.completed" && String(entry.threadId) === String(threadId),
              )
              ? Deferred.succeed(hangTurnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Secret code is zebra-42",
        attachments: [],
      });

      const hangFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "hang forever",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const hangTurnId = yield* Deferred.await(hangTurnStarted).pipe(Effect.timeout("3 seconds"));
      yield* adapter.interruptTurn(threadId, hangTurnId).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(hangFiber).pipe(Effect.timeout("3 seconds"), Effect.ignore);

      // Cancel the first turn against the blank replacement session during
      // preparation, before session/prompt is sent. Rehydration must remain
      // armed for the next real prompt.
      const interruptedPreparationFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel before the prompt is sent",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(interruptedPreparationFiber).pipe(
        Effect.timeout("3 seconds"),
        Effect.ignore,
      );

      yield* adapter
        .sendTurn({
          threadId,
          input: "What was the secret code?",
          attachments: [],
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* waitForFileContent(requestLogPath, 80, "Secret code is zebra-42");
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const followUpPrompt = requests.find((entry) => {
        if (entry.method !== "session/prompt") return false;
        const params = entry.params;
        if (typeof params !== "object" || params === null || !("prompt" in params)) return false;
        const prompt = (params as { prompt?: unknown }).prompt;
        const serializedPrompt = JSON.stringify(prompt);
        return (
          serializedPrompt.includes("What was the secret code?") &&
          serializedPrompt.includes("Secret code is zebra-42")
        );
      });
      assert.isDefined(
        followUpPrompt,
        "expected follow-up session/prompt to rehydrate prior user secret",
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("cold-starts rehydrate conversationHistory when native session is not resumed", () =>
    Effect.gen(function* () {
      // Simulates open-prior-thread after app update: empty in-memory log, Studio
      // projects prior messages via conversationHistory on sendTurn.
      const threadId = ThreadId.make("grok-cold-start-rehydrate");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-cold-rehydrate-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "What was the secret code?",
          attachments: [],
          conversationHistory: [
            { role: "user", text: "Secret code is zebra-42" },
            { role: "assistant", text: "Got it, zebra-42." },
          ],
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* waitForFileContent(requestLogPath, 80, "Secret code is zebra-42");
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptWithHistory = requests.find((entry) => {
        if (entry.method !== "session/prompt") return false;
        const params = entry.params;
        if (typeof params !== "object" || params === null || !("prompt" in params)) return false;
        const serializedPrompt = JSON.stringify((params as { prompt?: unknown }).prompt);
        return (
          serializedPrompt.includes("What was the secret code?") &&
          serializedPrompt.includes("Secret code is zebra-42") &&
          serializedPrompt.includes("Got it, zebra-42.")
        );
      });
      assert.isDefined(
        promptWithHistory,
        "expected cold-start session/prompt to include Studio conversationHistory",
      );

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* makeMockTestAdapter();
      const threadId = ThreadId.make("grok-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-empty-turn");

      const adapter = yield* makeMockTestAdapter();

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const adapter = yield* makeMockTestAdapter({
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
      });
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const adapter = yield* makeMockTestAdapter({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" });
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const adapter = yield* makeMockTestAdapter(undefined, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
