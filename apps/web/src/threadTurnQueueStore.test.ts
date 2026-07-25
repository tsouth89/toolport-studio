import { describe, expect, it, beforeEach } from "vite-plus/test";

import { resolveComposerSubmitIntent, useThreadTurnQueueStore } from "./threadTurnQueueStore";

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

describe("useThreadTurnQueueStore", () => {
  beforeEach(() => {
    useThreadTurnQueueStore.setState({ queuesByThreadId: {} });
  });

  it("enqueues and dequeues in FIFO order", () => {
    const threadId = "thread-1";
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "first", images: [] });
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "second", images: [] });
    expect(useThreadTurnQueueStore.getState().count(threadId)).toBe(2);
    expect(useThreadTurnQueueStore.getState().dequeue(threadId)?.text).toBe("first");
    expect(useThreadTurnQueueStore.getState().dequeue(threadId)?.text).toBe("second");
    expect(useThreadTurnQueueStore.getState().dequeue(threadId)).toBeNull();
  });

  it("removes a specific queued item", () => {
    const threadId = "thread-2";
    const id = useThreadTurnQueueStore
      .getState()
      .enqueue(threadId, { text: "keep-me", images: [] });
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "drop-me", images: [] });
    const dropId = useThreadTurnQueueStore.getState().list(threadId)[1]?.id;
    expect(dropId).toBeDefined();
    useThreadTurnQueueStore.getState().remove(threadId, dropId!);
    expect(
      useThreadTurnQueueStore
        .getState()
        .list(threadId)
        .map((item) => item.id),
    ).toEqual([id]);
  });

  it("can re-enqueue a failed flush at the front", () => {
    const threadId = "thread-3";
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "second", images: [] });
    useThreadTurnQueueStore
      .getState()
      .enqueue(threadId, { text: "first-retry", images: [] }, { front: true });
    expect(
      useThreadTurnQueueStore
        .getState()
        .list(threadId)
        .map((item) => item.text),
    ).toEqual(["first-retry", "second"]);
  });
});
