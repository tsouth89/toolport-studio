import { describe, expect, it } from "vite-plus/test";
import type { ProviderRuntimeEvent } from "@toolport-studio/contracts";

import {
  isPendingInteractionRuntimeEvent,
  isProcessDeathRuntimeEvent,
  isSessionSettledRuntimeEvent,
  isStopSettledRuntimeEvent,
  isTurnTerminalRuntimeEvent,
  OPEN_TOOL_FORCE_CLOSE_DETAIL,
  shouldForceCloseOpenToolsOnStop,
  shouldForceCloseRemainingOpenToolsOnSettle,
  stopSettleSequence,
} from "./StopPolicy.ts";

const base = {
  eventId: "e1" as never,
  provider: "grok" as never,
  createdAt: "2026-01-01T00:00:00.000Z",
  threadId: "t1" as never,
};

describe("StopPolicy", () => {
  it("force-closes open tools on Stop", () => {
    expect(shouldForceCloseOpenToolsOnStop()).toBe(true);
  });

  it("force-closes remaining open tools on any settle, including completed", () => {
    expect(shouldForceCloseRemainingOpenToolsOnSettle(0)).toBe(false);
    expect(shouldForceCloseRemainingOpenToolsOnSettle(1)).toBe(true);
    expect(OPEN_TOOL_FORCE_CLOSE_DETAIL).toMatch(/did not complete/i);
  });

  it("classifies turn terminal events", () => {
    const completed = {
      ...base,
      type: "turn.completed",
      turnId: "turn-1" as never,
      payload: { state: "cancelled", stopReason: "cancelled" },
    } as ProviderRuntimeEvent;
    const aborted = {
      ...base,
      type: "turn.aborted",
      turnId: "turn-1" as never,
      payload: { reason: "cancelled" },
    } as ProviderRuntimeEvent;
    expect(isTurnTerminalRuntimeEvent(completed)).toBe(true);
    expect(isTurnTerminalRuntimeEvent(aborted)).toBe(true);
  });

  it("classifies session settled events", () => {
    const ready = {
      ...base,
      type: "session.state.changed",
      payload: { state: "ready", reason: "ok" },
    } as ProviderRuntimeEvent;
    const running = {
      ...base,
      type: "session.state.changed",
      payload: { state: "running", reason: "working" },
    } as ProviderRuntimeEvent;
    expect(isSessionSettledRuntimeEvent(ready)).toBe(true);
    expect(isSessionSettledRuntimeEvent(running)).toBe(false);
    expect(isStopSettledRuntimeEvent(ready)).toBe(true);
  });

  it("orders stop settle steps", () => {
    expect(stopSettleSequence({ hasOpenTools: true })).toEqual([
      "force-close-open-tools",
      "interrupt-transport",
      "emit-terminal",
    ]);
    expect(stopSettleSequence({ hasOpenTools: false })).toEqual([
      "interrupt-transport",
      "emit-terminal",
    ]);
  });

  it("classifies process death surfaces", () => {
    expect(
      isProcessDeathRuntimeEvent({
        ...base,
        type: "runtime.error",
        payload: { message: "dead", class: "provider_error" },
      } as ProviderRuntimeEvent),
    ).toBe(true);
    expect(
      isProcessDeathRuntimeEvent({
        ...base,
        type: "session.exited",
        payload: { reason: "crash" },
      } as ProviderRuntimeEvent),
    ).toBe(true);
    expect(
      isProcessDeathRuntimeEvent({
        ...base,
        type: "turn.completed",
        turnId: "t" as never,
        payload: { state: "completed", stopReason: "end_turn" },
      } as ProviderRuntimeEvent),
    ).toBe(false);
  });

  it("classifies pending interaction events", () => {
    expect(
      isPendingInteractionRuntimeEvent({
        ...base,
        type: "request.opened",
        requestId: "r1" as never,
        payload: { requestType: "exec_command_approval" },
      } as ProviderRuntimeEvent),
    ).toBe(true);
    expect(
      isPendingInteractionRuntimeEvent({
        ...base,
        type: "user-input.requested",
        requestId: "r1" as never,
        payload: { questions: [] },
      } as ProviderRuntimeEvent),
    ).toBe(true);
  });
});
