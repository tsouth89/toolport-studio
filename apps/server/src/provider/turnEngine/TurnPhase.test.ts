import { describe, expect, it } from "vite-plus/test";

import {
  isLivePhase,
  isTerminalPhase,
  resetTurnPhase,
  transitionTurnPhase,
  type TurnPhase,
  type TurnPhaseEvent,
} from "./TurnPhase.ts";

describe("transitionTurnPhase", () => {
  it("moves idle → preparing on SendStarted", () => {
    expect(transitionTurnPhase("idle", { _tag: "SendStarted" })).toBe("preparing");
  });

  it("moves preparing → running on PromptDispatched", () => {
    expect(transitionTurnPhase("preparing", { _tag: "PromptDispatched" })).toBe("running");
  });

  it("moves preparing → stopping on StopRequested", () => {
    expect(transitionTurnPhase("preparing", { _tag: "StopRequested" })).toBe("stopping");
  });

  it("moves preparing → terminal on Settled", () => {
    expect(transitionTurnPhase("preparing", { _tag: "Settled", reason: "cancelled" })).toBe(
      "terminal",
    );
  });

  it("moves running → stopping on StopRequested", () => {
    expect(transitionTurnPhase("running", { _tag: "StopRequested" })).toBe("stopping");
  });

  it("moves running → terminal on Settled", () => {
    expect(transitionTurnPhase("running", { _tag: "Settled", reason: "completed" })).toBe(
      "terminal",
    );
  });

  it("moves stopping → terminal on Settled", () => {
    expect(transitionTurnPhase("stopping", { _tag: "Settled", reason: "error" })).toBe("terminal");
  });

  it("allows SendStarted from terminal for the next turn", () => {
    expect(transitionTurnPhase("terminal", { _tag: "SendStarted" })).toBe("preparing");
  });

  it("leaves phase unchanged for invalid events", () => {
    const cases: Array<{ phase: TurnPhase; event: TurnPhaseEvent }> = [
      { phase: "idle", event: { _tag: "PromptDispatched" } },
      { phase: "idle", event: { _tag: "StopRequested" } },
      { phase: "idle", event: { _tag: "Settled", reason: "completed" } },
      { phase: "preparing", event: { _tag: "SendStarted" } },
      { phase: "running", event: { _tag: "PromptDispatched" } },
      { phase: "running", event: { _tag: "SendStarted" } },
      { phase: "stopping", event: { _tag: "StopRequested" } },
      { phase: "stopping", event: { _tag: "PromptDispatched" } },
      { phase: "terminal", event: { _tag: "StopRequested" } },
      { phase: "terminal", event: { _tag: "Settled", reason: "completed" } },
    ];
    for (const { phase, event } of cases) {
      expect(transitionTurnPhase(phase, event)).toBe(phase);
    }
  });
});

describe("phase predicates", () => {
  it("isTerminalPhase only for terminal", () => {
    expect(isTerminalPhase("terminal")).toBe(true);
    expect(isTerminalPhase("idle")).toBe(false);
    expect(isTerminalPhase("running")).toBe(false);
  });

  it("isLivePhase for preparing, running, stopping", () => {
    expect(isLivePhase("preparing")).toBe(true);
    expect(isLivePhase("running")).toBe(true);
    expect(isLivePhase("stopping")).toBe(true);
    expect(isLivePhase("idle")).toBe(false);
    expect(isLivePhase("terminal")).toBe(false);
  });

  it("resetTurnPhase returns idle", () => {
    expect(resetTurnPhase()).toBe("idle");
  });
});
