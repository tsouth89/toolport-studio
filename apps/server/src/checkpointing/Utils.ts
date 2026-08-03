import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@toolport-studio/contracts";

import { projectlessWorkspaceRoot } from "../workspace/projectlessWorkspace.ts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * The directory a thread's turns run in: its worktree, else its workspace root,
 * else — for a projectless thread — the shared projectless scratch directory.
 *
 * Returns undefined only when a thread names a project the projection has no
 * row for, which is a genuine inconsistency rather than a projectless session.
 */
export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId | null;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  if (input.thread.projectId === null) {
    return projectlessWorkspaceRoot();
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
