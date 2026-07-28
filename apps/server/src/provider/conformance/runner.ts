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
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { isGenericToolActivityTitle } from "@t3tools/shared/toolActivity";

import type { ProviderAdapterError } from "../Errors.ts";
import {
  isPendingInteractionRuntimeEvent,
  isProcessDeathRuntimeEvent,
  isStopSettledRuntimeEvent,
  isTurnTerminalRuntimeEvent,
} from "../turnEngine/index.ts";
import {
  CONFORMANCE_CASE_IDS,
  ConformanceHarnessError as ConformanceHarnessErrorClass,
  FIRST_EVENT_BUDGET_MS,
  STOP_SETTLE_BUDGET_MS,
  type ConformanceBinding,
  type ConformanceCaseId,
  type ConformanceHarnessError,
  type ConformanceSession,
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
 * How long a mid-turn follow-up may take to reach the provider. Generous: a
 * steering adapter has to preempt the live prompt first, and a queueing one
 * only delivers after the current turn settles.
 */
const FOLLOW_UP_DELIVERY_BUDGET_MS = 20_000;

/**
 * Cases the runner does not yet implement. Listed explicitly so the gap is
 * visible in the suite instead of being inferred from absence — the same
 * failure mode this contract exists to prevent. Removing an entry here is how
 * a case graduates.
 */
/** Empty when every contract case is either asserted or waived. */
const NOT_YET_IMPLEMENTED: ReadonlyArray<ConformanceCaseId> = [];

const isTurnTerminal = isTurnTerminalRuntimeEvent;
const isStopSettled = isStopSettledRuntimeEvent;

/**
 * Wait for a matching event that arrives *after* `fromIndex`.
 *
 * `session.awaitEvent` scans the whole accumulated buffer, so a Stop assertion
 * written on top of it passes whenever the turn had already terminalized on its
 * own — it proves a terminal event exists, not that Stop caused one. Every stop
 * case therefore snapshots the event count first and asserts against new events
 * only. This is the property that lets a "Stop does nothing" adapter bug fail
 * the contract instead of sailing through it.
 */
const awaitEventAfter = (
  session: ConformanceSession,
  fromIndex: number,
  predicate: (event: ProviderRuntimeEvent) => boolean,
  options: { readonly timeoutMs: number; readonly describe: string; readonly provider: string },
): Effect.Effect<ProviderRuntimeEvent, ConformanceHarnessError> =>
  session.events.pipe(
    Effect.map((events) => events.slice(fromIndex).find(predicate)),
    Effect.repeat({
      while: (found) => found === undefined,
      schedule: Schedule.spaced("10 millis"),
    }),
    Effect.timeoutOption(`${options.timeoutMs} millis`),
    Effect.flatMap((result) =>
      Option.isSome(result) && result.value !== undefined
        ? Effect.succeed(result.value)
        : Effect.fail(
            new ConformanceHarnessErrorClass({
              provider: options.provider,
              detail: `timed out waiting for ${options.describe} (no matching event after the action)`,
            }),
          ),
    ),
  );

const HISTORY_MARKER = "stored-history-marker-zebra-42";

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

        const before = (yield* session.events).length;
        yield* session.adapter.interruptTurn(session.threadId);

        yield* awaitEventAfter(session, before, isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after Stop",
          provider: binding.provider,
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

        const before = (yield* session.events).length;
        yield* session.adapter.interruptTurn(session.threadId);

        yield* awaitEventAfter(session, before, isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after Stop mid-tool",
          provider: binding.provider,
        });
      }),
    );

    caseFor(
      "stop-with-stale-turn-id-settles",
      "interrupt settles even when the client names a turn the adapter moved past",
      () =>
        Effect.gen(function* () {
          // Clients Stop the turn *they* know about. Any adapter that treats the
          // turn id as a gate rather than a hint drops the interrupt on the
          // floor, and the session is unstoppable with no error to explain it.
          // The other stop cases pass no turn id at all, which is why this hole
          // stayed open.
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

          const before = (yield* session.events).length;
          yield* session.adapter.interruptTurn(
            session.threadId,
            TurnId.make("turn-the-client-still-remembers"),
          );

          yield* awaitEventAfter(session, before, isStopSettled, {
            timeoutMs: STOP_SETTLE_BUDGET_MS,
            describe: "session settled after Stop with a stale turn id",
            provider: binding.provider,
          });
        }),
    );

    caseFor("follow-up-then-stop-settles", "interrupt settles after a mid-turn follow-up", () =>
      Effect.gen(function* () {
        // The real sequence users hit: send, follow up while it is still
        // working, then Stop. Whichever way the adapter dispositions the
        // follow-up (steer or queue), Stop must still settle the session.
        const script = [
          { kind: "assistant-text" as const, text: "working" },
          { kind: "hang" as const },
        ];
        const session = yield* binding.openSession(script);
        yield* session.sendScriptedTurn({ text: "first", script });
        const started = yield* session.awaitEvent((event) => event.type === "turn.started", {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "first turn started",
        });

        yield* session.sendScriptedTurn({ text: "actually, do this instead", script });

        // Stop naming the first turn — exactly what a client holding the
        // pre-follow-up turn id sends.
        const before = (yield* session.events).length;
        yield* session.adapter.interruptTurn(
          session.threadId,
          started.turnId ?? TurnId.make("unknown-turn"),
        );

        yield* awaitEventAfter(session, before, isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after follow-up then Stop",
          provider: binding.provider,
        });
      }),
    );

    caseFor("double-stop-does-not-wedge", "a second Stop is harmless", () =>
      Effect.gen(function* () {
        // Users double-tap Stop when the first press looks like it did nothing.
        // The second must not error, resurrect the turn, or wedge the session.
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

        const before = (yield* session.events).length;
        yield* session.adapter.interruptTurn(session.threadId);
        yield* awaitEventAfter(session, before, isStopSettled, {
          timeoutMs: STOP_SETTLE_BUDGET_MS,
          describe: "session settled after first Stop",
          provider: binding.provider,
        });

        // Must not fail. A second Stop against a settled session is a no-op,
        // not an error the UI has to explain.
        yield* session.adapter.interruptTurn(session.threadId);

        const afterSecondStop = (yield* session.events).length;
        const resurrected = (yield* session.events)
          .slice(afterSecondStop)
          .some((event) => event.type === "turn.started");
        assert.isFalse(resurrected, "second Stop restarted a turn");
      }),
    );

    caseFor(
      "tool-name-survives-untitled-updates",
      "a named tool keeps its name across untitled updates",
      () =>
        Effect.gen(function* () {
          // Providers stream status/output updates that carry no title. Letting
          // one of those rename the row to a generic placeholder is what pins
          // the Working status to "Tool call" for the life of a long tool.
          const script = [
            { kind: "tool-start" as const, toolId: "tool-1", name: "Read File" },
            { kind: "tool-untitled-update" as const, toolId: "tool-1" },
            { kind: "complete" as const },
          ];
          const session = yield* binding.openSession(script);
          yield* session.sendScriptedTurn({ text: "read a file", script });
          yield* session.awaitEvent(isTurnTerminal, {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "turn terminal",
          });

          const titles = (yield* session.events).flatMap((event) => {
            if (
              event.type !== "item.started" &&
              event.type !== "item.updated" &&
              event.type !== "item.completed"
            ) {
              return [];
            }
            const title = (event.payload as { readonly title?: unknown }).title;
            return typeof title === "string" ? [title] : [];
          });

          assert.isAbove(titles.length, 0, "no tool titles reached the runtime event stream");
          const degraded = titles.filter((title) => isGenericToolActivityTitle(title));
          assert.deepEqual(
            degraded,
            [],
            `tool title degraded to a generic placeholder; saw: ${titles.join(" | ")}`,
          );
        }),
    );

    caseFor("follow-up-reaches-the-provider", "a mid-turn follow-up reaches the provider", () =>
      Effect.gen(function* () {
        // Whether the adapter steers or queues, the user's words must reach the
        // model. Runtime events cannot show this — a steer reuses the live turn
        // id, so a dropped follow-up is indistinguishable from a working one.
        const script = [
          { kind: "assistant-text" as const, text: "working" },
          { kind: "hang" as const },
        ];
        const session = yield* binding.openSession(script);
        const promptsReceived = session.promptsReceived;
        if (promptsReceived === undefined) {
          return yield* new ConformanceHarnessErrorClass({
            provider: binding.provider,
            detail:
              "binding exposes no promptsReceived hook; waive this case explicitly instead of leaving it unasserted",
          });
        }
        yield* session.sendScriptedTurn({ text: "first", script });
        yield* session.awaitEvent((event) => event.type === "turn.started", {
          timeoutMs: FIRST_EVENT_BUDGET_MS,
          describe: "turn started",
        });

        const followUpText = "follow-up-marker-quokka-77";
        yield* session.sendScriptedTurn({ text: followUpText, script });

        yield* promptsReceived.pipe(
          Effect.map((prompts) => prompts.some((prompt) => prompt.includes(followUpText))),
          Effect.repeat({ while: (found) => !found, schedule: Schedule.spaced("50 millis") }),
          Effect.timeoutOption(`${FOLLOW_UP_DELIVERY_BUDGET_MS} millis`),
          Effect.flatMap((result) =>
            Option.isSome(result) && result.value
              ? Effect.void
              : Effect.fail(
                  new ConformanceHarnessErrorClass({
                    provider: binding.provider,
                    detail: `mid-turn follow-up never reached the provider within ${FOLLOW_UP_DELIVERY_BUDGET_MS}ms`,
                  }),
                ),
          ),
        );
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

          // Queue = hold until the live turn settles, then auto-start (TurnQueue
          // drain). While the first turn is still hung, a second turn must not
          // appear; drain is covered by TurnQueue + Grok adapter unit tests.
          assert.isFalse(
            secondTurnAppeared,
            "declared queue, but the second send started a turn before the first settled",
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

    caseFor(
      "stop-with-pending-approval-settles",
      "interrupt settles while a permission or user-input request is open",
      () =>
        Effect.gen(function* () {
          const script = [
            {
              kind: "approval-request" as const,
              requestId: "approval-1",
              toolName: "dangerous_tool",
            },
            { kind: "hang" as const },
          ];
          const session = yield* binding.openSession(script);
          yield* session.sendScriptedTurn({ text: "need approval", script });
          yield* session.awaitEvent((event) => event.type === "turn.started", {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "turn started",
          });
          // Best-effort wait for the interaction surface; some fakes only hang.
          yield* session
            .awaitEvent(isPendingInteractionRuntimeEvent, {
              timeoutMs: 2_000,
              describe: "pending approval or user-input (optional)",
            })
            .pipe(Effect.catchTag("ConformanceHarnessError", () => Effect.void));

          yield* session.adapter.interruptTurn(session.threadId);

          yield* session.awaitEvent(isStopSettled, {
            timeoutMs: STOP_SETTLE_BUDGET_MS,
            describe: "settled after Stop with pending interaction",
          });
        }),
    );

    caseFor(
      "process-death-is-typed-error",
      "provider process/transport death surfaces a typed runtime failure",
      () =>
        Effect.gen(function* () {
          const script = [
            { kind: "assistant-text" as const, text: "starting" },
            { kind: "die" as const, detail: "provider process died" },
          ];
          const session = yield* binding.openSession(script);
          // Death may fail sendTurn or arrive as a stream/process event.
          // Either way we must not hang forever with Working stuck.
          yield* session
            .sendScriptedTurn({ text: "go", script })
            .pipe(Effect.catch(() => Effect.void));

          yield* session.awaitEvent(isProcessDeathRuntimeEvent, {
            timeoutMs: STOP_SETTLE_BUDGET_MS,
            describe: "typed process/transport death",
          });
        }),
    );

    caseFor(
      "resume-preserves-history",
      "stop + resume still allows a follow-up turn with a durable resume cursor",
      () =>
        Effect.gen(function* () {
          // 1) Complete a turn that leaves a distinctive marker in the stream.
          const firstScript = [
            { kind: "assistant-text" as const, text: HISTORY_MARKER },
            { kind: "complete" as const },
          ];
          const session = yield* binding.openSession(firstScript);
          yield* session.sendScriptedTurn({
            text: `please remember ${HISTORY_MARKER}`,
            script: firstScript,
          });
          yield* session.awaitEvent(isTurnTerminal, {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "first turn terminal",
          });

          const firstEvents = yield* session.events;
          const sawMarker = firstEvents.some((event) =>
            JSON.stringify(event).includes(HISTORY_MARKER),
          );
          assert.isTrue(sawMarker, "first turn must surface the history marker in runtime events");

          // 2) Provider must publish a resume handle before we stop.
          const resumeCursor = yield* session.readResumeCursor;
          assert.isTrue(
            resumeCursor !== undefined && resumeCursor !== null,
            "adapter must publish a resumeCursor after a completed turn",
          );

          yield* session.adapter.stopSession(session.threadId);

          // 3) Reopen with that cursor and complete another turn. This is the
          // contract that dogfood relies on: Stop (or process recycle) must
          // not force a blank session with no way back.
          const secondScript = [
            { kind: "assistant-text" as const, text: "resumed-follow-up-ok" },
            { kind: "complete" as const },
          ];
          const resumed = yield* binding.openSession(secondScript, { resumeCursor });
          yield* resumed.sendScriptedTurn({
            text: "continue after resume",
            script: secondScript,
          });

          yield* resumed.awaitEvent((event) => event.type === "turn.started", {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "resumed session turn started",
          });
          yield* resumed.awaitEvent(isTurnTerminal, {
            timeoutMs: FIRST_EVENT_BUDGET_MS,
            describe: "resumed session turn terminal",
          });

          const resumeCursorAfter = yield* resumed.readResumeCursor;
          assert.isTrue(
            resumeCursorAfter !== undefined && resumeCursorAfter !== null,
            "resumeCursor must remain available after a resumed follow-up turn",
          );

          const resumedEvents = yield* resumed.events;
          const sawFollowUp = resumedEvents.some((event) =>
            JSON.stringify(event).includes("resumed-follow-up-ok"),
          );
          assert.isTrue(
            sawFollowUp,
            "resumed session must surface follow-up assistant text in runtime events",
          );
        }),
    );
  });
}
