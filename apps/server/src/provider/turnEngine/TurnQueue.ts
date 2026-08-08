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
  // Validate the phase machine transition even though the settled queue
  // always resets phase below when dequeuing / going idle.
  transitionTurnPhase(state.phase, { _tag: "Settled", reason });
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

/**
 * Settle only when `turnId` still owns the live lifecycle. Late transport
 * completions and duplicated Stop/result paths must not terminalize a newer
 * turn or drain its queue.
 */
export function settleTrackedTurn(
  state: TurnQueueState,
  input: {
    readonly turnId: string;
    readonly reason: "completed" | "cancelled" | "error";
  },
): {
  readonly claimed: boolean;
  readonly state: TurnQueueState;
  readonly next: QueuedTurnInput | undefined;
} {
  if (state.activeTurnId !== input.turnId || !isLivePhase(state.phase)) {
    return { claimed: false, state, next: undefined };
  }

  const settled = settleTurn(state, input.reason);
  return { claimed: true, ...settled };
}

export function pendingCount(state: TurnQueueState): number {
  return state.pending.length;
}

/**
 * Drop the live turn and every held send (Stop / session teardown). Callers
 * must cancel any adapter-side waiters for the returned abandoned inputs.
 */
export function abandonTurnQueue(state: TurnQueueState): {
  readonly state: TurnQueueState;
  readonly abandoned: ReadonlyArray<QueuedTurnInput>;
} {
  return {
    state: emptyTurnQueue(),
    abandoned: state.pending,
  };
}

/**
 * Drop held sends while preserving ownership of the live turn. Stop uses this
 * before transport cancellation so the lifecycle can still make one terminal
 * transition for the active turn.
 */
export function abandonPendingTurns(state: TurnQueueState): {
  readonly state: TurnQueueState;
  readonly abandoned: ReadonlyArray<QueuedTurnInput>;
} {
  return {
    state: { ...state, pending: [] },
    abandoned: state.pending,
  };
}

/**
 * Sync queue bookkeeping with a live provider turn id. No-op when already
 * tracking the same id in a live phase.
 */
export function trackLiveTurn(state: TurnQueueState, turnId: string): TurnQueueState {
  if (state.activeTurnId === turnId && isLivePhase(state.phase) && state.phase !== "stopping") {
    if (state.phase === "preparing") {
      return markTurnRunning(state);
    }
    return state;
  }
  let next = state;
  if (
    state.activeTurnId !== undefined &&
    state.activeTurnId !== turnId &&
    isLivePhase(state.phase)
  ) {
    // Replace stale live id without draining pending (caller settles first).
    next = {
      ...state,
      activeTurnId: undefined,
      phase: resetTurnPhase(),
    };
  }
  next = beginTurn(next, turnId);
  return markTurnRunning(next);
}
