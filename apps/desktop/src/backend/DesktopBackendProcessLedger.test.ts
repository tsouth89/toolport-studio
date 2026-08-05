import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@toolport-studio/shared/hostProcess";

import * as DesktopBackendProcessLedger from "./DesktopBackendProcessLedger.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const encoder = new TextEncoder();
const STATE_DIR = "/tmp/t3-state";

const encodeLedgerFile = Schema.encodeSync(
  Schema.fromJsonString(DesktopBackendProcessLedger.DesktopBackendProcessLedgerFile),
);
const decodeLedgerFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopBackendProcessLedger.DesktopBackendProcessLedgerFile),
);

/** Fixed clock reading; the ledger compares against it, so it must be stable. */
const NOW_MS = Date.parse("2026-05-05T10:00:00.000Z");

function mockHandle(result: { readonly stdout?: string; readonly code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Minimal in-memory filesystem covering exactly what the ledger touches. */
function memoryFileSystemLayer(files: Map<string, string>) {
  return FileSystem.layerNoop({
    readFileString: (filePath) => {
      const contents = files.get(String(filePath));
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: String(filePath),
            }),
          )
        : Effect.succeed(contents);
    },
    writeFileString: (filePath, contents) =>
      Effect.sync(() => {
        files.set(String(filePath), contents);
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        const contents = files.get(String(from));
        if (contents !== undefined) {
          files.set(String(to), contents);
          files.delete(String(from));
        }
      }),
    makeDirectory: () => Effect.void,
  });
}

interface HarnessInput {
  readonly files?: Map<string, string>;
  /** POSIX `ps` output per pid; a missing entry means the process is gone. */
  readonly liveProcesses?: ReadonlyMap<number, string>;
}

function makeHarness(input: HarnessInput = {}) {
  const files = input.files ?? new Map<string, string>();
  const killed: Array<number> = [];
  const live = input.liveProcesses ?? new Map<number, string>();

  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      if (childProcess.command === "ps") {
        const pid = Number(childProcess.args[1]);
        const row = live.get(pid);
        return Effect.succeed(
          row === undefined ? mockHandle({ code: 1 }) : mockHandle({ stdout: row }),
        );
      }
      if (childProcess.command === "powershell.exe") {
        const pid = Number(/ProcessId=(\d+)/.exec(childProcess.args.at(-1) ?? "")?.[1]);
        const row = live.get(pid);
        return Effect.succeed(mockHandle({ stdout: row ?? "" }));
      }
      if (childProcess.command === "taskkill") {
        killed.push(Number(childProcess.args[1]));
        return Effect.succeed(mockHandle({}));
      }
      // POSIX tree kill goes through process.kill, so any other spawn here is a
      // test wiring mistake rather than something to silently absorb.
      return Effect.die(`unexpected spawn: ${childProcess.command}`);
    }),
  );

  const layer = DesktopBackendProcessLedger.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        memoryFileSystemLayer(files),
        Path.layer,
        spawner,
        Layer.succeed(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.DesktopEnvironment.of({
            stateDir: STATE_DIR,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
      ),
    ),
  );

  return { layer, files, killed };
}

const ledgerPath = `${STATE_DIR}/backend-processes.json`;

const psRow = (startedAt: string, command: string) => `${startedAt} ${command}\n`;

