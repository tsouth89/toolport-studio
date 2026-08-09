/**
 * Claude binding for the core-loop conformance contract (SOU-426).
 *
 * Claude represents the **in-process fake** family: the adapter takes a
 * `createQuery` seam, so the fake backend is a push-driven object and the
 * script is played imperatively after `sendTurn`. Codex and OpenCode have the
 * same shape (`runtimeFactory` / injected client) and will bind the same way.
 *
 * The other family is the ACP subprocess (Cursor, Grok), which spawns
 * `scripts/acp-mock-agent.ts` and is scripted through `TOOLPORT_STUDIO_ACP_*` env at spawn
 * time. That is why `openSession` takes the script up front — it is the only
 * signature both families can honour.
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
  ClaudeSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@toolport-studio/contracts";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeClaudeAdapter } from "../../Layers/ClaudeAdapter.ts";
import type { ClaudeAdapterShape } from "../../Services/ClaudeAdapter.ts";
import { PROVIDER_TURN_CAPABILITIES } from "../../turnEngine/index.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type {
  ConformanceBinding,
  ConformanceOpenSessionOptions,
  ConformanceScript,
  ConformanceSession,
} from "../contract.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const THREAD_ID = ThreadId.make("conformance-claude-thread");

const pollSchedule = Schedule.spaced("10 millis");

const isConformanceHarnessError = Schema.is(ConformanceHarnessError);

class ClaudeConformanceAdapter extends Context.Service<
  ClaudeConformanceAdapter,
  ClaudeAdapterShape
>()("t3/provider/conformance/bindings/claude/ClaudeConformanceAdapter") {}

/**
 * Minimal push-driven stand-in for the Claude Agent SDK query object. Mirrors
 * `FakeClaudeQuery` in ClaudeAdapter.test.ts, kept separate so conformance
 * cannot be quietly loosened by an edit to that file's private harness.
 */
class ScriptedClaudeQuery {
  private readonly pending: Array<unknown> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (cause: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public interruptCalls = 0;
  public closeCalls = 0;

  emit(message: unknown): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.pending.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls += 1;
    // The real SDK terminalizes the turn on interrupt; the fake must too, or
    // "Stop settles the session" would pass for the wrong reason.
    this.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Interrupted by user"],
      session_id: "conformance-session",
      uuid: `result-interrupt-${this.interruptCalls}`,
    });
  };

  readonly setModel = async (): Promise<void> => {};
  readonly setPermissionMode = async (): Promise<void> => {};
  readonly setMaxThinkingTokens = async (): Promise<void> => {};

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const next = this.pending.shift();
        if (next !== undefined) {
          return Promise.resolve({ done: false, value: next });
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/**
 * Flatten one inbound `SDKUserMessage` to searchable text.
 *
 * `follow-up-reaches-the-provider` only asks whether a marker string arrived, so
 * this favours not losing the marker over producing tidy output: recognised text
 * blocks are joined, and anything unrecognised falls back to its JSON so a shape
 * change cannot silently make the case pass by returning an empty string.
 */
function promptMessageToText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content.flatMap((block) => {
      const text = (block as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? [text] : [];
    });
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "";
  }
}

/** Translate the neutral script vocabulary into Claude SDK messages. */
function playScript(query: ScriptedClaudeQuery, script: ConformanceScript, seq: number): void {
  let index = 0;
  const uuid = (label: string) => `${label}-${seq}-${(index += 1)}`;
  for (const step of script) {
    switch (step.kind) {
      case "assistant-text": {
        query.emit({
          type: "stream_event",
          session_id: "conformance-session",
          uuid: uuid("stream"),
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: step.text },
          },
        });
        query.emit({
          type: "assistant",
          session_id: "conformance-session",
          uuid: uuid("assistant"),
          parent_tool_use_id: null,
          message: {
            id: `assistant-message-${seq}`,
            content: [{ type: "text", text: step.text }],
          },
        });
        break;
      }
      case "tool-start": {
        query.emit({
          type: "stream_event",
          session_id: "conformance-session",
          uuid: uuid("stream"),
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: step.toolId,
              name: step.name,
              input: {},
            },
          },
        });
        break;
      }
      case "tool-untitled-update": {
        query.emit({
          type: "stream_event",
          session_id: "conformance-session",
          uuid: uuid("stream"),
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ path: "README.md" }),
            },
          },
        });
        break;
      }
      case "tool-end": {
        query.emit({
          type: "stream_event",
          session_id: "conformance-session",
          uuid: uuid("stream"),
          parent_tool_use_id: null,
          event: { type: "content_block_stop", index: 1 },
        });
        break;
      }
      case "complete": {
        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "conformance-session",
          uuid: uuid("result"),
        });
        break;
      }
      case "die": {
        query.fail(new Error(step.detail));
        break;
      }
      case "hang": {
        // Emit nothing: the turn stays open, which is the point.
        return;
      }
      case "approval-request": {
        // Claude approvals go through canUseTool, not the message stream.
        // Fall through to hang so Stop still has a live turn to settle.
        return;
      }
    }
  }
}

