/**
 * Codex binding for the core-loop conformance contract (SOU-426).
 *
 * Second member of the in-process fake family: `makeCodexAdapter` takes a
 * `runtimeFactory` seam, so the fake is a `CodexSessionRuntimeShape` whose
 * events are pushed onto a queue.
 *
 * The fake models the real app-server faithfully on the one point this
 * contract turns on: `turn/start` always mints a **new** turn id. Codex has no
 * interject primitive, and `CodexAdapter.sendTurn` makes no attempt to reuse
 * or preempt a live turn — so `send-while-running-has-one-behavior` is
 * expected to fail against a `steer` declaration. That failure is SOU-421,
 * surfaced as a test rather than an audit note.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  CodexSettings,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeCodexAdapter } from "../../Layers/CodexAdapter.ts";
import type { CodexAdapterShape } from "../../Services/CodexAdapter.ts";
import type { CodexSessionRuntimeShape } from "../../Layers/CodexSessionRuntime.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type { ConformanceBinding, ConformanceScript, ConformanceSession } from "../contract.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const THREAD_ID = ThreadId.make("conformance-codex-thread");
const PROVIDER_THREAD_ID = "conformance-codex-provider-thread";
const NOW = "2026-01-01T00:00:00.000Z";

const pollSchedule = Schedule.spaced("10 millis");

const isConformanceHarnessError = Schema.is(ConformanceHarnessError);

/**
 * The adapter records session bindings through this service; conformance does
 * not exercise directory behaviour, so it is stubbed rather than mocked.
 */
const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in conformance")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

class CodexConformanceAdapter extends Context.Service<CodexConformanceAdapter, CodexAdapterShape>()(
  "t3/provider/conformance/bindings/codex/CodexConformanceAdapter",
) {}

/**
 * Fake Codex app-server runtime. Mirrors `FakeCodexRuntime` in
 * CodexAdapter.test.ts, kept separate so conformance cannot be loosened by an
 * edit to that file's private harness.
 */
class ScriptedCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private turnSeq = 0;

  public lastTurnId: TurnId | undefined;
  private turnActive = false;

  private readonly options: { readonly runtimeMode: string; readonly cwd: string };

  constructor(options: { readonly runtimeMode: string; readonly cwd: string }) {
    this.options = options;
  }

  private session() {
    return {
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode as never,
      threadId: THREAD_ID,
      cwd: this.options.cwd,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  start() {
    return Effect.succeed(this.session() as never);
  }

  getSession = Effect.sync(() => this.session() as never);

  sendTurn() {
    // Models the real runtime's turn/steer path: while a turn is live the new
    // input folds into it and the same turn id comes back. Only an idle
    // session mints a new turn id via turn/start.
    //
    // NOTE: the actual `turn/steer` RPC lives in CodexSessionRuntime, which
    // this fake replaces wholesale — so this case asserts the *adapter*
    // propagates steer, not that the RPC is issued. The RPC decision logic is
    // covered directly by `canSteerCodexSendTurn` tests in
    // CodexSessionRuntime.test.ts.
    if (this.turnActive && this.lastTurnId) {
      return Effect.succeed({ threadId: THREAD_ID, turnId: this.lastTurnId } as never);
    }
    this.turnSeq += 1;
    const turnId = TurnId.make(`codex-turn-${this.turnSeq}`);
    this.lastTurnId = turnId;
    this.turnActive = true;
    return Effect.succeed({ threadId: THREAD_ID, turnId } as never);
  }

  interruptTurn(turnId?: TurnId) {
    const target = turnId ?? this.lastTurnId ?? TurnId.make("codex-turn-1");
    this.turnActive = false;
    return this.emit({
      id: `evt-interrupt-${String(target)}` as never,
      kind: "notification",
      provider: ProviderDriverKind.make("codex"),
      createdAt: NOW,
      method: "turn/completed",
      threadId: THREAD_ID as never,
      turnId: target as never,
      payload: {
        threadId: PROVIDER_THREAD_ID,
        turn: { id: String(target), status: "interrupted", items: [] },
      },
    } as ProviderEvent);
  }

  readThread = Effect.succeed({ threadId: PROVIDER_THREAD_ID, turns: [] } as never);

  rollbackThread() {
    return Effect.succeed({ threadId: PROVIDER_THREAD_ID, turns: [] } as never);
  }

  respondToRequest() {
    return Effect.void as never;
  }

  respondToUserInput() {
    return Effect.void as never;
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.void;

  /** Called by the script when a turn reaches a terminal state. */
  markTurnSettled(): void {
    this.turnActive = false;
  }

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

/** Translate the neutral script vocabulary into Codex app-server events. */
function playScript(
  runtime: ScriptedCodexRuntime,
  script: ConformanceScript,
  turnId: TurnId,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let seq = 0;
    const nextId = (label: string) => `evt-${label}-${String(turnId)}-${(seq += 1)}`;
    const base = {
      kind: "notification" as const,
      provider: ProviderDriverKind.make("codex"),
      createdAt: NOW,
      threadId: THREAD_ID as never,
      turnId: turnId as never,
    };

    yield* runtime.emit({
      ...base,
      id: nextId("turn-started") as never,
      method: "turn/started",
      payload: { threadId: PROVIDER_THREAD_ID, turn: { id: String(turnId), status: "active" } },
    } as ProviderEvent);

    for (const step of script) {
      switch (step.kind) {
        case "assistant-text": {
          yield* runtime.emit({
            ...base,
            id: nextId("delta") as never,
            method: "item/agentMessage/delta",
            itemId: `msg-${String(turnId)}` as never,
            payload: {
              threadId: PROVIDER_THREAD_ID,
              turnId: String(turnId),
              itemId: `msg-${String(turnId)}`,
              delta: step.text,
            },
          } as ProviderEvent);
          break;
        }
        case "tool-start": {
          yield* runtime.emit({
            ...base,
            id: nextId("item-started") as never,
            method: "item/started",
            itemId: step.toolId as never,
            payload: {
              threadId: PROVIDER_THREAD_ID,
              turnId: String(turnId),
              item: { type: "commandExecution", id: step.toolId, command: step.name },
            },
          } as ProviderEvent);
          break;
        }
        case "tool-end": {
          yield* runtime.emit({
            ...base,
            id: nextId("item-completed") as never,
            method: "item/completed",
            itemId: step.toolId as never,
            payload: {
              threadId: PROVIDER_THREAD_ID,
              turnId: String(turnId),
              item: { type: "commandExecution", id: step.toolId, command: "done" },
            },
          } as ProviderEvent);
          break;
        }
        case "complete": {
          runtime.markTurnSettled();
          yield* runtime.emit({
            ...base,
            id: nextId("turn-completed") as never,
            method: "turn/completed",
            payload: {
              threadId: PROVIDER_THREAD_ID,
              turn: { id: String(turnId), status: "completed", items: [] },
            },
          } as ProviderEvent);
          break;
        }
        case "die": {
          yield* runtime.emit({
            ...base,
            id: nextId("session-exited") as never,
            method: "session/exited",
            payload: { threadId: PROVIDER_THREAD_ID, detail: step.detail },
          } as ProviderEvent);
          break;
        }
        case "hang": {
          // Emit nothing further: the turn stays open, which is the point.
          return;
        }
        case "approval-request": {
          yield* runtime.emit({
            ...base,
            id: nextId("approval") as never,
            method: "item/commandExecution/requestApproval",
            requestId: step.requestId as never,
            requestKind: "commandExecution" as never,
            payload: {
              threadId: PROVIDER_THREAD_ID,
              turnId: String(turnId),
              itemId: step.requestId,
              command: step.toolName,
              reason: "conformance approval",
            },
          } as ProviderEvent);
          // Leave the turn open so Stop can settle while the request is pending.
          return;
        }
      }
    }
  });
}

export const codexConformanceBinding: ConformanceBinding = {
  provider: "codex",
  // Declared to match what the client actually does: the composer sends
  // `intent: "steer"` for every provider. If Codex cannot honour that, the
  // contract must say so out loud rather than let the UI keep promising it.
  sendWhileRunning: "steer",
  openSession: (script) =>
    Effect.gen(function* () {
      const runtime = new ScriptedCodexRuntime({
        runtimeMode: "full-access",
        cwd: "/tmp/conformance-codex",
      });

      const layer = Layer.effect(
        CodexConformanceAdapter,
        Effect.gen(function* () {
          const settings = decodeCodexSettings({});
          return yield* makeCodexAdapter(settings, {
            makeRuntime: () => Effect.succeed(runtime),
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest("/tmp/conformance-codex", "/tmp")),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const context = yield* Layer.build(layer);
      const adapter = yield* Effect.service(CodexConformanceAdapter).pipe(Effect.provide(context));

      const observed = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(observed, (current) => [...current, event])),
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "full-access",
      });

      const session: ConformanceSession = {
        adapter: adapter as never,
        threadId: THREAD_ID,
        events: Ref.get(observed),
        sendScriptedTurn: ({ text, script: turnScript }) =>
          Effect.gen(function* () {
            const result = yield* adapter.sendTurn({
              threadId: THREAD_ID,
              input: text,
              attachments: [],
            });
            yield* playScript(runtime, turnScript, result.turnId);
          }) as never,
        awaitEvent: (predicate, options) =>
          Ref.get(observed).pipe(
            Effect.map((events) => events.find(predicate)),
            Effect.repeat({ while: (found) => found === undefined, schedule: pollSchedule }),
            Effect.timeoutOption(`${options?.timeoutMs ?? 5_000} millis`),
            Effect.flatMap((result) =>
              Option.isSome(result) && result.value !== undefined
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new ConformanceHarnessError({
                      provider: "codex",
                      detail: `timed out waiting for ${options?.describe ?? "matching event"}`,
                    }),
                  ),
            ),
          ),
      };

      void script;

      return session;
    }).pipe(
      Effect.mapError((cause) =>
        isConformanceHarnessError(cause)
          ? cause
          : new ConformanceHarnessError({
              provider: "codex",
              detail: `failed to open conformance session: ${String(cause)}`,
            }),
      ),
    ),
};
