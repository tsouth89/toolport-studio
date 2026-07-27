import { describe, expect, it } from "vite-plus/test";

import { canSteerSendTurn } from "./SteerPolicy.ts";

describe("canSteerSendTurn", () => {
  it("allows steer when a live un-interrupted turn has prompts in flight", () => {
    expect(
      canSteerSendTurn({
        promptsInFlight: 1,
        hasActiveTurnId: true,
        activeTurnInterrupted: false,
      }),
    ).toBe(true);
  });

  it("refuses when no prompts are in flight", () => {
    expect(
      canSteerSendTurn({
        promptsInFlight: 0,
        hasActiveTurnId: true,
        activeTurnInterrupted: false,
      }),
    ).toBe(false);
  });

  it("refuses without an active turn id", () => {
    expect(
      canSteerSendTurn({
        promptsInFlight: 1,
        hasActiveTurnId: false,
        activeTurnInterrupted: false,
      }),
    ).toBe(false);
  });

  it("refuses when the active turn was interrupted", () => {
    expect(
      canSteerSendTurn({
        promptsInFlight: 1,
        hasActiveTurnId: true,
        activeTurnInterrupted: true,
      }),
    ).toBe(false);
  });
});
