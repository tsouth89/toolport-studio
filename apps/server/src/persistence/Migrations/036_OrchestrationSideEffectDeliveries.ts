import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_side_effect_deliveries (
      consumer TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'failed', 'succeeded')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer, event_sequence),
      FOREIGN KEY (event_sequence) REFERENCES orchestration_events(sequence)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_side_effect_deliveries_ready
    ON orchestration_side_effect_deliveries(consumer, status, available_at_ms, event_sequence)
  `;
});
