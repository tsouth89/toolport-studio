import { describe, expect, it } from "vite-plus/test";

import {
  resolveProviderSessionContinuity,
  shouldCarryResumeCursor,
  shouldSendConversationHistory,
} from "./providerSwitch.ts";

describe("resolveProviderSessionContinuity", () => {
  it("continues when the driver is unchanged", () => {
    expect(
      resolveProviderSessionContinuity({
        currentDriverKind: "codex",
        desiredDriverKind: "codex",
      }),
    ).toEqual({ kind: "continue" });
  });

  it("continues when the thread has no session yet", () => {
    // Nothing to hand over before the first turn, so this is a plain start.
    for (const currentDriverKind of [null, undefined, ""]) {
      expect(
        resolveProviderSessionContinuity({ currentDriverKind, desiredDriverKind: "codex" }),
      ).toEqual({ kind: "continue" });
    }
  });

  it("reports a handoff across drivers, naming both sides", () => {
    expect(
      resolveProviderSessionContinuity({
        currentDriverKind: "claudeAgent",
        desiredDriverKind: "codex",
      }),
    ).toEqual({ kind: "handoff", fromDriverKind: "claudeAgent", toDriverKind: "codex" });
  });
});

describe("shouldCarryResumeCursor", () => {
  it("carries the cursor when continuing", () => {
    expect(shouldCarryResumeCursor({ kind: "continue" })).toBe(true);
  });

  it("never carries a cursor across a driver boundary", () => {
    // A resume cursor is provider-private. Reusing one across drivers either
    // fails outright or resumes the wrong conversation.
    expect(
      shouldCarryResumeCursor({
        kind: "handoff",
        fromDriverKind: "claudeAgent",
        toDriverKind: "codex",
      }),
    ).toBe(false);
  });
});

describe("shouldSendConversationHistory", () => {
  it("sends history when continuing, for resume-failure rehydration", () => {
    expect(shouldSendConversationHistory({ kind: "continue" })).toBe(true);
  });

  it("suppresses the raw transcript on a handoff", () => {
    // The envelope already states where the work stands. Sending both pays the
    // unbounded cost the envelope exists to avoid and gives the new provider
    // two competing accounts of the same conversation.
    expect(
      shouldSendConversationHistory({
        kind: "handoff",
        fromDriverKind: "grok",
        toDriverKind: "claudeAgent",
      }),
    ).toBe(false);
  });
});
