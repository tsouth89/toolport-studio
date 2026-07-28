import { create } from "zustand";

import type { PreviewAnnotationPayload, ThreadId } from "@toolport-studio/contracts";

import type { ComposerImageAttachment } from "./composerDraftStore";
import type { ElementContextDraft } from "./lib/elementContext";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * In-memory per-thread queue for turns composed while the provider is still
 * running. Mid-turn default is queue (Enter); Send or Ctrl/Cmd+Enter steers
 * into the live turn. Empty Enter with a non-empty queue flushes send-now.
 * File handles are session-only (not persisted).
 */
export interface ThreadQueuedTurn {
  readonly id: string;
  readonly text: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly elementContexts: ReadonlyArray<ElementContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly createdAt: string;
}

export interface ThreadTurnQueueState {
  readonly queuesByThreadId: Readonly<Record<string, ReadonlyArray<ThreadQueuedTurn>>>;
  enqueue: (
    threadId: ThreadId | string,
    item: {
      readonly text: string;
      readonly images: ReadonlyArray<ComposerImageAttachment>;
      readonly terminalContexts?: ReadonlyArray<TerminalContextDraft>;
      readonly elementContexts?: ReadonlyArray<ElementContextDraft>;
      readonly previewAnnotations?: ReadonlyArray<PreviewAnnotationPayload>;
      readonly reviewComments?: ReadonlyArray<ReviewCommentContext>;
      readonly id?: string;
    },
    options?: { readonly front?: boolean },
  ) => string;
  /** Head of the queue without removing it. Drain uses peek → send → remove. */
  peek: (threadId: ThreadId | string) => ThreadQueuedTurn | null;
  dequeue: (threadId: ThreadId | string) => ThreadQueuedTurn | null;
  remove: (threadId: ThreadId | string, id: string) => void;
  clear: (threadId: ThreadId | string) => void;
  list: (threadId: ThreadId | string) => ReadonlyArray<ThreadQueuedTurn>;
  count: (threadId: ThreadId | string) => number;
}

const threadKey = (threadId: ThreadId | string): string => String(threadId);

/** Stable empty list so React selectors never allocate a new [] every render. */
export const EMPTY_THREAD_TURN_QUEUE: ReadonlyArray<ThreadQueuedTurn> = [];

let queuedTurnSequence = 0;

const newQueuedTurnId = (): string => {
  queuedTurnSequence = (queuedTurnSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `queued-${Date.now()}-${queuedTurnSequence}`;
};

export const useThreadTurnQueueStore = create<ThreadTurnQueueState>((set, get) => ({
  queuesByThreadId: {},
  enqueue: (threadId, item, options) => {
    const id = item.id ?? newQueuedTurnId();
    const key = threadKey(threadId);
    const entry: ThreadQueuedTurn = {
      id,
      text: item.text,
      images: item.images,
      terminalContexts: item.terminalContexts ?? [],
      elementContexts: item.elementContexts ?? [],
      previewAnnotations: item.previewAnnotations ?? [],
      reviewComments: item.reviewComments ?? [],
      createdAt: new Date().toISOString(),
    };
    set((state) => {
      const current = state.queuesByThreadId[key] ?? [];
      return {
        queuesByThreadId: {
          ...state.queuesByThreadId,
          [key]: options?.front ? [entry, ...current] : [...current, entry],
        },
      };
    });
    return id;
  },
  peek: (threadId) => {
    const current = get().queuesByThreadId[threadKey(threadId)] ?? EMPTY_THREAD_TURN_QUEUE;
    return current[0] ?? null;
  },
  dequeue: (threadId) => {
    const key = threadKey(threadId);
    const current = get().queuesByThreadId[key] ?? [];
    if (current.length === 0) {
      return null;
    }
    const [head, ...rest] = current;
    set((state) => {
      const nextQueues = { ...state.queuesByThreadId };
      if (rest.length === 0) {
        delete nextQueues[key];
      } else {
        nextQueues[key] = rest;
      }
      return { queuesByThreadId: nextQueues };
    });
    return head ?? null;
  },
  remove: (threadId, id) => {
    const key = threadKey(threadId);
    set((state) => {
      const current = state.queuesByThreadId[key] ?? [];
      const next = current.filter((entry) => entry.id !== id);
      const nextQueues = { ...state.queuesByThreadId };
      if (next.length === 0) {
        delete nextQueues[key];
      } else {
        nextQueues[key] = next;
      }
      return { queuesByThreadId: nextQueues };
    });
  },
  clear: (threadId) => {
    const key = threadKey(threadId);
    set((state) => {
      if (!(key in state.queuesByThreadId)) {
        return state;
      }
      const nextQueues = { ...state.queuesByThreadId };
      delete nextQueues[key];
      return { queuesByThreadId: nextQueues };
    });
  },
  list: (threadId) => get().queuesByThreadId[threadKey(threadId)] ?? EMPTY_THREAD_TURN_QUEUE,
  count: (threadId) =>
    (get().queuesByThreadId[threadKey(threadId)] ?? EMPTY_THREAD_TURN_QUEUE).length,
}));

export function resolveComposerSubmitIntent(input: {
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly ctrlOrMetaKey: boolean;
  readonly explicitIntent?: "auto" | "queue" | "steer" | "force";
}): "queue" | "steer" | "send" {
  if (input.explicitIntent === "force") {
    return "send";
  }
  if (input.explicitIntent === "steer") {
    return "steer";
  }
  if (input.explicitIntent === "queue") {
    return "queue";
  }
  if (input.phase === "running") {
    // Default while running: queue for after the turn. Second (empty) Enter
    // flushes the queue head as steer/send-now. Ctrl/Cmd+Enter or the Send
    // control injects into the live turn immediately.
    return input.ctrlOrMetaKey ? "steer" : "queue";
  }
  return "send";
}
