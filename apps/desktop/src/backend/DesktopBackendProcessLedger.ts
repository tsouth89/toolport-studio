// On-disk record of the backend processes this desktop app has spawned, so a
// run that dies without finalizers can be cleaned up by the next one.
//
// Every teardown path in DesktopBackendManager relies on Effect finalizers
// running: they close the run scope, and the spawner terminates the backend and
// its whole subtree. That covers quitting the app. It does not cover the main
// process being killed outright — Task Manager, a crash, a host reboot — and in
// that case the backend survives, still holding every provider session and
// every MCP server beneath it. Nothing reaps it, the next launch spawns a fresh
// backend beside it, and the process count climbs with each cycle.
//
// The ledger closes that hole: a pid is recorded before the backend is used and
// forgotten when it exits cleanly, so anything still listed at the next startup
// is by definition an orphan from a run that never got to clean up.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  isSameProcess,
  killProcessTree,
  readProcessIdentity,
} from "@toolport-studio/shared/processTree";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";

const LEDGER_FILE_NAME = "backend-processes.json";

export const DesktopBackendProcessRecord = Schema.Struct({
  pid: Schema.Number,
  instanceId: Schema.String,
  /** Argument vector of the spawn, matched against the live command line. */
  commandLineTokens: Schema.Array(Schema.String),
  startedAtMs: Schema.Number,
});
export type DesktopBackendProcessRecord = typeof DesktopBackendProcessRecord.Type;

const DesktopBackendProcessLedgerFile = Schema.Struct({
  entries: Schema.Array(DesktopBackendProcessRecord),
});

const decodeLedgerFile = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendProcessLedgerFile),
);
const encodeLedgerFile = Schema.encodeEffect(
  Schema.fromJsonString(DesktopBackendProcessLedgerFile),
);

export interface DesktopBackendSweepReport {
  /** Orphans found still running and confirmed to be ours. */
  readonly terminated: ReadonlyArray<number>;
  /** Entries whose process was already gone. */
  readonly alreadyExited: ReadonlyArray<number>;
  /**
   * Entries whose pid is live but no longer matches what we recorded — the pid
   * was recycled by an unrelated process, which must not be killed.
   */
  readonly reused: ReadonlyArray<number>;
}

export interface DesktopBackendProcessLedgerShape {
  readonly record: (entry: DesktopBackendProcessRecord) => Effect.Effect<void>;
  readonly forget: (pid: number) => Effect.Effect<void>;
  /**
   * Terminates every recorded process that is still alive and still ours, then
   * drops the entries it examined. Must run before this run records anything of
   * its own.
   */
  readonly sweepOrphans: Effect.Effect<DesktopBackendSweepReport>;
}

/**
 * @effect-expect-leaking DesktopEnvironment
 */
export class DesktopBackendProcessLedger extends Context.Service<
  DesktopBackendProcessLedger,
  DesktopBackendProcessLedgerShape
>()("@toolport-studio/desktop/backend/DesktopBackendProcessLedger") {}

