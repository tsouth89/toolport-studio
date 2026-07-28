import { describe, expect, it, beforeEach } from "vite-plus/test";
import { ThreadId } from "@toolport-studio/contracts";

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

  it("peeks the head without removing it so drain can send then remove on success", () => {
    const threadId = "thread-peek";
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "head", images: [] });
    useThreadTurnQueueStore.getState().enqueue(threadId, { text: "tail", images: [] });
    expect(useThreadTurnQueueStore.getState().peek(threadId)?.text).toBe("head");
    expect(useThreadTurnQueueStore.getState().count(threadId)).toBe(2);
    expect(useThreadTurnQueueStore.getState().peek(threadId)?.text).toBe("head");
    const headId = useThreadTurnQueueStore.getState().peek(threadId)?.id;
    expect(headId).toBeDefined();
    useThreadTurnQueueStore.getState().remove(threadId, headId!);
    expect(useThreadTurnQueueStore.getState().peek(threadId)?.text).toBe("tail");
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

  it("preserves every composer context while a turn waits in the queue", () => {
    const threadId = ThreadId.make("thread-with-context");
    const terminalContext = {
      id: "terminal-context",
      threadId,
      createdAt: "2026-07-25T20:00:00.000Z",
      terminalId: "terminal-1",
      terminalLabel: "PowerShell",
      lineStart: 1,
      lineEnd: 1,
      text: "vp test run",
    };
    const elementContext = {
      id: "element-context",
      threadId,
      pickedAt: "2026-07-25T20:00:00.000Z",
      pageUrl: "http://localhost:3773",
      pageTitle: "Toolport Studio",
      tagName: "button",
      selector: "#send",
      htmlPreview: "<button>Send</button>",
      componentName: "SendButton",
      source: null,
      styles: "",
    };
    const previewAnnotation = {
      id: "preview-annotation",
      pageUrl: "http://localhost:3773",
      pageTitle: "Toolport Studio",
      comment: "Fix this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-07-25T20:00:00.000Z",
    };
    const reviewComment = {
      id: "review-comment",
      sectionId: "file:src/app.ts",
      sectionTitle: "File comment",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Check this",
      diff: "+const fixed = true;",
    };

    useThreadTurnQueueStore.getState().enqueue(threadId, {
      text: "Use the attached context",
      images: [],
      terminalContexts: [terminalContext],
      elementContexts: [elementContext],
      previewAnnotations: [previewAnnotation],
      reviewComments: [reviewComment],
    });

    const queued = useThreadTurnQueueStore.getState().dequeue(threadId);
    expect(queued).toMatchObject({
      terminalContexts: [terminalContext],
      elementContexts: [elementContext],
      previewAnnotations: [previewAnnotation],
      reviewComments: [reviewComment],
    });
  });
});
