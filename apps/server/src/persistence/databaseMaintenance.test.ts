import { describe, expect, it } from "vite-plus/test";

import {
  reclaimableBytes,
  shouldVacuum,
  VACUUM_RECLAIM_THRESHOLD_BYTES,
} from "./databaseMaintenance.ts";

describe("reclaimableBytes", () => {
  it("measures the freelist, not the file", () => {
    // The observed dogfood database: 590.5 MiB file, 429.3 MiB of it dead.
    expect(reclaimableBytes({ pageSize: 4096, pageCount: 151156, freelistCount: 109903 })).toBe(
      450_162_688,
    );
  });

  it("returns zero for a database with nothing to reclaim", () => {
    expect(reclaimableBytes({ pageSize: 4096, pageCount: 1000, freelistCount: 0 })).toBe(0);
  });

  it("returns zero rather than a negative when pragmas report nonsense", () => {
    // An in-memory or unreadable database reports 0 for these; never invent work.
    expect(reclaimableBytes({ pageSize: 0, pageCount: 0, freelistCount: 0 })).toBe(0);
    expect(reclaimableBytes({ pageSize: 4096, pageCount: 10, freelistCount: -5 })).toBe(0);
  });
});

describe("shouldVacuum", () => {
  it("triggers on a database with a large dead freelist", () => {
    expect(shouldVacuum({ pageSize: 4096, pageCount: 151156, freelistCount: 109903 })).toBe(true);
  });

  it("does not pay an exclusive lock for a small reclaim", () => {
    // 4 MiB free: real, but not worth blocking boot for.
    expect(shouldVacuum({ pageSize: 4096, pageCount: 100000, freelistCount: 1024 })).toBe(false);
  });

  it("does not re-trigger once a vacuum has already run", () => {
    // The point of the threshold: after vacuuming, the next boot must skip.
    expect(shouldVacuum({ pageSize: 4096, pageCount: 41000, freelistCount: 12 })).toBe(false);
  });

  it("skips a fresh empty database", () => {
    expect(shouldVacuum({ pageSize: 4096, pageCount: 2, freelistCount: 0 })).toBe(false);
  });

  it("honours an explicit threshold", () => {
    const stats = { pageSize: 4096, pageCount: 100000, freelistCount: 1024 };

    expect(shouldVacuum(stats, 1024 * 1024)).toBe(true);
    expect(shouldVacuum(stats, VACUUM_RECLAIM_THRESHOLD_BYTES)).toBe(false);
  });
});
