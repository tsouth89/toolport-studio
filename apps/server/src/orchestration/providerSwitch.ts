/**
 * Deciding whether a turn is continuing a conversation or handing it to a
 * different provider (SOU-480).
 *
 * A thread used to be pinned to whichever driver started it, and requesting a
 * different one was rejected outright. That guard existed for a real reason:
 * each provider CLI owns its own session, and a resume cursor from one is
 * meaningless to another. The guard is not the constraint though, the cursor is.
 *
 * So a cross-driver request is allowed, and what changes is how the new session
 * starts: no resume cursor, and the incoming provider gets a handoff describing
 * the state of the work rather than a replay of the conversation it missed.
 */

export type ProviderSessionContinuity =
  /** Same driver. The existing session or its resume cursor still applies. */
  | { readonly kind: "continue" }
  /** Different driver. Start clean and hand over state. */
  | { readonly kind: "handoff"; readonly fromDriverKind: string; readonly toDriverKind: string };

export function resolveProviderSessionContinuity(input: {
  /** Null when the thread has no session yet, so nothing is being handed over. */
  readonly currentDriverKind: string | null | undefined;
  readonly desiredDriverKind: string;
}): ProviderSessionContinuity {
  const current = input.currentDriverKind;
  if (!current || current === input.desiredDriverKind) {
    return { kind: "continue" };
  }
  return {
    kind: "handoff",
    fromDriverKind: current,
    toDriverKind: input.desiredDriverKind,
  };
}

/**
 * A resume cursor is provider-private. Carrying one across a driver boundary
 * either fails or, worse, silently resumes the wrong conversation, so a handoff
 * always starts clean regardless of what the previous session left behind.
 */
export function shouldCarryResumeCursor(continuity: ProviderSessionContinuity): boolean {
  return continuity.kind === "continue";
}

/**
 * Whether to send the raw transcript alongside this turn.
 *
 * `conversationHistory` exists so a provider can rehydrate after its own resume
 * fails, and it grows with the thread. On a handoff the envelope already states
 * where the work stands, so sending both would pay the unbounded cost the
 * envelope exists to avoid, and hand the new provider two competing accounts of
 * the same conversation.
 */
export function shouldSendConversationHistory(continuity: ProviderSessionContinuity): boolean {
  return continuity.kind === "continue";
}
