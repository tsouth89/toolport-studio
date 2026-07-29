import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * SQLite never returns freed pages to the filesystem on its own. A measured
 * dogfood database sat at 590.5 MiB with 429.3 MiB of freelist — 72.7% of the
 * file was dead pages, and the sparse layout costs page-cache locality on every
 * read, not just disk.
 *
 * VACUUM is the only way to reclaim that, and it takes an exclusive lock for
 * the duration. That makes *when* it runs the real design question:
 *
 * - Deferred to a background task, it locks the database while the user is
 *   working, which is the worst possible moment.
 * - Here, immediately after migrations and before the server begins serving,
 *   nothing else holds the connection. The cost lands once, on a boot that is
 *   already waiting for the database to be ready.
 *
 * Guarded by a threshold so it is not paid on every launch: once a vacuum
 * runs, the freelist drops far below the trigger and stays there until real
 * churn accumulates again. That makes this self-maintaining rather than a
 * one-shot migration — it runs again if and only if it is worth running.
 */

/** Below this, the reclaim is not worth an exclusive lock on boot. */
export const VACUUM_RECLAIM_THRESHOLD_BYTES = 64 * 1024 * 1024;

export interface DatabaseSpaceStats {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
}

export function reclaimableBytes(stats: DatabaseSpaceStats): number {
  if (stats.pageSize <= 0 || stats.freelistCount <= 0) {
    return 0;
  }
  return stats.pageSize * stats.freelistCount;
}

export function shouldVacuum(
  stats: DatabaseSpaceStats,
  thresholdBytes: number = VACUUM_RECLAIM_THRESHOLD_BYTES,
): boolean {
  return reclaimableBytes(stats) >= thresholdBytes;
}

const readPragmaNumber = Effect.fn("persistence.maintenance.readPragma")(function* (
  pragma: "page_size" | "page_count" | "freelist_count",
) {
  const sql = yield* SqlClient.SqlClient;
  // PRAGMA names cannot be bound as parameters, and this value is a closed
  // union rather than anything caller-supplied.
  const rows = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const first = rows[0];
  if (first === undefined) {
    return 0;
  }
  const value = Object.values(first)[0];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
});

export const readDatabaseSpaceStats = Effect.fn("persistence.maintenance.readSpaceStats")(
  function* () {
    const [pageSize, pageCount, freelistCount] = yield* Effect.all(
      [
        readPragmaNumber("page_size"),
        readPragmaNumber("page_count"),
        readPragmaNumber("freelist_count"),
      ],
      { concurrency: 1 },
    );
    return { pageSize, pageCount, freelistCount } satisfies DatabaseSpaceStats;
  },
);

/**
 * Reclaim freelist pages when enough have accumulated to justify the lock.
 *
 * Never fails the caller: a database that cannot be vacuumed (in use, no free
 * disk, read-only volume) must not stop the server from booting. A failure
 * leaves the file exactly as it was, so the only cost is the wasted space it
 * already had.
 */
export const vacuumIfWorthwhile = Effect.fn("persistence.maintenance.vacuumIfWorthwhile")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* readDatabaseSpaceStats();

    if (!shouldVacuum(before)) {
      return { vacuumed: false, reclaimedBytes: 0 } as const;
    }

    yield* Effect.logInfo("Reclaiming SQLite freelist pages", {
      fileBytes: before.pageSize * before.pageCount,
      reclaimableBytes: reclaimableBytes(before),
    });

    // Must not run inside a transaction; this sits after runMigrations for
    // that reason as well as for the lock window.
    yield* sql.unsafe("VACUUM");

    const after = yield* readDatabaseSpaceStats();
    const reclaimed = before.pageSize * before.pageCount - after.pageSize * after.pageCount;

    yield* Effect.logInfo("Reclaimed SQLite freelist pages", {
      fileBytes: after.pageSize * after.pageCount,
      reclaimedBytes: reclaimed,
    });

    return { vacuumed: true, reclaimedBytes: reclaimed } as const;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("SQLite vacuum skipped", { cause }).pipe(
      Effect.as({ vacuumed: false, reclaimedBytes: 0 } as const),
    ),
  ),
);
