import { EnvironmentId, ProjectId, ThreadId } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPinnedSidebarShelfOrder,
  buildActiveSidebarShelfPanels,
  isThreadAlreadyOnSidebarShelf,
  resolveSidebarShelfDropGroupId,
  sidebarFolderShelfKey,
  UNGROUPED_SIDEBAR_SHELF_KEY,
} from "./Sidebar.logic";

const env = EnvironmentId.make("env-1");

const projectShelf = (projectKey: string, projectId: string, displayName = projectKey) => ({
  projectKey,
  displayName,
  isNoProject: false,
  memberProjectRefs: [{ environmentId: env, projectId: ProjectId.make(projectId) }],
});

const generalShelf = {
  projectKey: "general",
  displayName: "No project",
  isNoProject: true,
  memberProjectRefs: [{ environmentId: env, projectId: ProjectId.make("proj-general") }],
};

const findShelf = <T extends { readonly shelfKey: string }>(panels: readonly T[], key: string) =>
  panels.find((panel) => panel.shelfKey === key);

describe("buildActiveSidebarShelfPanels", () => {
  it("groups active threads under project shelves with preview and show-more", () => {
    const activeThreads = Array.from({ length: 7 }, (_, index) => ({
      id: ThreadId.make(`toolport-${index + 1}`),
      environmentId: env,
      projectId: ProjectId.make("proj-toolport"),
    }));

    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [],
      projectGroups: [projectShelf("toolport", "proj-toolport", "toolport-studio")],
      activeThreads,
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    expect(panels.map((panel) => panel.shelfKey)).toEqual([
      "toolport",
      UNGROUPED_SIDEBAR_SHELF_KEY,
    ]);
    expect(panels[0]?.kind).toBe("project");
    expect(panels[0]?.visibleThreads).toHaveLength(5);
    expect(panels[0]?.hasHiddenThreads).toBe(true);
    expect(panels[0]?.hiddenCount).toBe(2);
    expect(panels[0]?.isPinned).toBe(false);
  });

  it("emits folder shelves even when empty, and Ungrouped last", () => {
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [{ environmentId: env, id: "folder-1", title: "Research" }],
      projectGroups: [projectShelf("empty-shelf", "proj-empty", "Empty shelf")],
      activeThreads: [],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    const folderKey = sidebarFolderShelfKey({ environmentId: env, folderId: "folder-1" });
    expect(panels.map((panel) => panel.shelfKey)).toEqual([
      folderKey,
      "empty-shelf",
      UNGROUPED_SIDEBAR_SHELF_KEY,
    ]);
    expect(panels[0]?.kind).toBe("folder");
    expect(panels[0]?.displayName).toBe("Research");
    expect(panels[0]?.threads).toHaveLength(0);
    expect(panels.at(-1)?.kind).toBe("ungrouped");
  });

  it("files a thread under the folder its sidebarGroupId names", () => {
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [{ environmentId: env, id: "folder-1", title: "Research" }],
      projectGroups: [projectShelf("alpha", "proj-a")],
      activeThreads: [
        {
          id: ThreadId.make("in-folder"),
          environmentId: env,
          // Workspace stays on proj-a; only the shelf changes.
          projectId: ProjectId.make("proj-a"),
          sidebarGroupId: "folder-1",
        },
      ],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    const folderKey = sidebarFolderShelfKey({ environmentId: env, folderId: "folder-1" });
    expect(findShelf(panels, folderKey)?.threads.map((thread) => thread.id)).toEqual(["in-folder"]);
    expect(findShelf(panels, "alpha")?.threads).toHaveLength(0);
  });

  it("keeps a folder id scoped to its environment", () => {
    const otherEnv = EnvironmentId.make("env-2");
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [{ environmentId: env, id: "folder-1", title: "Research" }],
      projectGroups: [projectShelf("alpha", "proj-a")],
      activeThreads: [
        {
          id: ThreadId.make("other-env-thread"),
          environmentId: otherEnv,
          projectId: ProjectId.make("proj-a"),
          sidebarGroupId: "folder-1",
        },
      ],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    const folderKey = sidebarFolderShelfKey({ environmentId: env, folderId: "folder-1" });
    expect(findShelf(panels, folderKey)?.threads).toHaveLength(0);
    // Unknown-in-this-environment placement falls back to Ungrouped, never hidden.
    expect(
      findShelf(panels, UNGROUPED_SIDEBAR_SHELF_KEY)?.threads.map((thread) => thread.id),
    ).toEqual(["other-env-thread"]);
  });

  it("folds null placement, General members, and orphans into Ungrouped", () => {
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [],
      projectGroups: [projectShelf("alpha", "proj-a"), generalShelf],
      activeThreads: [
        {
          id: ThreadId.make("projectless-no-shelf"),
          environmentId: env,
          // projectId: null and no sidebarGroupId: the legacy placement
          // path falls back to projectId, which is null → Ungrouped.
          projectId: null,
        },
        {
          id: ThreadId.make("explicitly-ungrouped"),
          environmentId: env,
          projectId: ProjectId.make("proj-a"),
          sidebarGroupId: null,
        },
        {
          id: ThreadId.make("legacy-general"),
          environmentId: env,
          projectId: ProjectId.make("proj-general"),
          sidebarGroupId: "proj-general",
        },
        {
          id: ThreadId.make("orphaned-folder"),
          environmentId: env,
          projectId: ProjectId.make("proj-a"),
          sidebarGroupId: "folder-deleted-elsewhere",
        },
      ],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    // The General shelf is presentation of ungrouped work, not its own shelf.
    expect(panels.some((panel) => panel.shelfKey === "general")).toBe(false);
    expect(
      findShelf(panels, UNGROUPED_SIDEBAR_SHELF_KEY)?.threads.map((thread) => thread.id),
    ).toEqual([
      "projectless-no-shelf",
      "explicitly-ungrouped",
      "legacy-general",
      "orphaned-folder",
    ]);
  });

  it("buckets by sidebarGroupId independent of workspace projectId", () => {
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [],
      projectGroups: [projectShelf("alpha", "proj-a"), projectShelf("beta", "proj-b")],
      activeThreads: [
        {
          id: ThreadId.make("workspace-a-on-beta-shelf"),
          environmentId: env,
          projectId: ProjectId.make("proj-a"),
          sidebarGroupId: ProjectId.make("proj-b"),
        },
      ],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
    });

    expect(findShelf(panels, "beta")?.threads.map((thread) => thread.id)).toEqual([
      "workspace-a-on-beta-shelf",
    ]);
    expect(findShelf(panels, "alpha")?.threads).toHaveLength(0);
  });

  it("floats pinned shelves to the top but keeps Ungrouped last", () => {
    const panels = buildActiveSidebarShelfPanels({
      sidebarFolders: [{ environmentId: env, id: "folder-1", title: "Research" }],
      projectGroups: [projectShelf("alpha", "proj-a"), projectShelf("beta", "proj-b")],
      activeThreads: [],
      expandedShelfKeys: new Set(),
      previewLimit: 5,
      pinnedShelfKeys: ["beta"],
    });

    const folderKey = sidebarFolderShelfKey({ environmentId: env, folderId: "folder-1" });
    expect(panels.map((panel) => panel.shelfKey)).toEqual([
      "beta",
      folderKey,
      "alpha",
      UNGROUPED_SIDEBAR_SHELF_KEY,
    ]);
    expect(findShelf(panels, "beta")?.isPinned).toBe(true);
    expect(findShelf(panels, "alpha")?.isPinned).toBe(false);
  });

  it("applyPinnedSidebarShelfOrder preserves unpinned relative order", () => {
    const shelves = [{ shelfKey: "a" }, { shelfKey: "b" }, { shelfKey: "c" }];
    expect(applyPinnedSidebarShelfOrder(shelves, ["c"]).map((shelf) => shelf.shelfKey)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("resolveSidebarShelfDropGroupId", () => {
  const environmentId = "env-1";

  it("writes null for a drop on Ungrouped", () => {
    // The bug this replaces: dropping on "No project" wrote General's project
    // id, so the session read as ungrouped while still carrying a shelf id.
    expect(
      resolveSidebarShelfDropGroupId({
        panel: { kind: "ungrouped", folderRef: null },
        environmentId,
        sameEnvironmentProjectId: "proj-general",
      }),
    ).toEqual({ ok: true, sidebarGroupId: null });
  });

  it("writes the folder id for a drop on a folder", () => {
    expect(
      resolveSidebarShelfDropGroupId({
        panel: {
          kind: "folder",
          folderRef: { environmentId, folderId: "folder-1" },
        },
        environmentId,
        sameEnvironmentProjectId: null,
      }),
    ).toEqual({ ok: true, sidebarGroupId: "folder-1" });
  });

  it("rejects a cross-environment folder drop", () => {
    expect(
      resolveSidebarShelfDropGroupId({
        panel: {
          kind: "folder",
          folderRef: { environmentId: "env-2", folderId: "folder-1" },
        },
        environmentId,
        sameEnvironmentProjectId: null,
      }),
    ).toEqual({ ok: false });
  });

  it("writes the same-environment project id for a drop on a project shelf", () => {
    expect(
      resolveSidebarShelfDropGroupId({
        panel: { kind: "project", folderRef: null },
        environmentId,
        sameEnvironmentProjectId: "proj-a",
      }),
    ).toEqual({ ok: true, sidebarGroupId: "proj-a" });
    expect(
      resolveSidebarShelfDropGroupId({
        panel: { kind: "project", folderRef: null },
        environmentId,
        sameEnvironmentProjectId: null,
      }),
    ).toEqual({ ok: false });
  });

  it("treats a no-op move as already on the shelf", () => {
    expect(
      isThreadAlreadyOnSidebarShelf({
        placementProjectId: null,
        targetSidebarGroupId: null,
      }),
    ).toBe(true);
    expect(
      isThreadAlreadyOnSidebarShelf({
        placementProjectId: "folder-1",
        targetSidebarGroupId: "folder-1",
      }),
    ).toBe(true);
    expect(
      isThreadAlreadyOnSidebarShelf({
        placementProjectId: "folder-1",
        targetSidebarGroupId: null,
      }),
    ).toBe(false);
  });
});
