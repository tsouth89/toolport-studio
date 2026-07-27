/**
 * Core-loop conformance contract (SOU-426).
 *
 * One behavioural contract that every provider adapter must satisfy. Adapters
 * are individually well tested (~11k lines across five `*Adapter.test.ts`
 * files), but each is tested against its own mock in its own idiom, so nothing
 * enforces *parity* between them. That is how Codex ended up without a
 * mid-turn steer path (SOU-421) while four other adapters have one, and how
 * only Grok ever grew liveness handling (SOU-379).
 *
 * The contract asserts exclusively on `ProviderRuntimeEvent` — the canonical
 * provider-neutral surface every adapter already emits via `streamEvents`. No
 * case may reach into provider internals; if a case cannot be expressed in
 * runtime events, it belongs in that adapter's own test file, not here.
 *
 * A provider that genuinely cannot satisfy a case declares a **named waiver**
 * (see `ConformanceBinding.waivers`). Silence is not an opt-out — silence is
 * precisely how the current gaps got in.
 */
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";

import * as Schema from "effect/Schema";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

/**
 * Failure raised by the conformance harness itself — a binding that could not
 * stand up its fake backend, or an expectation that never arrived. Tagged so
 * it stays distinguishable from adapter errors in the failure channel rather
 * than merging into an untagged `Error`.
 */
export class ConformanceHarnessError extends Schema.TaggedErrorClass<ConformanceHarnessError>()(
  "ConformanceHarnessError",
  {
    provider: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `[${this.provider}] ${this.detail}`;
  }
}

/**
 * Cases in the core-loop contract. Ids are stable — waivers reference them by
 * name, so renaming one is a deliberate, reviewable act.
 */
export const CONFORMANCE_CASE_IDS = [
  "first-event-budget",
  "stream-coherence",
  "stop-mid-stream-settles",
  "stop-mid-tool-terminalizes",
  "stop-with-pending-approval-settles",
  "stop-with-stale-turn-id-settles",
  "follow-up-then-stop-settles",
  "double-stop-does-not-wedge",
  "tool-name-survives-untitled-updates",
  "follow-up-reaches-the-provider",
  "send-while-running-has-one-behavior",
  "post-stop-follow-up-runs",
  "process-death-is-typed-error",
  "resume-preserves-history",
] as const;

export type ConformanceCaseId = (typeof CONFORMANCE_CASE_IDS)[number];

/**
 * Provider-neutral script vocabulary. A step describes what the *provider*
 * does, never how a particular transport encodes it — bindings translate.
 */
export type ConformanceScriptStep =
  | { readonly kind: "assistant-text"; readonly text: string }
  | { readonly kind: "tool-start"; readonly toolId: string; readonly name: string }
  /**
   * Further updates for an already-named tool that carry no name of their own —
   * a status change or a chunk of streamed output. Providers emit these
   * constantly; the tool must keep the name it was given.
   */
  | { readonly kind: "tool-untitled-update"; readonly toolId: string }
  | { readonly kind: "tool-end"; readonly toolId: string }
  | { readonly kind: "approval-request"; readonly requestId: string; readonly toolName: string }
  /** Provider goes quiet with the turn still open. Nothing further is emitted. */
  | { readonly kind: "hang" }
  /** Provider process/transport dies mid-turn. */
  | { readonly kind: "die"; readonly detail: string }
  | { readonly kind: "complete" };

export type ConformanceScript = ReadonlyArray<ConformanceScriptStep>;

/**
 * How an adapter behaves when a turn is sent while one is already running.
 * Every adapter must declare exactly one — "it depends" is the bug this
 * contract exists to catch (SOU-421).
 */
export type SendWhileRunningBehavior =
  /** New input folds into the live turn; the same turn id continues. */
  | "steer"
  /** New input is held and starts a fresh turn once the live one settles. */
  | "queue";

