import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Plan mode was removed from the active product in SBS-598. The column stays
 * temporarily for backward-compatible event/projection schemas, but persisted
 * plan values must not survive startup and re-enable legacy behavior.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET interaction_mode = 'default'
    WHERE interaction_mode <> 'default'
  `;
});
