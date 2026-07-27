/**
 * Whether a mid-turn send should steer into the live turn rather than open a
 * new one. Interrupted turns are never eligible.
 */
export function canSteerSendTurn(input: {
  readonly promptsInFlight: number;
  readonly hasActiveTurnId: boolean;
  readonly activeTurnInterrupted: boolean;
}): boolean {
  return input.promptsInFlight > 0 && input.hasActiveTurnId && !input.activeTurnInterrupted;
}
