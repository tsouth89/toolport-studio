/**
 * Stop / settle policy shared across providers (SOU-428).
 *
 * Stop must always drive the turn to a terminal runtime state. Whether tools
 * are force-closed is a product decision that lives here, not per-adapter.
 */

import type { ProviderRuntimeEvent } from "@toolport-studio/contracts";

/** Stop tears down the turn; open tools should not block settlement. */
export function shouldForceCloseOpenToolsOnStop(): boolean {
  return true;
}

/**
 * Any settle (Stop, success end_turn, failure, process death) must not leave
 * ghost inProgress tool rows. If tools are still open when the turn terminals,
 * force-close them — same product rule as Stop, including "completed" turns
 * where the agent never emitted tool completion.
 */
export function shouldForceCloseRemainingOpenToolsOnSettle(openToolCount: number): boolean {
  return openToolCount > 0 && shouldForceCloseOpenToolsOnStop();
}

/** Shared work-log copy when Studio force-closes an open tool. */
export const OPEN_TOOL_FORCE_CLOSE_DETAIL = "Tool did not complete before the turn stopped.";

/** Raw event source tag for adapter force-close emits. */
export const OPEN_TOOL_FORCE_CLOSE_SOURCE = "studio.open-tool-force-close";

/** Runtime events that mean the turn itself is finished. */
export function isTurnTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.aborted";
}

/**
 * Runtime events that mean the session is usable again after Stop
 * (Working chrome can clear even if a specific turn id was lost).
 */
export function isSessionSettledRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "session.state.changed" &&
    (event.payload.state === "ready" || event.payload.state === "error")
  );
}

/** Either a turn terminal or session settled — Stop's success criterion. */
export function isStopSettledRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return isTurnTerminalRuntimeEvent(event) || isSessionSettledRuntimeEvent(event);
}

/**
 * Process/transport death must surface as a typed runtime failure, not silence.
 * Accepts error, exited, failed turn, or error session state.
 */
export function isProcessDeathRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  if (event.type === "runtime.error") {
    return true;
  }
  if (event.type === "session.exited") {
    return true;
  }
  if (event.type === "session.state.changed" && event.payload.state === "error") {
    return true;
  }
  if (event.type === "turn.completed" && event.payload.state === "failed") {
    return true;
  }
  if (event.type === "turn.aborted") {
    return true;
  }
  return false;
}

/** Pending interactive prompts that Stop must not leave hanging. */
export function isPendingInteractionRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "request.opened" || event.type === "user-input.requested";
}

/**
 * Preferred settle order for adapters that can do both:
 * force-close open tools (optional), cancel/interrupt transport, emit turn terminal.
 */
export type StopSettleStep = "force-close-open-tools" | "interrupt-transport" | "emit-terminal";

export function stopSettleSequence(input?: {
  readonly hasOpenTools?: boolean;
}): ReadonlyArray<StopSettleStep> {
  const steps: Array<StopSettleStep> = [];
  if (input?.hasOpenTools && shouldForceCloseOpenToolsOnStop()) {
    steps.push("force-close-open-tools");
  }
  steps.push("interrupt-transport", "emit-terminal");
  return steps;
}
