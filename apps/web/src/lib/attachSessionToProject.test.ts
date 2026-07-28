import { scopeProjectRef, scopedProjectKey } from "@toolport-studio/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@toolport-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { attachDraftSessionToProject, attachSessionToProject } from "./attachSessionToProject";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { newDraftId } from "./utils";

const ENVIRONMENT_ID = EnvironmentId.make("env-attach");
const GENERAL_PROJECT_ID = ProjectId.make("proj-general");
const TARGET_PROJECT_ID = ProjectId.make("proj-target");
const OTHER_ENV = EnvironmentId.make("env-other");

function resetStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("attachDraftSessionToProject", () => {
  beforeEach(() => {
    resetStore();
  });

  it("rebinds the same draftId so composer prompt travels with the folder", () => {
    const draftId = DraftId.make(newDraftId());
    const threadId = ThreadId.make("thread-attach-1");
    const generalRef = scopeProjectRef(ENVIRONMENT_ID, GENERAL_PROJECT_ID);
    const targetRef = scopeProjectRef(ENVIRONMENT_ID, TARGET_PROJECT_ID);
    const store = useComposerDraftStore.getState();

    store.setLogicalProjectDraftThreadId(scopedProjectKey(generalRef), generalRef, draftId, {
      threadId,
      createdAt: "2026-07-27T12:00:00.000Z",
    });
    store.setPrompt(draftId, "keep this brainstorm before attach");

    attachDraftSessionToProject({
      draftId,
      draftThread: store.getDraftSession(draftId)!,
      project: { environmentId: ENVIRONMENT_ID, id: TARGET_PROJECT_ID },
      projects: [
        {
          environmentId: ENVIRONMENT_ID,
          id: GENERAL_PROJECT_ID,
          workspaceRoot: "",
        },
        {
          environmentId: ENVIRONMENT_ID,
          id: TARGET_PROJECT_ID,
          workspaceRoot: "C:/projects/toolport",
        },
      ],
      projectGroupingSettings: {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      },
    });

    const next = useComposerDraftStore.getState();
    expect(next.getComposerDraft(draftId)?.prompt).toBe("keep this brainstorm before attach");
    expect(next.getDraftSession(draftId)).toMatchObject({
      projectId: TARGET_PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      threadId,
    });
    expect(next.getDraftThreadByProjectRef(generalRef)).toBeNull();
    expect(next.getDraftThreadByProjectRef(targetRef)?.draftId).toBe(draftId);
  });
});

describe("attachSessionToProject", () => {
  beforeEach(() => {
    resetStore();
  });

  it("updates server thread metadata in place", async () => {
    const updateServerThreadProject = vi.fn(async () => ({ ok: true as const }));
    const result = await attachSessionToProject({
      project: { environmentId: ENVIRONMENT_ID, id: TARGET_PROJECT_ID },
      activeThread: { environmentId: ENVIRONMENT_ID, id: ThreadId.make("server-1") },
      activeDraftId: null,
      activeDraftThread: null,
      projects: [],
      projectGroupingSettings: {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      },
      updateServerThreadProject,
    });
    expect(result).toEqual({ ok: true, mode: "server" });
    expect(updateServerThreadProject).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      threadId: ThreadId.make("server-1"),
      projectId: TARGET_PROJECT_ID,
    });
  });

  it("rejects cross-environment server moves", async () => {
    const result = await attachSessionToProject({
      project: { environmentId: OTHER_ENV, id: TARGET_PROJECT_ID },
      activeThread: { environmentId: ENVIRONMENT_ID, id: ThreadId.make("server-1") },
      activeDraftId: null,
      activeDraftThread: null,
      projects: [],
      projectGroupingSettings: {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      },
      updateServerThreadProject: async () => ({ ok: true as const }),
    });
    expect(result.ok).toBe(false);
  });
});
