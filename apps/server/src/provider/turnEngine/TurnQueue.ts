/**
 * Thread-scoped turn queue policy (SOU-428 / SOU-422).
 *
 * Pure state machine: adapters and orchestration decide *when* to call these
 * helpers; the engine decides *what* happens to a send while a turn is live.
 *
 * Persistence across process restart is intentionally out of scope here — this
 * module owns in-memory disposition only.
 */

import type { TurnPhase } from "./TurnPhase.ts";
import { isLivePhase, resetTurnPhase, transitionTurnPhase } from "./TurnPhase.ts";
import type { SendWhileRunningBehavior } from "./TurnCapabilities.ts";

export type QueuedTurnInput = {
  readonly id: string;
  readonly text: string;
  readonly enqueuedAtMs: number;
};

export type TurnQueueState = {
  /** Live turn id when a turn is in flight; undefined when idle/terminal. */
  readonly activeTurnId: string | undefined;
  readonly phase: TurnPhase;
  readonly pending: ReadonlyArray<QueuedTurnInput>;
};

export type SendDisposition =
  /** Fold into the live turn (steer / native interject). */
  | { readonly _tag: "steer"; readonly turnId: string }
  /** Held until the live turn settles. */
  | { readonly _tag: "queued"; readonly queueId: string; readonly position: number }
  /** No live turn — caller should open a new one. */
  | { readonly _tag: "start-new" };

export function emptyTurnQueue(): TurnQueueState {
  return {
    activeTurnId: undefined,
    phase: resetTurnPhase(),
    pending: [],
  };
}

/**
 * Classify a user send against the current queue + capability.
 * Does not mutate phase for start-new (caller starts the turn); steer and
 * queued update state when applicable.
 */
export function disposeSendWhileRunning(
  state: TurnQueueState,
  input: {
    readonly sendWhileRunning: SendWhileRunningBehavior;
    readonly nextTurn: QueuedTurnInput;
  },
): { readonly state: TurnQueueState; readonly disposition: SendDisposition } {
  const live =
    state.activeTurnId !== undefined && isLivePhase(state.phase) && state.phase !== "stopping";

  if (!live || state.activeTurnId === undefined) {
    return { state, disposition: { _tag: "start-new" } };
  }

  if (input.sendWhileRunning === "steer") {
    return {
      state,
      disposition: { _tag: "steer", turnId: state.activeTurnId },
    };
  }

  // queue
  const pending = [...state.pending, input.nextTurn];
  return {
    state: { ...state, pending },
    disposition: {
      _tag: "queued",
      queueId: input.nextTurn.id,
      position: pending.length,
    },
  };
}

/** Call when a new turn id is bound and preparation begins. */
export function beginTurn(state: TurnQueueState, turnId: string): TurnQueueState {
  return {
    ...state,
    activeTurnId: turnId,
    phase: transitionTurnPhase(
      state.phase === "terminal" || state.phase === "idle" ? "idle" : state.phase,
      { _tag: "SendStarted" },
    ),
  };
}

/** Call once the provider prompt/RPC is in flight. */
export function markTurnRunning(state: TurnQueueState): TurnQueueState {
  return {
    ...state,
    phase: transitionTurnPhase(state.phase, { _tag: "PromptDispatched" }),
  };
}

/** Call when Stop is requested. */
export function markTurnStopping(state: TurnQueueState): TurnQueueState {
  return {
    ...state,
    phase: transitionTurnPhase(state.phase, { _tag: "StopRequested" }),
  };
}

/**
 * Call when the live turn reaches a terminal state. Returns the next queued
 * turn (if any) so the caller can start it.
 */
export function settleTurn(
  state: TurnQueueState,
  reason: "completed" | "cancelled" | "error",
): {
  readonly state: TurnQueueState;
  readonly next: QueuedTurnInput | undefined;
} {
  const phase = transitionTurnPhase(state.phase, { _tag: "Settled", reason });
  const [next, ...rest] = state.pending;
  if (next === undefined) {
    return {
      state: {
        activeTurnId: undefined,
        phase: resetTurnPhase(),
        pending: [],
      },
      next: undefined,
    };
  }
  // Dequeue head; leave phase idle so beginTurn can open the next.
  return {
    state: {
      activeTurnId: undefined,
      phase: resetTurnPhase(),
      pending: rest,
    },
    next,
  };
}

export function pendingCount(state: TurnQueueState): number {
  return state.pending.length;
}
