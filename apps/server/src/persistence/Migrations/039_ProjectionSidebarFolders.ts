import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Free-form sidebar folders: organization shelves with no workspace, cwd, or
 * git state. Threads point at one through `projection_threads.sidebar_group_id`
 * (added in 038); no foreign key, because that column also still holds project
 * ids for legacy shelves.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_sidebar_folders (
      sidebar_folder_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_sidebar_folders_active
    ON projection_sidebar_folders (deleted_at, created_at, sidebar_folder_id)
  `;
});
