import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_background_tasks (
      thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_type TEXT,
      description TEXT,
      command TEXT,
      status TEXT NOT NULL,
      backgrounded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, task_id),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  // The shell snapshot counts in-flight rows per thread on every read, so the
  // index leads with the columns that filter (thread + status).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_background_tasks_in_flight
    ON projection_thread_background_tasks(thread_id, status, backgrounded)
  `;
});
