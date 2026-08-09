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

import { PROVIDER_TURN_CAPABILITIES } from "../../turnEngine/index.ts";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@toolport-studio/contracts";
import { createModelSelection } from "@toolport-studio/shared/model";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeOpenCodeAdapter } from "../../Layers/OpenCodeAdapter.ts";
import { OpenCodeRuntime, OpenCodeRuntimeError } from "../../opencodeRuntime.ts";
import type { OpenCodeRuntimeShape } from "../../opencodeRuntime.ts";
import type { OpenCodeAdapterShape } from "../../Services/OpenCodeAdapter.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type {
  ConformanceBinding,
  ConformanceOpenSessionOptions,
  ConformanceScript,
  ConformanceSession,
} from "../contract.ts";

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
  const toolNames = new Map<string, string>();
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
        toolNames.set(step.toolId, step.name);
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
      case "tool-untitled-update": {
        const tool = toolNames.get(step.toolId);
        if (tool === undefined) {
          throw new Error(`untitled update references unknown tool ${step.toolId}`);
        }
        events.push({
          type: "message.part.updated",
          properties: {
            sessionID: SESSION_ID,
            part: {
              id: step.toolId,
              messageID: messageId,
              sessionID: SESSION_ID,
              type: "tool",
              tool,
              state: { status: "running", time: { start: 1 } },
            },
            time: 2,
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
        events.push({
          type: "permission.asked",
          properties: {
            id: step.requestId,
            sessionID: SESSION_ID,
            permission: "edit",
            patterns: [step.toolName],
            metadata: {},
          },
        });
        // Leave the turn open so Stop can settle while permission is pending.
        return;
      }
    }
  }
}

function makeRuntimeDouble(
  events: PushableEvents,
  /**
   * Inbound prompt text, in arrival order. The only evidence a mid-turn send
   * reached the provider: a steer reuses the live turn id, so runtime events
   * cannot tell a delivered follow-up from a dropped one.
   */
  promptsSeen: Array<string>,
): OpenCodeRuntimeShape {
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
          // Declaring the parameter is the point: this previously took none, so
          // the text the adapter sent was discarded and delivery could not be
          // asserted for OpenCode. The adapter passes it as
          // `parts: [{ type: "text", text }]`.
          promptAsync: async (input?: { readonly parts?: ReadonlyArray<unknown> }) => {
            // The real server announces that this session is busy before it
            // later reports idle. Terminal ownership uses that edge to bind
            // id-less session.status events to the accepted turn.
            events.push({
              type: "session.status",
              properties: { sessionID: SESSION_ID, status: { type: "busy" } },
            });
            for (const part of input?.parts ?? []) {
              const text = (part as { text?: unknown } | undefined)?.text;
              if (typeof text === "string") {
                promptsSeen.push(text);
              }
            }
          },
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
  sendWhileRunning: PROVIDER_TURN_CAPABILITIES.opencode.sendWhileRunning,
  openSession: (script, options?: ConformanceOpenSessionOptions) =>
    Effect.gen(function* () {
      const events = new PushableEvents();
      const promptsSeen: Array<string> = [];

      const layer = Layer.effect(
        OpenCodeConformanceAdapter,
        makeOpenCodeAdapter(openCodeSettings),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, makeRuntimeDouble(events, promptsSeen))),
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
        ...(options?.resumeCursor !== undefined
          ? { resumeCursor: options.resumeCursor as never }
          : {}),
      });

      let turnSeq = 0;

      const session: ConformanceSession = {
        adapter: adapter as never,
        threadId: THREAD_ID,
        events: Ref.get(observed),
        readResumeCursor: Effect.suspend(() =>
          adapter
            .listSessions()
            .pipe(
              Effect.map(
                (sessions) =>
                  sessions.find((entry) => String(entry.threadId) === String(THREAD_ID))
                    ?.resumeCursor,
              ),
            ),
        ),
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
        // Snapshot, not the live array: the runner polls this on a schedule, so
        // handing out the mutable array would let a later push change a result
        // it already read.
        promptsReceived: Effect.sync(() => [...promptsSeen]),
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
