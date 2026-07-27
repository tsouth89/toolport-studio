/**
 * OpenCode binding for the core-loop conformance contract (SOU-426).
 *
 * A **third** injection style: neither an option seam (Claude, Codex) nor a
 * spawned subprocess (Grok, Cursor), but a service-layer replacement —
 * `Layer.succeed(OpenCodeRuntime, ...)`. Three styles across five providers is
 * itself an argument for SOU-428.
 *
 * The existing test double serves a fixed array from `event.subscribe`, which
 * ends as soon as it is drained. Conformance needs a stream that stays open
 * and can be pushed to while a turn runs, so the double here is backed by a
 * queue instead.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeOpenCodeAdapter } from "../../Layers/OpenCodeAdapter.ts";
import { OpenCodeRuntime, OpenCodeRuntimeError } from "../../opencodeRuntime.ts";
import type { OpenCodeRuntimeShape } from "../../opencodeRuntime.ts";
import type { OpenCodeAdapterShape } from "../../Services/OpenCodeAdapter.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type { ConformanceBinding, ConformanceScript, ConformanceSession } from "../contract.ts";

const THREAD_ID = ThreadId.make("conformance-opencode-thread");
const SERVER_URL = "http://127.0.0.1:9999";
const SESSION_ID = `${SERVER_URL}/session`;

const pollSchedule = Schedule.spaced("10 millis");

const isConformanceHarnessError = Schema.is(ConformanceHarnessError);

const openCodeSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: SERVER_URL,
  serverPassword: "conformance-password",
});

class OpenCodeConformanceAdapter extends Context.Service<
  OpenCodeConformanceAdapter,
  OpenCodeAdapterShape
>()("t3/provider/conformance/bindings/opencode/OpenCodeConformanceAdapter") {}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in conformance")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

/** Async queue backing an open-ended SDK event stream. */
class PushableEvents {
  private readonly pending: Array<unknown> = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private closed = false;

  push(event: unknown): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.pending.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  /** Arrow property so the generator can pull without aliasing `this`. */
  readonly stream = (): AsyncGenerator<unknown> => {
    const pull = async (): Promise<IteratorResult<unknown>> => {
      const next = this.pending.shift();
      if (next !== undefined) {
        return { done: false, value: next };
      }
      if (this.closed) {
        return { done: true, value: undefined };
      }
      return new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiters.push(resolve);
      });
    };

    return (async function* () {
      while (true) {
        const result = await pull();
        if (result.done) {
          return;
        }
        yield result.value;
      }
    })();
  };
}

/** Translate the neutral script vocabulary into OpenCode SDK events. */
function playScript(events: PushableEvents, script: ConformanceScript, seq: number): void {
  const messageId = `msg-${seq}`;
  events.push({
    type: "message.updated",
    properties: { sessionID: SESSION_ID, info: { id: messageId, role: "assistant" } },
  });

  for (const step of script) {
    switch (step.kind) {
      case "assistant-text": {
        events.push({
          type: "message.part.updated",
          properties: {
            sessionID: SESSION_ID,
            part: {
              id: `part-${seq}`,
              messageID: messageId,
              sessionID: SESSION_ID,
              type: "text",
              text: step.text,
            },
            time: 1,
          },
        });
        break;
      }
      case "tool-start": {
        events.push({
          type: "message.part.updated",
          properties: {
            sessionID: SESSION_ID,
            part: {
              id: step.toolId,
              messageID: messageId,
              sessionID: SESSION_ID,
              type: "tool",
              tool: step.name,
              state: { status: "running", time: { start: 1 } },
            },
            time: 1,
          },
        });
        break;
      }
      case "tool-end": {
        events.push({
          type: "message.part.updated",
          properties: {
            sessionID: SESSION_ID,
            part: {
              id: step.toolId,
              messageID: messageId,
              sessionID: SESSION_ID,
              type: "tool",
              tool: "done",
              state: { status: "completed", time: { start: 1, end: 2 } },
            },
            time: 2,
          },
        });
        break;
      }
      case "complete": {
        events.push({
          type: "message.updated",
          properties: {
            sessionID: SESSION_ID,
            info: { id: messageId, role: "assistant", time: { created: 1, completed: 2 } },
          },
        });
        // The completed message alone does not terminalize the turn. OpenCode
        // ends a turn with `session.status` carrying `status.type: "idle"` —
        // not a distinct `session.idle` event.
        events.push({
          type: "session.status",
          properties: { sessionID: SESSION_ID, status: { type: "idle" } },
        });
        break;
      }
      case "die": {
        events.push({
          type: "session.error",
          properties: { sessionID: SESSION_ID, error: { message: step.detail } },
        });
        break;
      }
      case "hang": {
        // Emit nothing further: the turn stays open.
        return;
      }
      case "approval-request": {
        // Listed in the runner's NOT_YET_IMPLEMENTED set.
        break;
      }
    }
  }
}

