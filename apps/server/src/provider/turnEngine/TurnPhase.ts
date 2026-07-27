/**
 * Authoritative turn phase machine. Invalid events leave the phase unchanged.
 */

export type TurnPhase = "idle" | "preparing" | "running" | "stopping" | "terminal";

export type TurnPhaseEvent =
  | { readonly _tag: "SendStarted" }
  | { readonly _tag: "PromptDispatched" }
  | { readonly _tag: "StopRequested" }
  | { readonly _tag: "Settled"; readonly reason: "completed" | "cancelled" | "error" };

export function transitionTurnPhase(phase: TurnPhase, event: TurnPhaseEvent): TurnPhase {
  switch (phase) {
    case "idle":
      if (event._tag === "SendStarted") return "preparing";
      return phase;
    case "preparing":
      if (event._tag === "PromptDispatched") return "running";
      if (event._tag === "StopRequested") return "stopping";
      if (event._tag === "Settled") return "terminal";
      return phase;
    case "running":
      if (event._tag === "StopRequested") return "stopping";
      if (event._tag === "Settled") return "terminal";
      return phase;
    case "stopping":
      if (event._tag === "Settled") return "terminal";
      return phase;
    case "terminal":
      // Stay terminal until an explicit reset (or a new SendStarted).
      if (event._tag === "SendStarted") return "preparing";
      return phase;
  }
}

export function isTerminalPhase(phase: TurnPhase): boolean {
  return phase === "terminal";
}

/** Preparing, running, or stopping — a turn is in flight. */
export function isLivePhase(phase: TurnPhase): boolean {
  return phase === "preparing" || phase === "running" || phase === "stopping";
}

export function resetTurnPhase(): TurnPhase {
  return "idle";
}
