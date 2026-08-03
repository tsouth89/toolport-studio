import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Dual-key model: workspace (`project_id`) vs sidebar shelf (`sidebar_group_id`).
 * Backfill copies project_id so existing sessions keep their current shelves.
 * New threads may set sidebar_group_id to NULL (ungrouped).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "sidebar_group_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidebar_group_id TEXT
    `;
  }

  // Legacy rows: shelf membership matched workspace project.
  yield* sql`
    UPDATE projection_threads
    SET sidebar_group_id = project_id
    WHERE sidebar_group_id IS NULL
      AND project_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_sidebar_group_id
    ON projection_threads (sidebar_group_id)
  `;
});
