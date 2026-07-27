/**
 * Provider turn capabilities as data — differences the shared turn engine
 * reads rather than reimplements per adapter (SOU-428).
 */

export type SendWhileRunningBehavior = "steer" | "queue";

export type TurnTerminalSignal =
  | "result-message"
  | "turn-completed"
  | "acp-stop-reason"
  | "session-status-idle";

export interface ProviderTurnCapabilities {
  readonly sendTurnBlocksUntilSettled: boolean;
  readonly sendWhileRunning: SendWhileRunningBehavior;
  readonly nativeInterject: "prompt-queue" | "turn-steer" | "acp-preempt" | "turn-reuse";
  readonly interruptCanHang: boolean;
  readonly subprocessLivenessObservable: boolean;
  readonly requiresCwdAtSessionStart: boolean;
  readonly requiresModelSelectionPerTurn: boolean;
  readonly turnTerminalSignal: TurnTerminalSignal;
}

/** Built-in driver kinds that declare turn capabilities (ProviderDriverKind values). */
export type BuiltInTurnEngineProvider = "claudeAgent" | "codex" | "grok" | "cursor" | "opencode";

export const PROVIDER_TURN_CAPABILITIES: Readonly<
  Record<BuiltInTurnEngineProvider, ProviderTurnCapabilities>
> = {
  claudeAgent: {
    sendTurnBlocksUntilSettled: false,
    sendWhileRunning: "steer",
    nativeInterject: "prompt-queue",
    interruptCanHang: false,
    subprocessLivenessObservable: false,
    requiresCwdAtSessionStart: false,
    requiresModelSelectionPerTurn: false,
    turnTerminalSignal: "result-message",
  },
  codex: {
    sendTurnBlocksUntilSettled: false,
    sendWhileRunning: "steer",
    nativeInterject: "turn-steer",
    interruptCanHang: true,
    subprocessLivenessObservable: true,
    requiresCwdAtSessionStart: false,
    requiresModelSelectionPerTurn: false,
    turnTerminalSignal: "turn-completed",
  },
  grok: {
    sendTurnBlocksUntilSettled: true,
    sendWhileRunning: "steer",
    nativeInterject: "acp-preempt",
    interruptCanHang: true,
    subprocessLivenessObservable: true,
    requiresCwdAtSessionStart: true,
    requiresModelSelectionPerTurn: false,
    turnTerminalSignal: "acp-stop-reason",
  },
  cursor: {
    sendTurnBlocksUntilSettled: true,
    sendWhileRunning: "steer",
    nativeInterject: "acp-preempt",
    interruptCanHang: true,
    subprocessLivenessObservable: true,
    requiresCwdAtSessionStart: true,
    requiresModelSelectionPerTurn: false,
    turnTerminalSignal: "acp-stop-reason",
  },
  opencode: {
    sendTurnBlocksUntilSettled: false,
    sendWhileRunning: "steer",
    nativeInterject: "turn-reuse",
    interruptCanHang: false,
    subprocessLivenessObservable: true,
    requiresCwdAtSessionStart: true,
    requiresModelSelectionPerTurn: true,
    turnTerminalSignal: "session-status-idle",
  },
};