export interface ConformanceSession {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly threadId: ThreadId;
  /**
   * Send a turn and drive the scripted provider response for it.
   *
   * **Returns once the turn has been dispatched, not once it completes**, and
   * deliberately yields no turn id. Two reasons:
   *
   * 1. `sendTurn` is not uniform across providers under a hanging prompt. The
   *    in-process family (Claude, Codex) returns a turn id immediately; the
   *    ACP family (Grok, Cursor) blocks until the prompt settles, so a hung
   *    turn never returns at all. Bindings fork internally to paper over this.
   * 2. Asserting on a returned turn id would violate this contract's own rule
   *    that cases observe `ProviderRuntimeEvent` and nothing else. Turn
   *    identity is available from `turn.started` events, which every adapter
   *    emits.
   *
   * Bindings whose fake is pre-scripted at spawn time (the ACP family) ignore
   * the per-turn script; in-process bindings honour it. The runner always
   * passes one consistent with the session script.
   */
  readonly sendScriptedTurn: (input: {
    readonly text: string;
    readonly script: ConformanceScript;
  }) => Effect.Effect<void, ProviderAdapterError | ConformanceHarnessError>;
  /** Runtime events observed so far, in emission order. */
  readonly events: Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>>;
  /**
   * Prompt texts the fake provider actually received, in arrival order.
   *
   * The only assertion surface that can prove a mid-turn send *reached the
   * model* rather than being dropped or silently held. Runtime events cannot:
   * a steer reuses the live turn id, so a follow-up that never left the adapter
   * looks identical to one the provider is working on. Optional because it
   * requires the fake to record inbound prompts; bindings that do not are
   * waived from `follow-up-reaches-the-provider` rather than passing vacuously.
   */
  readonly promptsReceived?: Effect.Effect<ReadonlyArray<string>, ConformanceHarnessError>;
  /**
   * Durable resume handle for this session, if the adapter has published one.
   * Used by `resume-preserves-history` to stop and reopen without losing the
   * provider's session identity.
   */
  readonly readResumeCursor: Effect.Effect<unknown | undefined>;
  /**
   * Wait for the first event matching `predicate`, or fail once `timeoutMs`
   * elapses. Uses the real clock: these are latency assertions, and a
   * TestClock would make "no multi-minute blank window" vacuously true.
   */
  readonly awaitEvent: (
    predicate: (event: ProviderRuntimeEvent) => boolean,
    options?: { readonly timeoutMs?: number; readonly describe?: string },
  ) => Effect.Effect<ProviderRuntimeEvent, ConformanceHarnessError>;
}

export type ConformanceOpenSessionOptions = {
  /** When set, startSession should resume this provider session. */
  readonly resumeCursor?: unknown;
};

export interface ConformanceBinding {
  /** Display name used in test output, e.g. "claude". */
  readonly provider: string;
  /**
   * Declared send-while-running behaviour. Asserted by
   * `send-while-running-has-one-behavior` — a declaration that does not match
   * observed behaviour is a failure, which is the point.
   */
  readonly sendWhileRunning: SendWhileRunningBehavior;
  /**
   * Cases this provider cannot satisfy, each with a reason. A waiver is a
   * reviewed exception, not a skip: it shows up in test output so it stays
   * visible rather than decaying into an unexamined default.
   */
  readonly waivers?: Partial<Record<ConformanceCaseId, string>>;
  /**
   * Open a scoped session with the fake provider backend primed for `script`.
   * The scope closes at end of test; bindings clean up processes there.
   * Pass `resumeCursor` to exercise resume rather than a blank session/new.
   */
  readonly openSession: (
    script: ConformanceScript,
    options?: ConformanceOpenSessionOptions,
  ) => Effect.Effect<ConformanceSession, ConformanceHarnessError, Scope.Scope>;
}

/** Budget for "send → first visible progress" (SOU-354 scorecard row). */
export const FIRST_EVENT_BUDGET_MS = 5_000;

/** Budget for "Stop always settles the session". */
export const STOP_SETTLE_BUDGET_MS = 10_000;
