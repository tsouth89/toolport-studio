import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_TURN_CAPABILITIES, type BuiltInTurnEngineProvider } from "./TurnCapabilities.ts";

const PROVIDERS: ReadonlyArray<BuiltInTurnEngineProvider> = [
  "claudeAgent",
  "codex",
  "grok",
  "cursor",
  "opencode",
];

describe("PROVIDER_TURN_CAPABILITIES", () => {
  it("declares all five built-in providers", () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_TURN_CAPABILITIES[provider]).toBeDefined();
    }
    expect(Object.keys(PROVIDER_TURN_CAPABILITIES).sort()).toEqual([...PROVIDERS].sort());
  });

  it("declares sendWhileRunning as steer for every provider by default", () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_TURN_CAPABILITIES[provider].sendWhileRunning).toBe("steer");
    }
  });

  it("matches the audited capability matrix", () => {
    expect(PROVIDER_TURN_CAPABILITIES.claudeAgent).toMatchObject({
      sendTurnBlocksUntilSettled: false,
      nativeInterject: "prompt-queue",
      interruptCanHang: false,
      subprocessLivenessObservable: false,
      requiresCwdAtSessionStart: false,
      requiresModelSelectionPerTurn: false,
      turnTerminalSignal: "result-message",
    });
    expect(PROVIDER_TURN_CAPABILITIES.codex).toMatchObject({
      sendTurnBlocksUntilSettled: false,
      nativeInterject: "turn-steer",
      interruptCanHang: true,
      subprocessLivenessObservable: true,
      requiresCwdAtSessionStart: false,
      requiresModelSelectionPerTurn: false,
      turnTerminalSignal: "turn-completed",
    });
    expect(PROVIDER_TURN_CAPABILITIES.grok).toMatchObject({
      sendTurnBlocksUntilSettled: true,
      sendWhileRunning: "steer",
      nativeInterject: "acp-preempt",
      interruptCanHang: true,
      subprocessLivenessObservable: true,
      requiresCwdAtSessionStart: true,
      requiresModelSelectionPerTurn: false,
      turnTerminalSignal: "acp-stop-reason",
    });
    expect(PROVIDER_TURN_CAPABILITIES.cursor).toEqual(PROVIDER_TURN_CAPABILITIES.grok);
    expect(PROVIDER_TURN_CAPABILITIES.opencode).toMatchObject({
      sendTurnBlocksUntilSettled: false,
      nativeInterject: "turn-reuse",
      interruptCanHang: false,
      subprocessLivenessObservable: true,
      requiresCwdAtSessionStart: true,
      requiresModelSelectionPerTurn: true,
      turnTerminalSignal: "session-status-idle",
    });
  });
});
