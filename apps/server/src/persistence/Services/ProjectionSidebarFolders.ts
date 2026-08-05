/**
 * ProjectionSidebarFolderRepository - Projection repository interface for
 * free-form sidebar folders.
 *
 * Owns persistence operations for sidebar folder rows in the orchestration
 * projection read model. Folders are organization shelves only: they carry no
 * workspace, cwd, or git state.
 *
 * @module ProjectionSidebarFolderRepository
 */
import { IsoDateTime, SidebarFolderId, TrimmedNonEmptyString } from "@toolport-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSidebarFolder = Schema.Struct({
  sidebarFolderId: SidebarFolderId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionSidebarFolder = typeof ProjectionSidebarFolder.Type;

export const GetProjectionSidebarFolderInput = Schema.Struct({
  sidebarFolderId: SidebarFolderId,
});
export type GetProjectionSidebarFolderInput = typeof GetProjectionSidebarFolderInput.Type;

export const DeleteProjectionSidebarFolderInput = Schema.Struct({
  sidebarFolderId: SidebarFolderId,
});
export type DeleteProjectionSidebarFolderInput = typeof DeleteProjectionSidebarFolderInput.Type;

/**
 * ProjectionSidebarFolderRepositoryShape - Service API for projected sidebar
 * folder records.
 */
export interface ProjectionSidebarFolderRepositoryShape {
  /**
   * Insert or replace a projected sidebar folder row.
   *
   * Upserts by `sidebarFolderId`.
   */
  readonly upsert: (row: ProjectionSidebarFolder) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected sidebar folder row by id.
   */
  readonly getById: (
    input: GetProjectionSidebarFolderInput,
  ) => Effect.Effect<Option.Option<ProjectionSidebarFolder>, ProjectionRepositoryError>;

  /**
   * List all projected sidebar folder rows, including soft-deleted ones.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionSidebarFolder>,
    ProjectionRepositoryError
  >;

  /**
   * Hard-delete a projected sidebar folder row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionSidebarFolderInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionSidebarFolderRepository - Service tag for sidebar folder
 * projection persistence.
 */
export class ProjectionSidebarFolderRepository extends Context.Service<
  ProjectionSidebarFolderRepository,
  ProjectionSidebarFolderRepositoryShape
>()("t3/persistence/Services/ProjectionSidebarFolders/ProjectionSidebarFolderRepository") {}
