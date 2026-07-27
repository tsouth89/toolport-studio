// @effect-diagnostics nodeBuiltinImport:off
/**
 * Grok binding for the core-loop conformance contract (SOU-426).
 *
 * First member of the **ACP subprocess** family. Unlike the in-process
 * bindings, the fake here is a real child process (`scripts/acp-mock-agent.ts`)
 * configured entirely through `T3_ACP_*` environment variables at spawn time.
 *
 * This is the binding that justifies `openSession(script)` taking the script up
 * front: the mock cannot be driven imperatively mid-turn, so the whole
 * scenario has to be decided before the process starts. Per-turn scripts
 * passed to `sendScriptedTurn` are therefore ignored here — the runner only
 * ever passes one consistent with the session script.
 *
 * Cursor is the same family and will bind almost identically.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
  GrokSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../../config.ts";
import { makeGrokAdapter } from "../../Layers/GrokAdapter.ts";
import type { GrokAdapterShape } from "../../Services/GrokAdapter.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type { ConformanceBinding, ConformanceScript, ConformanceSession } from "../contract.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const THREAD_ID = ThreadId.make("conformance-grok-thread");

const pollSchedule = Schedule.spaced("10 millis");

const isConformanceHarnessError = Schema.is(ConformanceHarnessError);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../../scripts/acp-mock-agent.ts");

class GrokConformanceAdapter extends Context.Service<GrokConformanceAdapter, GrokAdapterShape>()(
  "t3/provider/conformance/bindings/grok/GrokConformanceAdapter",
) {}

/**
 * Translate the neutral script vocabulary into `T3_ACP_*` mock-agent env.
 *
 * The mock completes the prompt by default, so `complete` needs no flag; the
 * interesting steps are the ones that make it deviate.
 */
export function scriptToAcpEnv(script: ConformanceScript): Record<string, string> {
  const env: Record<string, string> = {};
  const hasHang = script.some((step) => step.kind === "hang");
  const hasToolStart = script.some((step) => step.kind === "tool-start");
  for (const step of script) {
    switch (step.kind) {
      case "assistant-text": {
        env.T3_ACP_PROMPT_RESPONSE_TEXT = step.text;
        break;
      }
      case "tool-start":
      case "tool-end": {
        // tool-start + hang: open a tool then wedge (Stop mid-tool).
        // tool-only: full tool lifecycle without hang.
        if (hasToolStart && hasHang) {
          env.T3_ACP_EMIT_TOOL_START_THEN_HANG = "1";
        } else {
          env.T3_ACP_EMIT_TOOL_CALLS = "1";
        }
        break;
      }
      case "hang": {
        // Hang only the first prompt so post-stop follow-up can complete
        // (HANG_PROMPT_FOREVER would wedge the recycled process forever).
        if (!(hasToolStart && hasHang)) {
          env.T3_ACP_HANG_FIRST_PROMPT_FOREVER = "1";
        }
        break;
      }
      case "die": {
        env.T3_ACP_FAIL_PROMPT = "1";
        break;
      }
      case "approval-request": {
        env.T3_ACP_EMIT_ASK_QUESTION = "1";
        break;
      }
      case "complete": {
        // Default mock behaviour.
        break;
      }
    }
  }
  return env;
}

export const grokConformanceBinding: ConformanceBinding = {
  provider: "grok",
  sendWhileRunning: "steer",
  openSession: (script) =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ...scriptToAcpEnv(script),
      };

      const layer = Layer.effect(
        GrokConformanceAdapter,
        makeGrokAdapter(decodeGrokSettings({ binaryPath: mockAgentPath }), {
          environment,
        }).pipe(Effect.orDie),
      ).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-grok-conformance-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      const context = yield* Layer.build(layer);
      const adapter = yield* Effect.service(GrokConformanceAdapter).pipe(Effect.provide(context));

      const observed = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(observed, (current) => [...current, event])),
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("grok"),
        // Grok validates cwd up front, unlike the in-process bindings which
        // fall back to server config.
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const session: ConformanceSession = {
        adapter: adapter as never,
        threadId: THREAD_ID,
        events: Ref.get(observed),
        // The per-turn script is intentionally unused: this family is scripted
        // at spawn. See the module comment.
        // Forked: under a hanging ACP prompt this never returns, so awaiting
        // it would wedge the case rather than the turn.
        sendScriptedTurn: ({ text }) =>
          adapter
            .sendTurn({ threadId: THREAD_ID, input: text, attachments: [] })
            .pipe(Effect.forkScoped, Effect.asVoid) as never,
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
                      provider: "grok",
                      detail: `timed out waiting for ${options?.describe ?? "matching event"}`,
                    }),
                  ),
            ),
          ),
      };

      return session;
    }).pipe(
      Effect.mapError((cause) =>
        isConformanceHarnessError(cause)
          ? cause
          : new ConformanceHarnessError({
              provider: "grok",
              detail: `failed to open conformance session: ${String(cause)}`,
            }),
      ),
    ),
};