export const claudeConformanceBinding: ConformanceBinding = {
  provider: "claude",
  sendWhileRunning: PROVIDER_TURN_CAPABILITIES.claudeAgent.sendWhileRunning,
  openSession: (script, options?: ConformanceOpenSessionOptions) =>
    Effect.gen(function* () {
      const query = new ScriptedClaudeQuery();
      // Inbound prompts, in arrival order. The only evidence that a mid-turn
      // send reached the provider: a steer reuses the live turn id, so runtime
      // events cannot tell a delivered follow-up from a dropped one.
      const promptsSeen: Array<string> = [];
      const layer = Layer.effect(
        ClaudeConformanceAdapter,
        Effect.gen(function* () {
          const settings = decodeClaudeSettings({});
          return yield* makeClaudeAdapter(settings, {
            createQuery: (input) => {
              // The real SDK consumes this iterable; the fake previously did
              // not, which both hid delivery and left the adapter writing into
              // a stream nobody drained. Draining it here is the more faithful
              // behaviour as well as the assertion surface.
              void (async () => {
                try {
                  for await (const message of input.prompt) {
                    promptsSeen.push(promptMessageToText(message));
                  }
                } catch {
                  // The prompt stream is torn down when the session closes.
                  // That race is expected and carries nothing to assert.
                }
              })();
              return query as never;
            },
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest("/tmp/conformance-claude", "/tmp")),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(NodeServices.layer),
      );

      const context = yield* Layer.build(layer);
      const adapter = yield* Effect.service(ClaudeConformanceAdapter).pipe(Effect.provide(context));

      const observed = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(observed, (current) => [...current, event])),
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
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
            const result = yield* adapter.sendTurn({
              threadId: THREAD_ID,
              input: text,
              attachments: [],
            });
            void result;
            turnSeq += 1;
            playScript(query, turnScript, turnSeq);
          }) as never,
        // Snapshot, not the live array: the case polls this on a schedule, and
        // handing out the mutable array would let a later push change a result
        // the runner already read.
        promptsReceived: Effect.sync(() => [...promptsSeen]),
        awaitEvent: (predicate, options) =>
          Ref.get(observed).pipe(
            Effect.map((events) => events.find(predicate)),
            Effect.repeat({
              while: (found) => found === undefined,
              schedule: pollSchedule,
            }),
            Effect.timeoutOption(`${options?.timeoutMs ?? 5_000} millis`),
            Effect.flatMap((result) =>
              Option.isSome(result) && result.value !== undefined
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new ConformanceHarnessError({
                      provider: "claude",
                      detail: `timed out waiting for ${options?.describe ?? "matching event"}`,
                    }),
                  ),
            ),
          ),
      };

      // Keep the initial script available for bindings that pre-script at open
      // time; the in-process family ignores it in favour of per-turn scripts.
      void script;

      return session;
    }).pipe(
      // Layer build and session start can fail with platform/settings errors.
      // Those are harness setup problems, not adapter conformance failures —
      // keep them distinguishable so a broken fixture never reads as a
      // provider defect.
      Effect.mapError((cause) =>
        isConformanceHarnessError(cause)
          ? cause
          : new ConformanceHarnessError({
              provider: "claude",
              detail: `failed to open conformance session: ${String(cause)}`,
            }),
      ),
    ),
};
