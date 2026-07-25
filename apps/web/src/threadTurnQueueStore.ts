import { create } from "zustand";

import type { ThreadId } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "./composerDraftStore";

/**
 * In-memory per-thread queue for turns composed while the provider is still
 * running. Default send-while-running behavior is queue; steer is explicit.
 * File handles are session-only (not persisted).
 */
export interface ThreadQueuedTurn {
  readonly id: string;
  readonly text: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly createdAt: string;
}

export interface ThreadTurnQueueState {
  readonly queuesByThreadId: Readonly<Record<string, ReadonlyArray<ThreadQueuedTurn>>>;
  enqueue: (
    threadId: ThreadId | string,
    item: {
      readonly text: string;
      readonly images: ReadonlyArray<ComposerImageAttachment>;
      readonly id?: string;
    },
    options?: { readonly front?: boolean },
  ) => string;
  dequeue: (threadId: ThreadId | string) => ThreadQueuedTurn | null;
  remove: (threadId: ThreadId | string, id: string) => void;
  clear: (threadId: ThreadId | string) => void;
  list: (threadId: ThreadId | string) => ReadonlyArray<ThreadQueuedTurn>;
  count: (threadId: ThreadId | string) => number;
}

const threadKey = (threadId: ThreadId | string): string => String(threadId);

const newQueuedTurnId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  list: (threadId) => get().queuesByThreadId[threadKey(threadId)] ?? [],
  count: (threadId) => (get().queuesByThreadId[threadKey(threadId)] ?? []).length,
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
    // Default while running: queue. Ctrl/Cmd+Enter steers into the live turn.
    return input.ctrlOrMetaKey ? "steer" : "queue";
  }
  return "send";
}
