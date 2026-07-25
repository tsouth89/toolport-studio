import { describe, expect, it } from "vite-plus/test";

import {
  STALLED_TURN_THRESHOLD_MS,
  deriveLastStreamActivityAt,
  deriveStalledTurnState,
  formatStalledSilenceLabel,
} from "./stalledTurn";

const T0 = "2026-07-25T12:00:00.000Z";
const T0_MS = Date.parse(T0);

describe("deriveLastStreamActivityAt", () => {
  it("returns null when no timestamps are available", () => {
    expect(deriveLastStreamActivityAt({})).toBeNull();
    expect(
      deriveLastStreamActivityAt({
        threadUpdatedAt: null,
        sessionUpdatedAt: null,
        latestTurnRequestedAt: null,
        latestTurnStartedAt: null,
      }),
    ).toBeNull();
  });

  it("picks the latest of the available timestamps", () => {
    expect(
      deriveLastStreamActivityAt({
        threadUpdatedAt: "2026-07-25T12:00:10.000Z",
        sessionUpdatedAt: "2026-07-25T12:00:05.000Z",
        latestTurnRequestedAt: "2026-07-25T12:00:00.000Z",
        latestTurnStartedAt: "2026-07-25T12:00:01.000Z",
      }),
    ).toBe("2026-07-25T12:00:10.000Z");
  });

  it("ignores invalid timestamps", () => {
    expect(
      deriveLastStreamActivityAt({
        threadUpdatedAt: "not-a-date",
        sessionUpdatedAt: "2026-07-25T12:00:05.000Z",
      }),
    ).toBe("2026-07-25T12:00:05.000Z");
  });
});

describe("deriveStalledTurnState", () => {
  it("is not stalled when the turn is not running", () => {
    expect(
      deriveStalledTurnState({
        isRunning: false,
        lastActivityAt: T0,
        nowMs: T0_MS + STALLED_TURN_THRESHOLD_MS + 1_000,
      }),
    ).toEqual({ isStalled: false, silentForMs: 0 });
  });

  it("stalls immediately when running with no activity clock", () => {
    expect(
      deriveStalledTurnState({
        isRunning: true,
        lastActivityAt: null,
        nowMs: T0_MS + STALLED_TURN_THRESHOLD_MS + 1_000,
      }),
    ).toEqual({ isStalled: true, silentForMs: STALLED_TURN_THRESHOLD_MS });
  });

  it("is not stalled before the silence threshold", () => {
    expect(
      deriveStalledTurnState({
        isRunning: true,
        lastActivityAt: T0,
        nowMs: T0_MS + STALLED_TURN_THRESHOLD_MS - 1,
      }),
    ).toEqual({
      isStalled: false,
      silentForMs: STALLED_TURN_THRESHOLD_MS - 1,
    });
  });

  it("becomes stalled exactly at the default 30s threshold", () => {
    expect(
      deriveStalledTurnState({
        isRunning: true,
        lastActivityAt: T0,
        nowMs: T0_MS + STALLED_TURN_THRESHOLD_MS,
      }),
    ).toEqual({
      isStalled: true,
      silentForMs: STALLED_TURN_THRESHOLD_MS,
    });
  });

  it("honors an explicit threshold", () => {
    expect(
      deriveStalledTurnState({
        isRunning: true,
        lastActivityAt: T0,
        nowMs: T0_MS + 5_000,
        thresholdMs: 5_000,
      }),
    ).toEqual({ isStalled: true, silentForMs: 5_000 });
  });

  it("clamps negative silence from clock skew to zero", () => {
    expect(
      deriveStalledTurnState({
        isRunning: true,
        lastActivityAt: T0,
        nowMs: T0_MS - 5_000,
      }),
    ).toEqual({ isStalled: false, silentForMs: 0 });
  });
});

describe("formatStalledSilenceLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatStalledSilenceLabel(0)).toBe("0s");
    expect(formatStalledSilenceLabel(45_000)).toBe("45s");
    expect(formatStalledSilenceLabel(125_000)).toBe("2m 5s");
    expect(formatStalledSilenceLabel(3_600_000)).toBe("1h");
    expect(formatStalledSilenceLabel(3_720_000)).toBe("1h 2m");
  });
});
