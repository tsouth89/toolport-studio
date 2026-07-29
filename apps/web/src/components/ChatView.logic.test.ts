import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@toolport-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Thread } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  resolveThreadError,
  isThreadBusyForProviderSwitch,
  deriveLockedProvider,
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  shouldAutoDrainQueuedTurn,
  shouldShowBranchMismatchBanner,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readFileAsDataUrl", () => {
  it("aborts an in-flight image read when send preparation is cancelled", async () => {
    const listeners = new Map<string, Set<() => void>>();
    let abortCalls = 0;
    class HangingFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;

      addEventListener(type: string, listener: () => void) {
        const registered = listeners.get(type) ?? new Set();
        registered.add(listener);
        listeners.set(type, registered);
      }

      abort() {
        abortCalls += 1;
        for (const listener of listeners.get("abort") ?? []) {
          listener();
        }
      }

      readAsDataURL() {}
    }
    vi.stubGlobal("FileReader", HangingFileReader);
    const controller = new AbortController();
    const read = readFileAsDataUrl(
      {
        name: "daily-driver.png",
      } as File,
      { signal: controller.signal },
    );

    controller.abort();

    await expect(read).rejects.toMatchObject({
      name: "AbortError",
      message: "Image read was cancelled for 'daily-driver.png'.",
    });
    expect(abortCalls).toBe(1);
  });
});

describe("shouldAutoDrainQueuedTurn", () => {
  const ready = {
    queueCount: 1,
    phase: "ready" as const,
    queueFlushInFlight: false,
    sendInFlight: false,
    isSendBusy: false,
    isConnecting: false,
    composerHasDraftContent: false,
  };

  it("drains when the provider is ready even if a stale turn projection has not settled", () => {
    expect(shouldAutoDrainQueuedTurn(ready)).toBe(true);
  });

  it("waits while a new composer draft would be overwritten", () => {
    expect(shouldAutoDrainQueuedTurn({ ...ready, composerHasDraftContent: true })).toBe(false);
  });

  it("waits while the live turn or another dispatch is active", () => {
    expect(shouldAutoDrainQueuedTurn({ ...ready, phase: "running" })).toBe(false);
    expect(shouldAutoDrainQueuedTurn({ ...ready, sendInFlight: true })).toBe(false);
    expect(shouldAutoDrainQueuedTurn({ ...ready, queueFlushInFlight: true })).toBe(false);
  });

  it("waits until the composer is ready after a thread switch", () => {
    expect(shouldAutoDrainQueuedTurn({ ...ready, composerReady: false })).toBe(false);
    expect(shouldAutoDrainQueuedTurn({ ...ready, composerReady: true })).toBe(true);
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });

  it("targets a starting session active turn for Stop during recycle", () => {
    const activeTurnId = TurnId.make("turn-starting");
    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "starting",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("falls back to an unsettled latest turn when session has no activeTurnId", () => {
    const unsettledTurnId = TurnId.make("turn-unsettled");
    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId: null,
          },
          latestTurn: {
            turnId: unsettledTurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: unsettledTurnId });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("treats dispatch from another thread as not active for this composer", () => {
    const threadA = makeThread({ id: ThreadId.make("thread-a") });
    const threadB = makeThread({ id: ThreadId.make("thread-b") });
    const localDispatch = createLocalDispatchSnapshot(threadA);

    expect(localDispatch.threadId).toBe(threadA.id);
    // Active on B: suppress A's busy state so multi-session switch stays clean.
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        latestUserMessageId: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        activeThreadId: threadB.id,
      }),
    ).toBe(true);
    // Still on A with no server progress: keep local Working.
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        latestUserMessageId: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        activeThreadId: threadA.id,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });

  it("acknowledges a turn projection created after the local dispatch started", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const turnAfterDispatch = {
      ...completedTurn,
      turnId: TurnId.make("turn-after-dispatch"),
      requestedAt: "2099-01-01T00:00:01.000Z",
      startedAt: null,
      completedAt: null,
      state: "running" as const,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: {
          ...localDispatch,
          startedAt: "2099-01-01T00:00:00.000Z",
        },
        phase: "ready",
        latestTurn: turnAfterDispatch,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("keeps local busy when only the user message projects while phase is still ready", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-after-send"),
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("keeps local busy across session start→ready without turn activity (Claude blank hole)", () => {
    // ensureSessionForThread sets starting, then startSession returns ready,
    // before turn.started. Clearing busy here left Working blank until first token.
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: null, session: readySession }),
    );
    const afterStartReady = {
      ...readySession,
      status: "ready" as const,
      updatedAt: "2099-01-01T00:00:05.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: {
          ...localDispatch,
          startedAt: "2099-01-01T00:00:00.000Z",
          sessionStatus: "starting",
          sessionUpdatedAt: "2099-01-01T00:00:01.000Z",
          latestTurnTurnId: null,
          latestTurnRequestedAt: null,
          latestTurnStartedAt: null,
          latestTurnCompletedAt: null,
        },
        phase: "ready",
        latestTurn: null,
        latestUserMessageId: MessageId.make("message-after-send"),
        session: afterStartReady,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        nowMs: Date.parse("2099-01-01T00:00:10.000Z"),
      }),
    ).toBe(false);
  });

  it("acknowledges session becoming starting even without a turn yet", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: null, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: {
          ...localDispatch,
          startedAt: "2099-01-01T00:00:00.000Z",
          sessionStatus: null,
          sessionUpdatedAt: null,
          latestTurnTurnId: null,
          latestTurnRequestedAt: null,
          latestTurnStartedAt: null,
          latestTurnCompletedAt: null,
        },
        phase: "connecting",
        latestTurn: null,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, status: "starting", updatedAt: "2099-01-01T00:00:01.000Z" },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a projected user message once the session is connecting or running", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "connecting",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-after-send"),
        session: { ...readySession, status: "starting" },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: completedTurn,
        latestUserMessageId: MessageId.make("message-after-send"),
        session: { ...readySession, status: "running", activeTurnId: completedTurn.turnId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a stale local dispatch after the safety timeout", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread({ session: readySession }));
    const startedAt = "2026-03-29T00:00:00.000Z";
    const startedMs = Date.parse(startedAt);
    // Freeze projection so only the wall-clock stale path can acknowledge.
    const frozen = {
      ...localDispatch,
      startedAt,
      latestTurnTurnId: null,
      latestTurnRequestedAt: null,
      latestTurnStartedAt: null,
      latestTurnCompletedAt: null,
      sessionStatus: readySession.status,
      sessionUpdatedAt: readySession.updatedAt,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: frozen,
        phase: "ready",
        latestTurn: null,
        latestUserMessageId: frozen.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        nowMs: startedMs + 44_000,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: frozen,
        phase: "ready",
        latestTurn: null,
        latestUserMessageId: frozen.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
        nowMs: startedMs + 45_000,
      }),
    ).toBe(true);
  });
});

