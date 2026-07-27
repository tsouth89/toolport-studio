/**
 * Shared runner for the core-loop conformance contract (SOU-426).
 *
 * `runCoreLoopConformance(binding)` registers the same suite for every
 * provider. Adding a provider means adding a binding — not writing new cases —
 * so a new adapter (Gemini, SOU-404) cannot ship with a silently missing core
 * behaviour.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { ProviderAdapterError } from "../Errors.ts";
import { isStopSettledRuntimeEvent, isTurnTerminalRuntimeEvent } from "../turnEngine/index.ts";
import {
  CONFORMANCE_CASE_IDS,
  FIRST_EVENT_BUDGET_MS,
  STOP_SETTLE_BUDGET_MS,
  type ConformanceBinding,
  type ConformanceCaseId,
  type ConformanceHarnessError,
} from "./contract.ts";

/** Everything a conformance case may fail with. Assertions surface as defects. */
type CaseFailure = ConformanceHarnessError | ProviderAdapterError;

/**
 * How long to watch for a second distinct turn after a send-while-running.
 * Short on purpose: "steer" is proven by a second turn *not* appearing, so
 * this is the cost every steering provider pays on every run.
 */
const SECOND_TURN_OBSERVATION_MS = 2_000;

/**
 * Cases the runner does not yet implement. Listed explicitly so the gap is
 * visible in the suite instead of being inferred from absence — the same
 * failure mode this contract exists to prevent. Removing an entry here is how
 * a case graduates.
 */
const NOT_YET_IMPLEMENTED: ReadonlyArray<ConformanceCaseId> = [
  "stop-with-pending-approval-settles",
  "process-death-is-typed-error",
  "resume-preserves-history",
];

const isTurnTerminal = isTurnTerminalRuntimeEvent;
const isStopSettled = isStopSettledRuntimeEvent;