describe("DesktopBackendProcessLedger", () => {
  it.effect("records a spawned backend and forgets it on clean teardown", () =>
    Effect.gen(function* () {
      const { layer, files } = makeHarness();

      yield* Effect.service(DesktopBackendProcessLedger.DesktopBackendProcessLedger).pipe(
        Effect.flatMap((ledger) =>
          ledger.record({
            pid: 4242,
            instanceId: "primary",
            commandLineTokens: ["/server/bin.mjs", "--bootstrap-fd"],
            startedAtMs: 1_000_000,
          }),
        ),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(decodeLedgerFile(files.get(ledgerPath)!).entries).toHaveLength(1);

      yield* Effect.service(DesktopBackendProcessLedger.DesktopBackendProcessLedger).pipe(
        Effect.flatMap((ledger) => ledger.forget(4242)),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(decodeLedgerFile(files.get(ledgerPath)!).entries).toEqual([]);
    }),
  );

  it.effect("leaves nothing to sweep when the ledger is absent", () =>
    Effect.gen(function* () {
      const { layer } = makeHarness();

      const report = yield* Effect.service(
        DesktopBackendProcessLedger.DesktopBackendProcessLedger,
      ).pipe(
        Effect.flatMap((ledger) => ledger.sweepOrphans),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(report).toEqual({ terminated: [], alreadyExited: [], reused: [] });
    }),
  );

  it.effect("classifies an entry whose process already exited", () =>
    Effect.gen(function* () {
      const files = new Map([
        [
          ledgerPath,
          encodeLedgerFile({
            entries: [
              {
                pid: 4242,
                instanceId: "primary",
                commandLineTokens: ["/server/bin.mjs"],
                startedAtMs: NOW_MS,
              },
            ],
          }),
        ],
      ]);
      const { layer } = makeHarness({ files });

      const report = yield* Effect.service(
        DesktopBackendProcessLedger.DesktopBackendProcessLedger,
      ).pipe(
        Effect.flatMap((ledger) => ledger.sweepOrphans),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(report.alreadyExited).toEqual([4242]);
      expect(report.terminated).toEqual([]);
      // Examined entries are dropped so the ledger cannot grow without bound.
      expect(decodeLedgerFile(files.get(ledgerPath)!).entries).toEqual([]);
    }),
  );

  it.effect("terminates the tree of a confirmed orphan and clears its entry", () =>
    Effect.gen(function* () {
      const startedAtMs = Date.parse("2026-05-05T10:00:00.000Z");
      const files = new Map([
        [
          ledgerPath,
          encodeLedgerFile({
            entries: [
              {
                pid: 4242,
                instanceId: "primary",
                commandLineTokens: ["C:\\server\\bin.mjs", "--bootstrap-fd"],
                startedAtMs,
              },
            ],
          }),
        ],
      ]);
      const { layer, killed } = makeHarness({
        files,
        liveProcesses: new Map([
          [
            4242,
            // Verbatim Get-CimInstance payload — the escaping is what the
            // identity parser has to survive.
            String.raw`{"ProcessId":4242,"CreationDate":"2026-05-05T10:00:00.000Z","CommandLine":"\"C:\\electron.exe\" \"C:\\server\\bin.mjs\" --bootstrap-fd 3"}`,
          ],
        ]),
      });

      const report = yield* Effect.service(
        DesktopBackendProcessLedger.DesktopBackendProcessLedger,
      ).pipe(
        Effect.flatMap((ledger) => ledger.sweepOrphans),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      expect(report.terminated).toEqual([4242]);
      // /T is what reaches the provider sessions and MCP servers beneath it.
      expect(killed).toEqual([4242]);
      expect(decodeLedgerFile(files.get(ledgerPath)!).entries).toEqual([]);
    }),
  );

  it.effect("refuses to kill a pid that was recycled by an unrelated process", () =>
    Effect.gen(function* () {
      const startedAtMs = Date.parse("Tue May  5 10:00:00 2026");
      const files = new Map([
        [
          ledgerPath,
          encodeLedgerFile({
            entries: [
              {
                pid: 4242,
                instanceId: "primary",
                commandLineTokens: ["/server/bin.mjs"],
                startedAtMs,
              },
            ],
          }),
        ],
      ]);
      const { layer } = makeHarness({
        files,
        // Same pid, but a different program that started hours later: the pid was
        // handed to something that is emphatically not ours.
        liveProcesses: new Map([
          [4242, psRow("Tue May  5 14:00:00 2026", "/usr/bin/unrelated --serve")],
        ]),
      });

      const report = yield* Effect.service(
        DesktopBackendProcessLedger.DesktopBackendProcessLedger,
      ).pipe(
        Effect.flatMap((ledger) => ledger.sweepOrphans),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(report.reused).toEqual([4242]);
      expect(report.terminated).toEqual([]);
    }),
  );

  it.effect("discards an unreadable ledger instead of failing startup", () =>
    Effect.gen(function* () {
      const files = new Map([[ledgerPath, "{ truncated"]]);
      const { layer } = makeHarness({ files });

      const report = yield* Effect.service(
        DesktopBackendProcessLedger.DesktopBackendProcessLedger,
      ).pipe(
        Effect.flatMap((ledger) => ledger.sweepOrphans),
        Effect.provide(layer),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      expect(report).toEqual({ terminated: [], alreadyExited: [], reused: [] });
    }),
  );
});
