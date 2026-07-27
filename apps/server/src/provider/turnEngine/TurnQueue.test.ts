import { describe, expect, it } from "vite-plus/test";

import {
  abandonTurnQueue,
  beginTurn,
  disposeSendWhileRunning,
  emptyTurnQueue,
  markTurnRunning,
  markTurnStopping,
  pendingCount,
  settleTurn,
  trackLiveTurn,
} from "./TurnQueue.ts";

const turn = (id: string, text = "hi") => ({
  id,
  text,
  enqueuedAtMs: 1,
});

describe("TurnQueue", () => {
  it("starts a new turn when idle", () => {
    const { disposition } = disposeSendWhileRunning(emptyTurnQueue(), {
      sendWhileRunning: "steer",
      nextTurn: turn("a"),
    });
    expect(disposition).toEqual({ _tag: "start-new" });
  });

  it("steers into a live turn when capability is steer", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    const result = disposeSendWhileRunning(state, {
      sendWhileRunning: "steer",
      nextTurn: turn("b"),
    });
    expect(result.disposition).toEqual({ _tag: "steer", turnId: "turn-1" });
    expect(pendingCount(result.state)).toBe(0);
  });

  it("queues while running when capability is queue", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    const first = disposeSendWhileRunning(state, {
      sendWhileRunning: "queue",
      nextTurn: turn("b", "second"),
    });
    expect(first.disposition._tag).toBe("queued");
    expect(pendingCount(first.state)).toBe(1);

    const second = disposeSendWhileRunning(first.state, {
      sendWhileRunning: "queue",
      nextTurn: turn("c", "third"),
    });
    expect(pendingCount(second.state)).toBe(2);
    if (second.disposition._tag === "queued") {
      expect(second.disposition.position).toBe(2);
    }
  });

  it("does not steer while stopping", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    state = markTurnStopping(state);
    const result = disposeSendWhileRunning(state, {
      sendWhileRunning: "steer",
      nextTurn: turn("b"),
    });
    expect(result.disposition).toEqual({ _tag: "start-new" });
  });

  it("dequeues the next turn on settle", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    state = disposeSendWhileRunning(state, {
      sendWhileRunning: "queue",
      nextTurn: turn("b", "second"),
    }).state;
    state = disposeSendWhileRunning(state, {
      sendWhileRunning: "queue",
      nextTurn: turn("c", "third"),
    }).state;

    const firstSettle = settleTurn(state, "completed");
    expect(firstSettle.next?.id).toBe("b");
    expect(pendingCount(firstSettle.state)).toBe(1);

    let nextState = beginTurn(firstSettle.state, "turn-2");
    nextState = markTurnRunning(nextState);
    const secondSettle = settleTurn(nextState, "completed");
    expect(secondSettle.next?.id).toBe("c");
    expect(pendingCount(secondSettle.state)).toBe(0);
  });

  it("clears active turn when settling with empty queue", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    const settled = settleTurn(state, "cancelled");
    expect(settled.next).toBeUndefined();
    expect(settled.state.activeTurnId).toBeUndefined();
    expect(settled.state.phase).toBe("idle");
  });

  it("abandons pending inputs on Stop without returning a next turn", () => {
    let state = beginTurn(emptyTurnQueue(), "turn-1");
    state = markTurnRunning(state);
    state = disposeSendWhileRunning(state, {
      sendWhileRunning: "queue",
      nextTurn: turn("b", "second"),
    }).state;
    const abandoned = abandonTurnQueue(state);
    expect(abandoned.abandoned.map((entry) => entry.id)).toEqual(["b"]);
    expect(pendingCount(abandoned.state)).toBe(0);
    expect(abandoned.state.activeTurnId).toBeUndefined();
  });

  it("trackLiveTurn marks a running turn for queue bookkeeping", () => {
    const state = trackLiveTurn(emptyTurnQueue(), "turn-1");
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.phase).toBe("running");
    expect(trackLiveTurn(state, "turn-1").phase).toBe("running");
  });
});
