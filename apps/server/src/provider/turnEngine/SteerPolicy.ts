import type { SendWhileRunningBehavior } from "./TurnCapabilities.ts";

/**
 * Whether a mid-turn send should steer into the live turn rather than open a
 * new one. The declared provider behavior is authoritative; interrupted turns
 * are never eligible.
 */
export function canSteerSendTurn(input: {
  readonly sendWhileRunning: SendWhileRunningBehavior;
  readonly promptsInFlight: number;
  readonly hasActiveTurnId: boolean;
  readonly activeTurnInterrupted: boolean;
}): boolean {
  return (
    input.sendWhileRunning === "steer" &&
    input.promptsInFlight > 0 &&
    input.hasActiveTurnId &&
    !input.activeTurnInterrupted
  );
}
