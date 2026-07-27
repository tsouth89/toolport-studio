import { describe, expect, it } from "vite-plus/test";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  isSessionSettledRuntimeEvent,
  isStopSettledRuntimeEvent,
  isTurnTerminalRuntimeEvent,
  shouldForceCloseOpenToolsOnStop,
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
      payload: {},
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
});
