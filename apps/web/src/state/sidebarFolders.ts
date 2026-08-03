import {
  createEnvironmentSidebarFolderAtoms,
  createSidebarFolderEnvironmentAtoms,
} from "@toolport-studio/client-runtime/state/sidebar-folders";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const sidebarFolderEnvironment = createSidebarFolderEnvironmentAtoms(connectionAtomRuntime);
export const environmentSidebarFolders = createEnvironmentSidebarFolderAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
