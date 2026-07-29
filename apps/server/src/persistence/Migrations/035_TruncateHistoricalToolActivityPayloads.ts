import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { sanitizeStoredActivityPayload } from "../../orchestration/toolActivitySanitize.ts";

/**
 * Backfill for activity rows written before the ingestion-time truncation
 * landed (18ae8db5, 2026-07-26). Those rows carry full ACP `rawOutput` /
 * `content` blobs — measured at 18.6 KiB/row against 1.4 KiB/row after the fix,
 * with single rows up to 421 KiB and one thread totalling 25.8 MiB.
 *
 * That whole payload is shipped on every thread open, because the snapshot
 * query selects `payload_json` with no LIMIT, so the cost is paid on every
 * switch into an old thread rather than once.
 *
 * Applies the exact ingestion rules via the shared sanitizer, so the two can
 * never drift. Rewrites are shrink-only: `sanitizeStoredActivityPayload`
 * returns null for anything unparseable, non-object, missing a `data` bag, or
 * that failed to get smaller, and those rows are left byte-for-byte alone.
 *
 * NOTE: this frees pages into the SQLite freelist, it does not shrink the file.
 * Reclaiming that space needs a VACUUM (SOU-466), which cannot run inside a
 * migration transaction and is deliberately not attempted here.
 */

/** Rows at or below this are already within the ingestion caps; skip them. */
const MIN_PAYLOAD_BYTES = 4096;
/** Bounded so a large history never loads as one array. */
const BATCH_ROWS = 200;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  let lastActivityId = "";
  let scanned = 0;
  let rewritten = 0;
  let bytesSaved = 0;

  for (;;) {
    const rows = yield* sql<{
      readonly activity_id: string;
      readonly payload_json: string;
    }>`
      SELECT activity_id, payload_json
      FROM projection_thread_activities
      WHERE activity_id > ${lastActivityId}
        AND payload_json IS NOT NULL
        AND LENGTH(payload_json) > ${MIN_PAYLOAD_BYTES}
      ORDER BY activity_id ASC
      LIMIT ${BATCH_ROWS}
    `;

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      scanned += 1;
      const next = sanitizeStoredActivityPayload(row.payload_json);
      if (next === null) {
        continue;
      }
      yield* sql`
        UPDATE projection_thread_activities
        SET payload_json = ${next}
        WHERE activity_id = ${row.activity_id}
      `;
      rewritten += 1;
      bytesSaved += row.payload_json.length - next.length;
    }

    const last = rows[rows.length - 1];
    if (last === undefined) {
      break;
    }
    lastActivityId = last.activity_id;
  }

  yield* Effect.logInfo("Truncated historical tool activity payloads", {
    scanned,
    rewritten,
    approxBytesSaved: bytesSaved,
  });
});
