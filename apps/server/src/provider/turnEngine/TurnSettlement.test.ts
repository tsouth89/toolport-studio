import { describe, expect, it } from "vite-plus/test";

import { beginTurn, emptyTurnQueue, markTurnRunning } from "./TurnQueue.ts";
import { claimTurnSettlement } from "./TurnSettlement.ts";

function runningTurn(turnId: string) {
  return markTurnRunning(beginTurn(emptyTurnQueue(), turnId));
}

describe("claimTurnSettlement", () => {
  it("claims the exact live turn once", () => {
    const first = claimTurnSettlement(runningTurn("turn-1"), {
      turnId: "turn-1",
      reason: "completed",
    });
    expect(first).toMatchObject({ claimed: true, turnId: "turn-1" });
    if (!first.claimed) throw new Error("expected settlement to be claimed");

    const duplicate = claimTurnSettlement(first.state, {
      turnId: "turn-1",
      reason: "completed",
    });
    expect(duplicate.claimed).toBe(false);
  });

  it("does not let a stale normal completion settle the live turn", () => {
    const state = runningTurn("turn-new");
    const settlement = claimTurnSettlement(state, {
      turnId: "turn-old",
      reason: "completed",
    });

    expect(settlement).toEqual({
      claimed: false,
      state,
      next: undefined,
      turnId: undefined,
    });
  });

  it("lets explicit recovery settle the currently tracked turn", () => {
    const settlement = claimTurnSettlement(runningTurn("turn-live"), {
      turnId: "turn-stale-stop",
      reason: "cancelled",
      mode: "active-turn-fallback",
    });

    expect(settlement).toMatchObject({
      claimed: true,
      turnId: "turn-live",
      state: { activeTurnId: undefined, phase: "idle" },
    });
  });

  it("cannot fabricate an active turn for recovery", () => {
    const settlement = claimTurnSettlement(emptyTurnQueue(), {
      turnId: "turn-stale-stop",
      reason: "cancelled",
      mode: "active-turn-fallback",
    });

    expect(settlement.claimed).toBe(false);
  });
});
