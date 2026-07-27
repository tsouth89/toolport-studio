/**
 * Mid-turn message framing policy.
 *
 * Product default: never invent "stop the previous plan" framing —
 * additive constraints must not destroy long-running work.
 */

export type InterjectionFraming = "raw" | "abandon-work";

export interface FormatInterjectionInput {
  readonly userText: string;
  readonly isSteering: boolean;
  readonly framing?: InterjectionFraming;
}

/**
 * Returns the text to send to the model for this turn message.
 * Default framing is "raw" (pass-through).
 */
export function formatInterjectionText(input: FormatInterjectionInput): string {
  const framing = input.framing ?? "raw";
  if (!input.isSteering || framing === "raw") {
    return input.userText;
  }
  // abandon-work is retained only as a test/opt-in escape hatch.
  return (
    "The user interjected while you were working. Stop the previous plan and prioritize this instruction:\n\n" +
    input.userText
  );
}

/** Product: silence beats invention — no synthetic "Following up" chrome. */
export function shouldEmitSyntheticFollowUpChrome(): boolean {
  return false;
}

/** Projection concern, not transport — do not force-close tools on steer. */
export function shouldForceCloseOpenToolsOnSteer(): boolean {
  return false;
}
