/**
 * Authoritative terminal ownership for provider turns (SBS-428).
 *
 * Transports may observe duplicate, late, or stale terminal signals. They must
 * claim the shared lifecycle before mutating session state, closing tools,
 * emitting a terminal runtime event, or draining queued work.
 */

import { settleTrackedTurn, type QueuedTurnInput, type TurnQueueState } from "./TurnQueue.ts";

export type TurnSettlementReason = "completed" | "cancelled" | "error";

export type TurnSettlementMode =
  /** Normal provider completion: only the signal's exact turn may settle. */
  | "exact"
  /** Explicit Stop/death recovery: settle the currently tracked live turn. */
  | "active-turn-fallback";

export type TurnSettlementDecision =
  | {
      readonly claimed: false;
      readonly state: TurnQueueState;
      readonly next: undefined;
      readonly turnId: undefined;
    }
  | {
      readonly claimed: true;
      readonly state: TurnQueueState;
      readonly next: QueuedTurnInput | undefined;
      readonly turnId: string;
    };

export function claimTurnSettlement(
  state: TurnQueueState,
  input: {
    readonly turnId: string;
    readonly reason: TurnSettlementReason;
    readonly mode?: TurnSettlementMode;
  },
): TurnSettlementDecision {
  const turnId =
    input.mode === "active-turn-fallback" && state.activeTurnId !== undefined
      ? state.activeTurnId
      : input.turnId;
  const settlement = settleTrackedTurn(state, {
    turnId,
    reason: input.reason,
  });
  if (!settlement.claimed) {
    return {
      claimed: false,
      state,
      next: undefined,
      turnId: undefined,
    };
  }
  return {
    claimed: true,
    state: settlement.state,
    next: settlement.next,
    turnId,
  };
}