export function runCoreLoopConformance(binding: ConformanceBinding): void {
  describe(`core-loop conformance: ${binding.provider}`, () => {
    // Keeps waived and unimplemented cases visible in test output rather than
    // letting them vanish. A waiver nobody ever reads is not an exception, it
    // is a hole.
    it("declares coverage for every contract case", () => {
      const waived = new Set(Object.keys(binding.waivers ?? {}));
      const pending = new Set<string>(NOT_YET_IMPLEMENTED);
      const unaccounted = CONFORMANCE_CASE_IDS.filter((id) => !waived.has(id) && !pending.has(id));
      assert.isAbove(
        unaccounted.length,
        0,
        `${binding.provider} has no actively asserted conformance cases`,
      );
      for (const [caseId, reason] of Object.entries(binding.waivers ?? {})) {
        assert.isTrue(
          (CONFORMANCE_CASE_IDS as ReadonlyArray<string>).includes(caseId),
          `unknown waived case '${caseId}'`,
        );
        assert.isTrue(
          typeof reason === "string" && reason.trim().length > 0,
          `waiver for '${caseId}' must give a reason`,
        );
      }
    });

    const caseFor = (
      caseId: ConformanceCaseId,
      name: string,
      body: () => Effect.Effect<void, CaseFailure, Scope.Scope>,
    ): void => {
      const waiver = binding.waivers?.[caseId];
      if (waiver !== undefined) {
        it.skip(`${name} [waived: ${waiver}]`, () => {});
        return;
      }
      // `it.live`, not `it.effect`: these are latency assertions against the
      // real clock. `it.effect` supplies a TestClock, under which "first
      // progress within 5s" would pass without any time ever elapsing — the
      // assertion would be vacuous, which is worse than absent.
      //
      // `it.scoped` is deprecated in this @effect/vitest version and silently
      // registers nothing, so the scope is closed explicitly here.
      it.live(name, () => body().pipe(Effect.scoped));
    };

    caseFor("first-event-budget", "send produces first progress within budget", () =>
      Effect.gen(function* () {
        const session = yield* binding.openSession([
          { kind: "assistant-text", text: "hello" },
          { kind: "complete" },
        ]);
        yield* session.sendScriptedTurn({
          text: "hi",
          script: [{ kind: "assistant-text", text: "hello" }, { kind: "complete" }],
        });
        yield* session.awaitEvent(
          (event) => event.type === "turn.started" || event.type === "content.delta",
          { timeoutMs: FIRST_EVENT_BUDGET_MS, describe: "first visible progress" },
        );
      }),
    );

    caseFor("stream-coherence", "assistant text reaches the runtime event stream", () =>
      Effect.gen(function* () {
        const script = [
          { kind: "assistant-text" as const, text: "the answer is 42" },
          { kind: "complete" as const },
        ];
        const session = yield* binding.openSession(script);
        yield* session.sendScriptedTurn({ text: "question", script });
        yield* session.awaitEvent(isTurnTerminal, {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "turn terminal",
        });
        const events = yield* session.events;
        const sawText = events.some(
          (event) =>
            (event.type === "content.delta" || event.type === "item.completed") &&
            JSON.stringify(event.payload).includes("42"),
        );
        assert.isTrue(sawText, "assistant text never surfaced as a runtime event");
      }),
    );

    caseFor("stop-mid-stream-settles", "interrupt settles a hung turn", () =>
      Effect.gen(function* () {
        // Provider goes quiet with the turn open — the SOU-351 shape. Stop
        // must settle it regardless; that is the whole trust bar.
        const script = [
          { kind: "assistant-text" as const, text: "thinking" },
          { kind: "hang" as const },
        ];
        const session = yield* binding.openSession(script);
        yield* session.sendScriptedTurn({ text: "long task", script });
        yield* session.awaitEvent((event) => event.type === "turn.started", {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "turn started",
        });

        yield* session.adapter.interruptTurn(session.threadId);

        yield* session.awaitEvent(isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after Stop",
        });
      }),
    );

    caseFor("stop-mid-tool-terminalizes", "interrupt settles a turn with an open tool", () =>
      Effect.gen(function* () {
        const script = [
          { kind: "tool-start" as const, toolId: "tool-1", name: "long_tool" },
          { kind: "hang" as const },
        ];
        const session = yield* binding.openSession(script);
        yield* session.sendScriptedTurn({ text: "use a long tool", script });
        yield* session.awaitEvent((event) => event.type === "turn.started", {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "turn started",
        });
        // Best-effort: some fakes surface tool lifecycle, others only hang with
        // the turn open. Stop must settle either way.
        yield* session
          .awaitEvent((event) => event.type === "item.started" || event.type === "item.updated", {
            timeoutMs: 1_500,
            describe: "tool activity (optional)",
          })
          .pipe(Effect.catchTag("ConformanceHarnessError", () => Effect.void));

        yield* session.adapter.interruptTurn(session.threadId);

        yield* session.awaitEvent(isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after Stop mid-tool",
        });
      }),
    );

    caseFor(
      "send-while-running-has-one-behavior",
      `send while running behaves as declared: ${binding.sendWhileRunning}`,
      () =>
        Effect.gen(function* () {
          const script = [
            { kind: "assistant-text" as const, text: "working" },
            { kind: "hang" as const },
          ];
          const session = yield* binding.openSession(script);
          yield* session.sendScriptedTurn({ text: "first", script });
          yield* session.awaitEvent((event) => event.type === "turn.started", {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "first turn started",
          });

          yield* session.sendScriptedTurn({ text: "second", script });

          // Turn identity comes from the event stream, never from a return
          // value — under a hanging prompt the ACP family's sendTurn never
          // returns at all. Wait for a *second distinct* turn to appear; its
          // absence within the settle budget is what "steered" looks like.
          const startedTurnIds = new Set<string>();
          const secondTurnAppeared = yield* session
            .awaitEvent(
              (event) => {
                if (event.type !== "turn.started") {
                  return false;
                }
                startedTurnIds.add(String(event.turnId));
                return startedTurnIds.size >= 2;
              },
              { timeoutMs: SECOND_TURN_OBSERVATION_MS, describe: "a second distinct turn" },
            )
            .pipe(
              Effect.as(true),
              Effect.catchTag("ConformanceHarnessError", () => Effect.succeed(false)),
            );

          if (binding.sendWhileRunning === "steer") {
            assert.isFalse(
              secondTurnAppeared,
              "declared steer, but the second send opened a new turn — the composer " +
                "promises 'Following up' chrome this provider does not deliver",
            );
            return;
          }

          assert.isTrue(
            secondTurnAppeared,
            "declared queue, but the second send never produced a distinct turn",
          );
        }),
    );

    caseFor("post-stop-follow-up-runs", "a new turn runs after Stop settles", () =>
      Effect.gen(function* () {
        const hangScript = [
          { kind: "assistant-text" as const, text: "working" },
          { kind: "hang" as const },
        ];
        const session = yield* binding.openSession(hangScript);
        yield* session.sendScriptedTurn({ text: "long task", script: hangScript });
        yield* session.awaitEvent((event) => event.type === "turn.started", {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "first turn started",
        });

        yield* session.adapter.interruptTurn(session.threadId);
        yield* session.awaitEvent(isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "settled after Stop",
        });

        // Snapshot after Stop. awaitEvent scans full history, so progress is
        // defined relative to this snapshot (not "any turn.started ever").
        const before = yield* session.events;
        const firstTurnIds = new Set(
          before
            .filter((event) => event.type === "turn.started")
            .map((event) => String(event.turnId)),
        );
        const eventCountBefore = before.length;

        const followUpScript = [
          { kind: "assistant-text" as const, text: "follow-up ok" },
          { kind: "complete" as const },
        ];
        yield* session.sendScriptedTurn({ text: "follow up after stop", script: followUpScript });

        // Poll for post-snapshot progress. Prefer a new turn.started id; also
        // accept any log growth (ACP may fork sendTurn and emit slowly).
        let sawProgress = false;
        for (let attempt = 0; attempt < Math.ceil(FIRST_EVENT_BUDGET_MS / 20); attempt += 1) {
          const current = yield* session.events;
          const newTurn = current.some(
            (event) => event.type === "turn.started" && !firstTurnIds.has(String(event.turnId)),
          );
          if (newTurn || current.length > eventCountBefore) {
            sawProgress = true;
            break;
          }
          yield* Effect.sleep("20 millis");
        }
        assert.isTrue(sawProgress, "post-stop follow-up produced no new runtime progress");
      }),
    );
  });
}
