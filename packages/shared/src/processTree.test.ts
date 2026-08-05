import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessPlatform } from "./hostProcess.ts";
import {
  isSameProcess,
  killProcessTree,
  parsePosixProcessIdentity,
  parseWindowsProcessIdentity,
  readProcessIdentity,
} from "./processTree.ts";

const encoder = new TextEncoder();

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function spawnerLayer(
  handle: (command: { readonly command: string; readonly args: ReadonlyArray<string> }) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
  },
  commands?: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands?.push({ command: childProcess.command, args: childProcess.args });
      return Effect.succeed(mockHandle(handle(childProcess)));
    }),
  );
}

describe("processTree", () => {
  it.effect("parses a Windows identity from ConvertTo-Json output", () =>
    Effect.sync(() => {
      const identity = parseWindowsProcessIdentity(
        JSON.stringify({
          ProcessId: 4242,
          CreationDate: "2026-05-05T10:00:00.000Z",
          CommandLine: '"C:\\electron.exe" "C:\\server\\bin.mjs" --bootstrap-fd 3',
          Name: "electron.exe",
        }),
      );

      expect(Option.getOrNull(identity)).toEqual({
        pid: 4242,
        commandLine: '"C:\\electron.exe" "C:\\server\\bin.mjs" --bootstrap-fd 3',
        startedAtMs: Date.parse("2026-05-05T10:00:00.000Z"),
      });
    }),
  );

  it.effect("parses the /Date(...)/ creation form Windows PowerShell emits", () =>
    Effect.sync(() => {
      const identity = parseWindowsProcessIdentity(
        JSON.stringify({
          ProcessId: 7,
          CreationDate: "/Date(1777982400000)/",
          CommandLine: "node server.js",
        }),
      );

      expect(Option.getOrNull(identity)?.startedAtMs).toBe(1_777_982_400_000);
    }),
  );

  it.effect("treats empty or unparseable query output as no such process", () =>
    Effect.sync(() => {
      expect(Option.isNone(parseWindowsProcessIdentity(""))).toBe(true);
      expect(Option.isNone(parseWindowsProcessIdentity("not json"))).toBe(true);
      expect(Option.isNone(parsePosixProcessIdentity(5, ""))).toBe(true);
    }),
  );

  it.effect("parses a POSIX identity from ps lstart output", () =>
    Effect.sync(() => {
      const identity = parsePosixProcessIdentity(
        4242,
        "Tue May  5 10:00:00 2026 node /server/bin.mjs --bootstrap-fd 3\n",
      );

      expect(Option.getOrNull(identity)).toEqual({
        pid: 4242,
        commandLine: "node /server/bin.mjs --bootstrap-fd 3",
        startedAtMs: Date.parse("Tue May  5 10:00:00 2026"),
      });
    }),
  );

  it.effect("reports no identity when the process query fails or exits non-zero", () =>
    Effect.gen(function* () {
      const identity = yield* readProcessIdentity(4242).pipe(
        Effect.provide(spawnerLayer(() => ({ code: 1 }))),
        Effect.provideService(HostProcessPlatform, "linux"),
      );

      // A failed lookup must never be read as "yes, that process is ours" —
      // callers use this to decide whether to terminate something.
      expect(Option.isNone(identity)).toBe(true);
    }),
  );

  it.effect("rejects a recycled pid whose start time moved outside the window", () =>
    Effect.sync(() => {
      const recorded = {
        pid: 4242,
        commandLineTokens: ["/server/bin.mjs", "--bootstrap-fd"],
        startedAtMs: 1_000_000,
      };

      expect(
        isSameProcess(recorded, {
          pid: 4242,
          commandLine: "node /server/bin.mjs --bootstrap-fd 3",
          startedAtMs: 1_030_000,
        }),
      ).toBe(true);
      // Same pid and command, but started far too late to be the process we
      // spawned: the pid was reused.
      expect(
        isSameProcess(recorded, {
          pid: 4242,
          commandLine: "node /server/bin.mjs --bootstrap-fd 3",
          startedAtMs: 5_000_000,
        }),
      ).toBe(false);
    }),
  );

  it.effect("rejects a pid whose command line no longer carries every token", () =>
    Effect.sync(() => {
      const recorded = {
        pid: 4242,
        commandLineTokens: ["/server/bin.mjs", "--bootstrap-fd"],
        startedAtMs: 1_000_000,
      };

      expect(
        isSameProcess(recorded, {
          pid: 4242,
          commandLine: "node /other/app.mjs",
          startedAtMs: 1_000_000,
        }),
      ).toBe(false);
      // Nothing to corroborate the timestamp with: refuse rather than kill on a
      // start time alone.
      expect(
        isSameProcess(
          { ...recorded, commandLineTokens: [] },
          { pid: 4242, commandLine: "node /server/bin.mjs", startedAtMs: 1_000_000 },
        ),
      ).toBe(false);
      expect(
        isSameProcess(recorded, {
          pid: 99,
          commandLine: "node /server/bin.mjs --bootstrap-fd 3",
          startedAtMs: 1_000_000,
        }),
      ).toBe(false);
    }),
  );

  it.effect("terminates the whole subtree with taskkill on Windows", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];

      yield* killProcessTree({ pid: 4242, signal: "SIGKILL", leadsProcessGroup: true }).pipe(
        Effect.provide(spawnerLayer(() => ({}), commands)),
        Effect.provideService(HostProcessPlatform, "win32"),
      );

      expect(commands).toEqual([{ command: "taskkill", args: ["/PID", "4242", "/T", "/F"] }]);
    }),
  );

  it.effect("surfaces a non-zero taskkill exit as a failure", () =>
    Effect.gen(function* () {
      const error = yield* killProcessTree({
        pid: 4242,
        signal: "SIGKILL",
        leadsProcessGroup: true,
      }).pipe(
        Effect.provide(spawnerLayer(() => ({ code: 128, stderr: "not found" }))),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      expect(error._tag).toBe("ProcessTreeKillError");
      expect(error.message).toContain("taskkill exited with code 128");
    }),
  );
});
