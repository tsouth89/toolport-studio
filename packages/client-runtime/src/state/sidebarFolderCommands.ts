import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type CreateSidebarFolderInput,
  type DeleteSidebarFolderInput,
  type UpdateSidebarFolderInput,
  createSidebarFolder,
  deleteSidebarFolder,
  updateSidebarFolder,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateSidebarFolderInput,
  DeleteSidebarFolderInput,
  UpdateSidebarFolderInput,
} from "../operations/commands.ts";

/**
 * Commands for free-form sidebar folders. Folders are organization only —
 * nothing here touches a thread's workspace, cwd, or git state.
 */
export function createSidebarFolderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { sidebarFolderId: string };
    }) => JSON.stringify([environmentId, input.sidebarFolderId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:sidebar-folder:create",
      execute: (input: CreateSidebarFolderInput) => createSidebarFolder(input),
      scheduler,
      concurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:sidebar-folder:update",
      execute: (input: UpdateSidebarFolderInput) => updateSidebarFolder(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:sidebar-folder:delete",
      execute: (input: DeleteSidebarFolderInput) => deleteSidebarFolder(input),
      scheduler,
      concurrency,
    }),
  };
}
