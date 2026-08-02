import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSubmitIntent } from "./threadTurnQueueStore";

describe("resolveComposerSubmitIntent", () => {
  it("sends normally when the session is idle", () => {
    expect(
      resolveComposerSubmitIntent({
        phase: "ready",
        ctrlOrMetaKey: false,
      }),
    ).toBe("send");
  });

  it("queues by default while a turn is running", () => {
    expect(
      resolveComposerSubmitIntent({
        phase: "running",
        ctrlOrMetaKey: false,
      }),
    ).toBe("queue");
  });

  it("steers with ctrl/meta while a turn is running", () => {
    expect(
      resolveComposerSubmitIntent({
        phase: "running",
        ctrlOrMetaKey: true,
      }),
    ).toBe("steer");
  });

  it("honors explicit intents", () => {
    expect(
      resolveComposerSubmitIntent({
        phase: "running",
        ctrlOrMetaKey: false,
        explicitIntent: "steer",
      }),
    ).toBe("steer");
    expect(
      resolveComposerSubmitIntent({
        phase: "ready",
        ctrlOrMetaKey: true,
        explicitIntent: "force",
      }),
    ).toBe("send");
  });
});
