import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Null workspace: a thread may have no project at all (projectless chat), so
 * `projection_threads.project_id` drops its NOT NULL. SQLite cannot relax a
 * column constraint in place, so this rebuilds the table.
 *
 * Two hazards this works around:
 *
 * - The column set has accumulated across ~10 migrations, so the new table's
 *   DDL is derived from `PRAGMA table_info` rather than hardcoded. Getting that
 *   list wrong by hand would silently drop a column's data.
 * - `projection_thread_queued_turns` has an `ON DELETE CASCADE` foreign key to
 *   this table, and migrations run inside a transaction where `PRAGMA
 *   foreign_keys` cannot be toggled. `DROP TABLE` therefore fires the cascade
 *   and would delete pending user turns, so they are copied aside and restored
 *   after the rename re-points the foreign key.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
  }>`PRAGMA table_info(projection_threads)`;

  if (columns.length === 0) {
    return;
  }
  const projectIdColumn = columns.find((column) => column.name === "project_id");
  if (projectIdColumn === undefined || projectIdColumn.notnull === 0) {
    // Already nullable (or gone): nothing to rebuild.
    return;
  }

  // Preserve every index exactly as declared; implicit indexes carry no SQL.
  const indexes = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'projection_threads' AND sql IS NOT NULL
  `;

  const columnDdl = columns
    .map((column) => {
      const parts = [`"${column.name}"`, column.type.length > 0 ? column.type : "TEXT"];
      if (column.pk > 0) {
        parts.push("PRIMARY KEY");
      }
      // The whole point of the rebuild: project_id keeps its type but loses NOT NULL.
      if (column.notnull === 1 && column.name !== "project_id") {
        parts.push("NOT NULL");
      }
      if (column.dflt_value !== null) {
        parts.push(`DEFAULT ${column.dflt_value}`);
      }
      return parts.join(" ");
    })
    .join(",\n      ");
  const columnList = columns.map((column) => `"${column.name}"`).join(", ");

  yield* sql.unsafe(`
    CREATE TABLE projection_threads_rebuild (
      ${columnDdl}
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO projection_threads_rebuild (${columnList})
    SELECT ${columnList} FROM projection_threads
  `);

  yield* sql`
    CREATE TEMPORARY TABLE projection_thread_queued_turns_backup AS
    SELECT * FROM projection_thread_queued_turns
  `;

  yield* sql`DROP TABLE projection_threads`;
  yield* sql`ALTER TABLE projection_threads_rebuild RENAME TO projection_threads`;

  yield* sql`
    INSERT INTO projection_thread_queued_turns
    SELECT * FROM projection_thread_queued_turns_backup
  `;
  yield* sql`DROP TABLE projection_thread_queued_turns_backup`;

  for (const index of indexes) {
    if (index.sql === null) continue;
    yield* sql.unsafe(index.sql);
  }
});
