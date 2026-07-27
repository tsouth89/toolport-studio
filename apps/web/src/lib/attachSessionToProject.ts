import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { type DraftId, type DraftThreadState, useComposerDraftStore } from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";

export type AttachSessionProjectTarget = {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
};

export type AttachSessionProjectMember = AttachSessionProjectTarget & {
  readonly workspaceRoot?: string;
  readonly repositoryIdentity?: unknown;
};

/**
 * Rebind a pre-thread draft to a project shelf without minting a new draft.
 * Composer prompt / images / contexts stay keyed by the same draftId.
 */
export function attachDraftSessionToProject(input: {
  readonly draftId: DraftId;
  readonly draftThread: DraftThreadState;
  readonly project: AttachSessionProjectTarget;
  readonly projects: ReadonlyArray<AttachSessionProjectMember>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
}): void {
  const targetProjectRef = scopeProjectRef(input.project.environmentId, input.project.id);
  const targetProject = input.projects.find(
    (candidate) =>
      candidate.environmentId === input.project.environmentId && candidate.id === input.project.id,
  );
  const logicalProjectKey = targetProject
    ? deriveLogicalProjectKeyFromSettings(
        {
          environmentId: targetProject.environmentId,
          id: targetProject.id,
          workspaceRoot: targetProject.workspaceRoot ?? "",
          repositoryIdentity: targetProject.repositoryIdentity as never,
        },
        input.projectGroupingSettings,
      )
    : scopedProjectKey(targetProjectRef);

  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(logicalProjectKey, targetProjectRef, input.draftId, {
      threadId: input.draftThread.threadId,
      createdAt: input.draftThread.createdAt,
      runtimeMode: input.draftThread.runtimeMode,
      interactionMode: input.draftThread.interactionMode,
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
}

export type AttachSessionToProjectResult =
  | { readonly ok: true; readonly mode: "draft" | "server" }
  | {
      readonly ok: false;
      readonly title: string;
      readonly description: string;
    };

/**
 * Move the currently open session onto a project, keeping composer content.
 * - Draft routes rebind the same draftId (prompt/attachments travel).
 * - Server threads update metadata in place (same thread key, same draft map).
 */
export async function attachSessionToProject(input: {
  readonly project: AttachSessionProjectTarget;
  readonly activeThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  } | null;
  readonly activeDraftId: DraftId | null;
  readonly activeDraftThread: DraftThreadState | null;
  readonly projects: ReadonlyArray<AttachSessionProjectMember>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  /** Server-only: update thread projectId. Return false to treat as soft cancel. */
  readonly updateServerThreadProject?: (args: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly interrupted?: boolean; readonly message?: string }
  >;
}): Promise<AttachSessionToProjectResult> {
  if (input.activeThread) {
    if (input.activeThread.environmentId !== input.project.environmentId) {
      return {
        ok: false,
        title: "Couldn’t attach folder",
        description: "A conversation can only move within its current environment.",
      };
    }
    if (!input.updateServerThreadProject) {
      return {
        ok: false,
        title: "Couldn’t attach folder",
        description: "No active conversation to attach.",
      };
    }
    const updateResult = await input.updateServerThreadProject({
      environmentId: input.activeThread.environmentId,
      threadId: input.activeThread.id,
      projectId: input.project.id,
    });
    if (!updateResult.ok) {
      if (updateResult.interrupted) {
        return {
          ok: false,
          title: "Couldn’t attach folder",
          description: "Attachment was interrupted.",
        };
      }
      return {
        ok: false,
        title: "Couldn’t attach folder",
        description: updateResult.message ?? "An error occurred.",
      };
    }
    return { ok: true, mode: "server" };
  }

  if (input.activeDraftId && input.activeDraftThread) {
    attachDraftSessionToProject({
      draftId: input.activeDraftId,
      draftThread: input.activeDraftThread,
      project: input.project,
      projects: input.projects,
      projectGroupingSettings: input.projectGroupingSettings,
    });
    return { ok: true, mode: "draft" };
  }

  return {
    ok: false,
    title: "Couldn’t attach folder",
    description: "No active conversation to attach.",
  };
}

export function resolveAttachProjectRef(project: AttachSessionProjectTarget): ScopedProjectRef {
  return scopeProjectRef(project.environmentId, project.id);
}