const { logInfo: logLedgerInfo, logWarning: logLedgerWarning } = makeComponentLogger(
  "desktop-backend-process-ledger",
);

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Serializes read-modify-write cycles; concurrent backend starts and stops in
  // the pool would otherwise interleave and drop each other's entries.
  const mutex = yield* Semaphore.make(1);

  const ledgerPath = path.join(environment.stateDir, LEDGER_FILE_NAME);

  const readEntries = Effect.gen(function* () {
    const contents = yield* fileSystem.readFileString(ledgerPath).pipe(Effect.option);
    if (Option.isNone(contents)) return [] as ReadonlyArray<DesktopBackendProcessRecord>;

    const decoded = yield* decodeLedgerFile(contents.value).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      // A truncated or hand-edited ledger is not worth failing startup over;
      // the cost is one missed sweep, not a broken app.
      yield* logLedgerWarning("discarding an unreadable backend process ledger", {
        path: ledgerPath,
      });
      return [] as ReadonlyArray<DesktopBackendProcessRecord>;
    }
    return decoded.value.entries;
  });

  const writeEntries = (entries: ReadonlyArray<DesktopBackendProcessRecord>) =>
    Effect.gen(function* () {
      const encoded = yield* encodeLedgerFile({ entries });
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a half-written
      // ledger that the next startup would discard along with its live pids.
      const temporaryPath = `${ledgerPath}.tmp`;
      yield* fileSystem.writeFileString(temporaryPath, encoded);
      yield* fileSystem.rename(temporaryPath, ledgerPath);
    }).pipe(
      Effect.catchCause((cause) =>
        logLedgerWarning("failed to persist the backend process ledger", {
          path: ledgerPath,
          cause,
        }),
      ),
    );

  const record: DesktopBackendProcessLedgerShape["record"] = (entry) =>
    mutex.withPermits(1)(
      readEntries.pipe(
        Effect.flatMap((entries) =>
          writeEntries([...entries.filter((existing) => existing.pid !== entry.pid), entry]),
        ),
      ),
    );

  const forget: DesktopBackendProcessLedgerShape["forget"] = (pid) =>
    mutex.withPermits(1)(
      readEntries.pipe(
        Effect.flatMap((entries) => {
          const remaining = entries.filter((entry) => entry.pid !== pid);
          return remaining.length === entries.length ? Effect.void : writeEntries(remaining);
        }),
      ),
    );

  const sweepOrphans: DesktopBackendProcessLedgerShape["sweepOrphans"] = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* readEntries;
        const terminated: Array<number> = [];
        const alreadyExited: Array<number> = [];
        const reused: Array<number> = [];

        for (const entry of entries) {
          const identity = yield* readProcessIdentity(entry.pid);
          if (Option.isNone(identity)) {
            alreadyExited.push(entry.pid);
            continue;
          }
          if (!isSameProcess(entry, identity.value)) {
            reused.push(entry.pid);
            continue;
          }

          const killed = yield* killProcessTree({
            pid: entry.pid,
            signal: "SIGKILL",
            leadsProcessGroup: true,
          }).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              logLedgerWarning("failed to terminate an orphaned backend process tree", {
                pid: entry.pid,
                instanceId: entry.instanceId,
                cause: error.message,
              }).pipe(Effect.as(false)),
            ),
          );
          if (killed) {
            terminated.push(entry.pid);
            yield* logLedgerInfo("terminated an orphaned backend process tree", {
              pid: entry.pid,
              instanceId: entry.instanceId,
              orphanedForMs: Date.now() - entry.startedAtMs,
            });
          }
        }

        // Entries that failed to die are dropped too: retrying them forever on
        // every launch cannot help, and the ledger would grow without bound.
        const examined = new Set(entries.map((entry) => entry.pid));
        const survivors = (yield* readEntries).filter((entry) => !examined.has(entry.pid));
        yield* writeEntries(survivors);

        if (terminated.length > 0 || reused.length > 0) {
          yield* logLedgerInfo("backend process ledger sweep complete", {
            terminated: terminated.length,
            alreadyExited: alreadyExited.length,
            reused: reused.length,
          });
        }

        return { terminated, alreadyExited, reused } satisfies DesktopBackendSweepReport;
      }),
    )
    .pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.withSpan("desktop.backendProcessLedger.sweepOrphans"),
    );

  return DesktopBackendProcessLedger.of({ record, forget, sweepOrphans });
});

export const layer = Layer.effect(DesktopBackendProcessLedger, make);

/**
 * In-memory ledger for tests that exercise the backend lifecycle without
 * touching the disk. `recorded` and `forgotten` let a test assert that a run
 * registered itself before use and deregistered itself on clean teardown.
 */
export const makeTestLedger = (): {
  readonly layer: Layer.Layer<DesktopBackendProcessLedger>;
  readonly recorded: ReadonlyArray<DesktopBackendProcessRecord>;
  readonly forgotten: ReadonlyArray<number>;
} => {
  const recorded: Array<DesktopBackendProcessRecord> = [];
  const forgotten: Array<number> = [];
  return {
    layer: Layer.succeed(
      DesktopBackendProcessLedger,
      DesktopBackendProcessLedger.of({
        record: (entry) =>
          Effect.sync(() => {
            recorded.push(entry);
          }),
        forget: (pid) =>
          Effect.sync(() => {
            forgotten.push(pid);
          }),
        sweepOrphans: Effect.succeed({ terminated: [], alreadyExited: [], reused: [] }),
      }),
    ),
    recorded,
    forgotten,
  };
};
