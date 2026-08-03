import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SidebarFolderId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSidebarFolder,
  type OrchestrationThread,
} from "@toolport-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FOLDER_ID = SidebarFolderId.make("folder-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeFolder(
  overrides: Partial<OrchestrationSidebarFolder> = {},
): OrchestrationSidebarFolder {
  return {
    id: FOLDER_ID,
    title: "Research",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeThread(
  id: string,
  sidebarGroupId: OrchestrationThread["sidebarGroupId"],
): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    sidebarGroupId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
  };
}

function makeReadModel(input: {
  readonly sidebarFolders?: ReadonlyArray<OrchestrationSidebarFolder>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
}): OrchestrationReadModel {
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
    sidebarFolders: input.sidebarFolders ?? [],
    threads: input.threads ?? [],
    updatedAt: NOW,
  };
}

function makeSidebarFolderEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "sidebar-folder",
    aggregateId: FOLDER_ID,
    occurredAt: input.occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.layer(NodeServices.layer)("sidebar folder decider", (it) => {
  it.effect("creates a folder", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.create",
          commandId: CommandId.make("cmd-create"),
          sidebarFolderId: FOLDER_ID,
          title: "Research",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("sidebar-folder.created");
      expect(events[0]?.aggregateKind).toBe("sidebar-folder");
      if (events[0]?.type === "sidebar-folder.created") {
        expect(events[0].payload.sidebarFolderId).toBe(FOLDER_ID);
        expect(events[0].payload.title).toBe("Research");
        expect(events[0].payload.createdAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects creating the same folder twice", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.create",
          commandId: CommandId.make("cmd-create-again"),
          sidebarFolderId: FOLDER_ID,
          title: "Research",
          createdAt: NOW,
        },
        readModel: makeReadModel({ sidebarFolders: [makeFolder()] }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("renames a folder", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.meta.update",
          commandId: CommandId.make("cmd-rename"),
          sidebarFolderId: FOLDER_ID,
          title: "Deep work",
        },
        readModel: makeReadModel({ sidebarFolders: [makeFolder()] }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("sidebar-folder.meta-updated");
      if (events[0]?.type === "sidebar-folder.meta-updated") {
        expect(events[0].payload.title).toBe("Deep work");
      }
    }),
  );

  it.effect("rejects renaming an unknown folder", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.meta.update",
          commandId: CommandId.make("cmd-rename-missing"),
          sidebarFolderId: FOLDER_ID,
          title: "Deep work",
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("deletes an empty folder", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.delete",
          commandId: CommandId.make("cmd-delete"),
          sidebarFolderId: FOLDER_ID,
        },
        readModel: makeReadModel({ sidebarFolders: [makeFolder()] }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("sidebar-folder.deleted");
    }),
  );

  // Decision 5: deleting a shelf ungroups its members, never deletes threads.
  it.effect("delete ungroups member threads without touching their workspace", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.delete",
          commandId: CommandId.make("cmd-delete-with-members"),
          sidebarFolderId: FOLDER_ID,
        },
        readModel: makeReadModel({
          sidebarFolders: [makeFolder()],
          threads: [
            makeThread("thread-in-folder", FOLDER_ID),
            makeThread("thread-elsewhere", SidebarFolderId.make("folder-2")),
            makeThread("thread-ungrouped", null),
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.meta-updated",
        "sidebar-folder.deleted",
      ]);
      const metaUpdated = events[0];
      if (metaUpdated?.type === "thread.meta-updated") {
        expect(metaUpdated.payload.threadId).toBe(ThreadId.make("thread-in-folder"));
        expect(metaUpdated.payload.sidebarGroupId).toBe(null);
        // Workspace attachment is a separate key and must be left alone.
        expect(metaUpdated.payload.projectId).toBeUndefined();
      }
      expect(events.some((event) => event.type === "thread.deleted")).toBe(false);
    }),
  );

  it.effect("delete ungroups archived members too", () =>
    Effect.gen(function* () {
      const archived = {
        ...makeThread("thread-archived", FOLDER_ID),
        archivedAt: NOW,
      };
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.delete",
          commandId: CommandId.make("cmd-delete-archived"),
          sidebarFolderId: FOLDER_ID,
        },
        readModel: makeReadModel({
          sidebarFolders: [makeFolder()],
          threads: [archived],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.meta-updated",
        "sidebar-folder.deleted",
      ]);
    }),
  );

  it.effect("rejects deleting an already deleted folder", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "sidebar-folder.delete",
          commandId: CommandId.make("cmd-delete-twice"),
          sidebarFolderId: FOLDER_ID,
        },
        readModel: makeReadModel({ sidebarFolders: [makeFolder({ deletedAt: NOW })] }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

it.layer(NodeServices.layer)("sidebar folder projector", (it) => {
  it.effect("projects create, rename, and soft delete onto the read model", () =>
    Effect.gen(function* () {
      const created = yield* projectEvent(
        makeReadModel({}),
        makeSidebarFolderEvent({
          sequence: 1,
          type: "sidebar-folder.created",
          occurredAt: NOW,
          payload: {
            sidebarFolderId: FOLDER_ID,
            title: "Research",
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      );
      expect(created.sidebarFolders).toHaveLength(1);
      expect(created.sidebarFolders[0]?.title).toBe("Research");
      expect(created.sidebarFolders[0]?.deletedAt).toBe(null);

      const renamed = yield* projectEvent(
        created,
        makeSidebarFolderEvent({
          sequence: 2,
          type: "sidebar-folder.meta-updated",
          occurredAt: "2026-01-02T00:00:00.000Z",
          payload: {
            sidebarFolderId: FOLDER_ID,
            title: "Deep work",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      );
      expect(renamed.sidebarFolders[0]?.title).toBe("Deep work");
      expect(renamed.sidebarFolders[0]?.createdAt).toBe(NOW);

      const deleted = yield* projectEvent(
        renamed,
        makeSidebarFolderEvent({
          sequence: 3,
          type: "sidebar-folder.deleted",
          occurredAt: "2026-01-03T00:00:00.000Z",
          payload: {
            sidebarFolderId: FOLDER_ID,
            deletedAt: "2026-01-03T00:00:00.000Z",
          },
        }),
      );
      // Soft delete: the row stays so replays keep a stable history.
      expect(deleted.sidebarFolders).toHaveLength(1);
      expect(deleted.sidebarFolders[0]?.deletedAt).toBe("2026-01-03T00:00:00.000Z");
    }),
  );
});
