import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionSidebarFolderInput,
  GetProjectionSidebarFolderInput,
  ProjectionSidebarFolder,
  ProjectionSidebarFolderRepository,
  type ProjectionSidebarFolderRepositoryShape,
} from "../Services/ProjectionSidebarFolders.ts";

const makeProjectionSidebarFolderRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionSidebarFolderRow = SqlSchema.void({
    Request: ProjectionSidebarFolder,
    execute: (row) =>
      sql`
        INSERT INTO projection_sidebar_folders (
          sidebar_folder_id,
          title,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.sidebarFolderId},
          ${row.title},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (sidebar_folder_id)
        DO UPDATE SET
          title = excluded.title,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionSidebarFolderRow = SqlSchema.findOneOption({
    Request: GetProjectionSidebarFolderInput,
    Result: ProjectionSidebarFolder,
    execute: ({ sidebarFolderId }) =>
      sql`
        SELECT
          sidebar_folder_id AS "sidebarFolderId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_sidebar_folders
        WHERE sidebar_folder_id = ${sidebarFolderId}
      `,
  });

  const listProjectionSidebarFolderRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSidebarFolder,
    execute: () =>
      sql`
        SELECT
          sidebar_folder_id AS "sidebarFolderId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_sidebar_folders
        ORDER BY created_at ASC, sidebar_folder_id ASC
      `,
  });

  const deleteProjectionSidebarFolderRow = SqlSchema.void({
    Request: DeleteProjectionSidebarFolderInput,
    execute: ({ sidebarFolderId }) =>
      sql`
        DELETE FROM projection_sidebar_folders
        WHERE sidebar_folder_id = ${sidebarFolderId}
      `,
  });

  const upsert: ProjectionSidebarFolderRepositoryShape["upsert"] = (row) =>
    upsertProjectionSidebarFolderRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarFolderRepository.upsert:query")),
    );

  const getById: ProjectionSidebarFolderRepositoryShape["getById"] = (input) =>
    getProjectionSidebarFolderRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarFolderRepository.getById:query")),
    );

  const listAll: ProjectionSidebarFolderRepositoryShape["listAll"] = () =>
    listProjectionSidebarFolderRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarFolderRepository.listAll:query")),
    );

  const deleteById: ProjectionSidebarFolderRepositoryShape["deleteById"] = (input) =>
    deleteProjectionSidebarFolderRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarFolderRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionSidebarFolderRepositoryShape;
});

export const ProjectionSidebarFolderRepositoryLive = Layer.effect(
  ProjectionSidebarFolderRepository,
  makeProjectionSidebarFolderRepository,
);