describe("resolveThreadError", () => {
  it("prefers a local error over the server one", () => {
    expect(
      resolveThreadError({ local: { message: "local boom" }, serverError: "server boom" }),
    ).toBe("local boom");
  });

  it("falls back to the server error when there is no local one", () => {
    expect(resolveThreadError({ local: undefined, serverError: "server boom" })).toBe(
      "server boom",
    );
    expect(resolveThreadError({ local: { message: null }, serverError: "server boom" })).toBe(
      "server boom",
    );
  });

  it("hides a dismissed server error", () => {
    // The regression: clearing the local entry alone left `local ?? server`
    // resolving straight back to the server error, so the X did nothing.
    expect(
      resolveThreadError({
        local: { message: null, dismissedServerError: "server boom" },
        serverError: "server boom",
      }),
    ).toBeNull();
  });

  it("surfaces a different server error after a dismiss", () => {
    // Dismiss means "I have seen this one", not "stop reporting errors".
    expect(
      resolveThreadError({
        local: { message: null, dismissedServerError: "old boom" },
        serverError: "new boom",
      }),
    ).toBe("new boom");
  });

  it("returns null when there is nothing to show", () => {
    expect(resolveThreadError({ local: undefined, serverError: null })).toBeNull();
    expect(
      resolveThreadError({
        local: { message: null, dismissedServerError: "old boom" },
        serverError: null,
      }),
    ).toBeNull();
  });
});

describe("isThreadBusyForProviderSwitch", () => {
  const idle = { session: { status: "ready" } } as never;

  it("is not busy when the session is idle", () => {
    expect(
      isThreadBusyForProviderSwitch({
        thread: idle,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(false);
  });

  it("is busy while a turn is running or starting", () => {
    for (const status of ["running", "starting"]) {
      expect(
        isThreadBusyForProviderSwitch({
          thread: { session: { status } } as never,
          hasPendingApproval: false,
          hasPendingUserInput: false,
        }),
      ).toBe(true);
    }
  });

  it("is busy with an outstanding approval or user-input request", () => {
    // These belong to the session that raised them. Switching provider would
    // leave the user unable to answer.
    expect(
      isThreadBusyForProviderSwitch({
        thread: idle,
        hasPendingApproval: true,
        hasPendingUserInput: false,
      }),
    ).toBe(true);
    expect(
      isThreadBusyForProviderSwitch({
        thread: idle,
        hasPendingApproval: false,
        hasPendingUserInput: true,
      }),
    ).toBe(true);
  });

  it("is not busy without a thread", () => {
    expect(
      isThreadBusyForProviderSwitch({
        thread: null,
        hasPendingApproval: true,
        hasPendingUserInput: true,
      }),
    ).toBe(false);
  });
});

describe("deriveLockedProvider provider switching", () => {
  const startedThread = {
    session: { status: "ready", providerName: "claudeAgent" },
    messages: [{ role: "user", text: "hi" }],
    latestTurn: { turnId: "t1", state: "completed", completedAt: "2026-01-01T00:00:00.000Z" },
  } as never;

  it("leaves a settled started thread unlocked so the provider can change", () => {
    // SOU-480: a started thread used to pin its driver forever.
    expect(
      deriveLockedProvider({
        thread: startedThread,
        selectedProvider: null,
        threadProvider: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });

  it("locks to the session provider while a turn is in flight", () => {
    expect(
      deriveLockedProvider({
        thread: {
          session: { status: "running", providerName: "claudeAgent" },
          messages: [{ role: "user", text: "hi" }],
          latestTurn: { turnId: "t1", state: "running", completedAt: null },
        } as never,
        selectedProvider: null,
        threadProvider: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe("claudeAgent");
  });

  it("locks while an approval is outstanding", () => {
    expect(
      deriveLockedProvider({
        thread: startedThread,
        selectedProvider: null,
        threadProvider: null,
        hasPendingApproval: true,
        hasPendingUserInput: false,
      }),
    ).toBe("claudeAgent");
  });
});
