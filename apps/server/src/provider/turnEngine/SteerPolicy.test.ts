import { describe, expect, it } from "vite-plus/test";

import { canSteerSendTurn } from "./SteerPolicy.ts";

describe("canSteerSendTurn", () => {
  it("allows steer when a live un-interrupted turn has prompts in flight", () => {
    expect(
      canSteerSendTurn({
        sendWhileRunning: "steer",
        promptsInFlight: 1,
        hasActiveTurnId: true,
        activeTurnInterrupted: false,
      }),
    ).toBe(true);
  });

  it("refuses when no prompts are in flight", () => {
    expect(
      canSteerSendTurn({
        sendWhileRunning: "steer",
        promptsInFlight: 0,
        hasActiveTurnId: true,
        activeTurnInterrupted: false,
      }),
    ).toBe(false);
  });

  it("refuses without an active turn id", () => {
    expect(
      canSteerSendTurn({
        sendWhileRunning: "steer",
        promptsInFlight: 1,
        hasActiveTurnId: false,
        activeTurnInterrupted: false,
      }),
    ).toBe(false);
  });

  it("refuses when the active turn was interrupted", () => {
    expect(
      canSteerSendTurn({
        sendWhileRunning: "steer",
        promptsInFlight: 1,
        hasActiveTurnId: true,
        activeTurnInterrupted: true,
      }),
    ).toBe(false);
  });

  it("refuses native steer when the provider declares queueing", () => {
    expect(
      canSteerSendTurn({
        sendWhileRunning: "queue",
        promptsInFlight: 1,
        hasActiveTurnId: true,
        activeTurnInterrupted: false,
      }),
    ).toBe(false);
  });
});
