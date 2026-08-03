import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@toolport-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { projectlessWorkspaceRoot } from "../workspace/projectlessWorkspace.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: PROJECT_ID,
    sidebarGroupId: null,
    title: "Thread",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread> = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    sidebarFolders: [],
    threads,
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("projectless thread decider", (it) => {
  it.effect("creates a thread with no workspace attached", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-projectless"),
          threadId: ThreadId.make("thread-projectless"),
          projectId: null,
          title: "Quick question",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.projectId).toBe(null);
        // Projectless and ungrouped are independent, but a new session is both.
        expect(events[0].payload.sidebarGroupId).toBe(null);
      }
    }),
  );

  it.effect("still rejects a workspace that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-missing-project"),
          threadId: ThreadId.make("thread-missing"),
          projectId: ProjectId.make("project-missing"),
          title: "Thread",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("detaches a workspace without touching shelf membership", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-detach"),
          threadId: ThreadId.make("thread-1"),
          projectId: null,
        },
        readModel: makeReadModel([makeThread()]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.projectId).toBe(null);
        expect(events[0].payload.sidebarGroupId).toBeUndefined();
      }
    }),
  );

  it.effect("refuses to detach while the provider session is running", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-detach-running"),
          threadId: ThreadId.make("thread-1"),
          projectId: null,
        },
        readModel: makeReadModel([
          makeThread({
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "Codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ]),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

it("runs a projectless thread in the projectless scratch directory", () => {
  expect(
    resolveThreadWorkspaceCwd({
      thread: { projectId: null, worktreePath: null },
      projects: [],
    }),
  ).toBe(projectlessWorkspaceRoot());
});

it("prefers a worktree over the projectless scratch directory", () => {
  expect(
    resolveThreadWorkspaceCwd({
      thread: { projectId: null, worktreePath: "/tmp/worktree" },
      projects: [],
    }),
  ).toBe("/tmp/worktree");
});

it("reports no cwd when a thread names a workspace the projection lost", () => {
  expect(
    resolveThreadWorkspaceCwd({
      thread: { projectId: PROJECT_ID, worktreePath: null },
      projects: [],
    }),
  ).toBeUndefined();
});
