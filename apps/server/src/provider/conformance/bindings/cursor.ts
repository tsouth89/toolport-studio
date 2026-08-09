// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cursor binding for the core-loop conformance contract (SOU-426).
 *
 * Second member of the ACP subprocess family, and near-identical to the Grok
 * binding by design: both spawn `scripts/acp-mock-agent.ts` and are scripted
 * through `TOOLPORT_STUDIO_ACP_*` env at spawn time. The script translation is shared with
 * Grok (`scriptToAcpEnv`) so the two cannot drift apart silently — divergence
 * between ACP providers is exactly the class of gap this contract exists to
 * catch.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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
  CursorSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@toolport-studio/contracts";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeCursorAdapter } from "../../Layers/CursorAdapter.ts";
import type { CursorAdapterShape } from "../../Services/CursorAdapter.ts";
import { ConformanceHarnessError } from "../contract.ts";
import type {
  ConformanceBinding,
  ConformanceOpenSessionOptions,
  ConformanceSession,
} from "../contract.ts";
import { scriptToAcpEnv } from "./grok.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const THREAD_ID = ThreadId.make("conformance-cursor-thread");

const pollSchedule = Schedule.spaced("10 millis");

const isConformanceHarnessError = Schema.is(ConformanceHarnessError);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../../scripts/acp-mock-agent.ts");

class CursorConformanceAdapter extends Context.Service<
  CursorConformanceAdapter,
  CursorAdapterShape
>()("t3/provider/conformance/bindings/cursor/CursorConformanceAdapter") {}

export const cursorConformanceBinding: ConformanceBinding = {
  provider: "cursor",
  // Independent oracle: Cursor ACP accepts a concurrent preempting prompt.
  sendWhileRunning: "steer",
  openSession: (script, options?: ConformanceOpenSessionOptions) =>
    Effect.gen(function* () {
      // Raw inbound JSON-RPC log, the same seam Grok uses. Both bindings spawn
      // `acp-mock-agent.ts`, so the agent already honours this env var; only the
      // reading side was missing here. It is the only way to prove a mid-turn
      // follow-up reached the agent rather than being dropped in the adapter.
      const requestLogPath = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-conformance-cursor-")),
        "requests.log",
      );
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ...scriptToAcpEnv(script),
        TOOLPORT_STUDIO_ACP_REQUEST_LOG_PATH: requestLogPath,
      };

      const layer = Layer.effect(
        CursorConformanceAdapter,
        makeCursorAdapter(decodeCursorSettings({ binaryPath: mockAgentPath }), {
          environment,
        }),
      ).pipe(
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cursor-conformance-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      const context = yield* Layer.build(layer);
      const adapter = yield* Effect.service(CursorConformanceAdapter).pipe(Effect.provide(context));

      const observed = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Ref.update(observed, (current) => [...current, event])),
        Effect.forkScoped,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        ...(options?.resumeCursor !== undefined
          ? { resumeCursor: options.resumeCursor as never }
          : {}),
      });

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
        // Forked: like Grok, a hanging ACP prompt means sendTurn never returns.
        sendScriptedTurn: ({ text }) =>
          adapter
            .sendTurn({ threadId: THREAD_ID, input: text, attachments: [] })
            .pipe(Effect.forkScoped, Effect.asVoid) as never,
        promptsReceived: Effect.sync(() => {
          if (!NodeFS.existsSync(requestLogPath)) {
            return [];
          }
          return NodeFS.readFileSync(requestLogPath, "utf8")
            .split("\n")
            .filter((line) => line.includes("session/prompt"));
        }),
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
                      provider: "cursor",
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
              provider: "cursor",
              detail: `failed to open conformance session: ${String(cause)}`,
            }),
      ),
    ),
};
