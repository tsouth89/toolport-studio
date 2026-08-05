import type { ProjectId, SidebarFolderId } from "./baseSchemas.ts";

/**
 * Resolve which sidebar shelf a thread belongs to.
 *
 * - `sidebarGroupId === null` → ungrouped (not under a workspace shelf)
 * - `sidebarGroupId` set → that shelf id (today usually a ProjectId string)
 * - field absent (legacy) → fall back to workspace `projectId` so old data keeps
 *   current shelves; a projectless thread has no shelf to fall back to
 */
export function resolveThreadSidebarPlacementProjectId(thread: {
  readonly projectId: ProjectId | string | null;
  // Include `undefined` so exactOptionalPropertyTypes accepts Schema.optional fields
  // and partial drag payloads (property present-with-undefined vs omitted).
  readonly sidebarGroupId?: SidebarFolderId | string | null | undefined;
}): string | null {
  if (thread.sidebarGroupId === undefined) {
    return thread.projectId === null ? null : String(thread.projectId);
  }
  if (thread.sidebarGroupId === null) {
    return null;
  }
  return String(thread.sidebarGroupId);
}
