import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationSidebarFolderShell,
} from "@toolport-studio/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentSidebarFolder } from "./models.ts";
import { scopeSidebarFolder } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { arrayElementsEqual } from "./entities.ts";

const EMPTY_SIDEBAR_FOLDERS: ReadonlyArray<OrchestrationSidebarFolderShell> = Object.freeze([]);

function sidebarFoldersEqual(
  left: ReadonlyArray<EnvironmentSidebarFolder>,
  right: ReadonlyArray<EnvironmentSidebarFolder>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (folder, index) =>
        folder.environmentId === right[index]?.environmentId &&
        folder.id === right[index]?.id &&
        folder.title === right[index]?.title &&
        folder.updatedAt === right[index]?.updatedAt,
    )
  );
}

/**
 * Free-form sidebar folders across every connected environment. Folders are
 * organization only — they hold no workspace, so unlike projects they are never
 * merged across environments by cwd; a folder belongs to the environment that
 * stores it.
 */
export function createEnvironmentSidebarFolderAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentSidebarFoldersAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<EnvironmentSidebarFolder> = [];
    return Atom.make((get): ReadonlyArray<EnvironmentSidebarFolder> => {
      const source =
        get(input.snapshotAtom(environmentId))?.sidebarFolders ?? EMPTY_SIDEBAR_FOLDERS;
      const next = source.map((folder) => scopeSidebarFolder(environmentId, folder));
      if (sidebarFoldersEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-sidebar-folders:${environmentId}`));
  });

  let previousSidebarFolders: ReadonlyArray<EnvironmentSidebarFolder> = [];
  const sidebarFoldersAtom = Atom.make((get) => {
    const next: EnvironmentSidebarFolder[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      next.push(...get(environmentSidebarFoldersAtom(environmentId)));
    }
    if (arrayElementsEqual(previousSidebarFolders, next)) {
      return previousSidebarFolders;
    }
    previousSidebarFolders = next;
    return previousSidebarFolders;
  }).pipe(Atom.withLabel("environment-sidebar-folder-list"));

  return {
    environmentSidebarFoldersAtom,
    sidebarFoldersAtom,
  };
}