function makeRuntimeDouble(events: PushableEvents): OpenCodeRuntimeShape {
  const unusedInventory = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `${operation} is not used in conformance`,
        cause: null,
      }),
    );

  return {
    startOpenCodeServerProcess: () => Effect.succeed({ url: SERVER_URL, exitCode: Effect.never }),
    connectToOpenCodeServer: ({ serverUrl }) =>
      Effect.succeed({
        url: serverUrl ?? SERVER_URL,
        exitCode: null,
        external: Boolean(serverUrl),
      }),
    runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
    createOpenCodeSdkClient: () =>
      ({
        session: {
          create: async () => ({ data: { id: SESSION_ID } }),
          get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
          update: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
          fork: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: `${sessionID}_fork` },
          }),
          abort: async () => {
            // Abort returns the session to idle, mirroring the real server.
            events.push({
              type: "session.status",
              properties: { sessionID: SESSION_ID, status: { type: "idle" } },
            });
          },
          promptAsync: async () => {},
          messages: async () => ({ data: [] }),
          revert: async () => {},
        },
        event: {
          subscribe: async () => ({ stream: events.stream() }),
        },
        mcp: {
          add: async () => ({ data: true }),
          disconnect: async () => ({ data: true }),
        },
      }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
    loadOpenCodeInventory: () => unusedInventory("loadOpenCodeInventory"),
    loadInventoryFromCli: () => unusedInventory("loadInventoryFromCli"),
  };
}

export const openCodeConformanceBinding: ConformanceBinding = {
  provider: "opencode",
  sendWhileRunning: "steer",
  openSession: (script) =>
    Effect.gen(function* () {
      const events = new PushableEvents();

      const layer = Layer.effect(
        OpenCodeConformanceAdapter,
        makeOpenCodeAdapter(openCodeSettings),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, makeRuntimeDouble(events))),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const context = yield* Layer.build(layer);
      const adapter = yield* Effect.service(OpenCodeConformanceAdapter).pipe(
        Effect.provide(context),
      );

      const observed = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(observed, (current) => [...current, event])),
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("opencode"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      let turnSeq = 0;

      const session: ConformanceSession = {
        adapter: adapter as never,
        threadId: THREAD_ID,
        events: Ref.get(observed),
        sendScriptedTurn: ({ text, script: turnScript }) =>
          Effect.gen(function* () {
            yield* adapter.sendTurn({
              threadId: THREAD_ID,
              input: text,
              attachments: [],
              // OpenCode validates a `provider/model` selection on every turn.
              modelSelection: createModelSelection(
                ProviderInstanceId.make("opencode"),
                "anthropic/sonnet",
              ),
            });
            turnSeq += 1;
            playScript(events, turnScript, turnSeq);
          }) as never,
        awaitEvent: (predicate, options) =>
          Ref.get(observed).pipe(
            Effect.map((current) => current.find(predicate)),
            Effect.repeat({ while: (found) => found === undefined, schedule: pollSchedule }),
            Effect.timeoutOption(`${options?.timeoutMs ?? 5_000} millis`),
            Effect.flatMap((result) =>
              Option.isSome(result) && result.value !== undefined
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new ConformanceHarnessError({
                      provider: "opencode",
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
              provider: "opencode",
              detail: `failed to open conformance session: ${String(cause)}`,
            }),
      ),
    ),
};
