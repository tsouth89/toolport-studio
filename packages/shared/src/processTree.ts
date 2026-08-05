// Cross-platform process-tree primitives: identifying a pid well enough to be
// sure it is still the process we spawned, and terminating a pid together with
// everything beneath it.
//
// Both exist because a provider session is the root of a deep chain — an agent
// CLI spawns an MCP gateway, which spawns a shim-and-server pair per configured
// MCP server — and Windows neither reparents orphans nor offers process groups.
// Terminating the root alone strands the rest permanently.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessPlatform } from "./hostProcess.ts";

/**
 * `taskkill /T` walks and terminates the whole subtree before it exits, and a
 * single provider session can root several dozen processes. Budgeted well above
 * a read-only query so giving up early cannot leave the tail of a tree alive
 * with its parent already gone.
 */
const PROCESS_TREE_KILL_TIMEOUT_MS = 15_000;
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const PROCESS_QUERY_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How far a live process's observed start time may sit from the start time
 * recorded when we spawned it before we stop believing it is the same process.
 *
 * Guards against pid reuse. The window can be generous without being unsafe: a
 * recycled pid necessarily belongs to a process that started *after* ours
 * exited, and ours was alive — holding that pid — for the whole span between
 * the recorded timestamp and its death. Nothing else can have taken the pid
 * inside this window.
 */
const PROCESS_START_TIME_TOLERANCE_MS = 60_000;

export interface ProcessIdentity {
  readonly pid: number;
  readonly commandLine: string;
  readonly startedAtMs: number;
}

export class ProcessTreeQueryError extends Schema.TaggedErrorClass<ProcessTreeQueryError>()(
  "ProcessTreeQueryError",
  {
    command: Schema.String,
    pid: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Process query '${this.command}' for pid ${this.pid} failed: ${this.detail}`;
  }
}

export class ProcessTreeKillError extends Schema.TaggedErrorClass<ProcessTreeKillError>()(
  "ProcessTreeKillError",
  {
    pid: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to terminate the process tree rooted at pid ${this.pid}: ${this.detail}`;
  }
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const decoder = new TextDecoder();

/** Bounded so a pathological command cannot grow the heap without limit. */
const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.runFold(
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
      (state, chunk) => {
        const remaining = PROCESS_QUERY_MAX_OUTPUT_BYTES - state.bytes;
        if (remaining <= 0) return state;
        const next = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        state.chunks.push(next);
        return { chunks: state.chunks, bytes: state.bytes + next.byteLength };
      },
    ),
    Effect.map((state) => decoder.decode(Buffer.concat(state.chunks, state.bytes))),
  );

const runCommand = Effect.fn("processTree.runCommand")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly pid: number;
  readonly timeoutMillis: number;
}): Effect.fn.Return<
  CommandOutput,
  ProcessTreeQueryError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(input.command, input.args));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collectText(child.stdout), collectText(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), stdout, stderr } satisfies CommandOutput;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(input.timeoutMillis)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProcessTreeQueryError({
              command: input.command,
              pid: input.pid,
              detail: `timed out after ${input.timeoutMillis}ms`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof ProcessTreeQueryError
        ? cause
        : new ProcessTreeQueryError({
            command: input.command,
            pid: input.pid,
            detail: cause.message,
          }),
    ),
  );
});

/**
 * Parses the single-row JSON that `Get-CimInstance ... | ConvertTo-Json` emits
 * for one pid. `CreationDate` arrives as a serialized .NET `DateTime`, which
 * `ConvertTo-Json` renders either as an ISO-8601 string or as the
 * `/Date(1234567890)/` epoch form depending on the PowerShell edition.
 */
export function parseWindowsProcessIdentity(output: string): Option.Option<ProcessIdentity> {
  const trimmed = output.trim();
  if (trimmed.length === 0) return Option.none();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return Option.none();
  }

  const record = (Array.isArray(parsed) ? parsed[0] : parsed) as
    | Record<string, unknown>
    | undefined;
  if (typeof record !== "object" || record === null) return Option.none();

  const pid = typeof record.ProcessId === "number" ? record.ProcessId : null;
  const commandLine =
    typeof record.CommandLine === "string" && record.CommandLine.trim().length > 0
      ? record.CommandLine
      : typeof record.Name === "string" && record.Name.trim().length > 0
        ? record.Name
        : null;
  const startedAtMs = parseWindowsCreationDate(record.CreationDate);

  if (pid === null || pid <= 0 || commandLine === null || startedAtMs === null) {
    return Option.none();
  }
  return Option.some({ pid, commandLine, startedAtMs });
}

function parseWindowsCreationDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const epochMatch = /^\/Date\((-?\d+)\)\/$/.exec(value.trim());
  if (epochMatch?.[1] !== undefined) {
    const epochMs = Number.parseInt(epochMatch[1], 10);
    return Number.isFinite(epochMs) ? epochMs : null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parses `ps -p <pid> -o lstart=,args=` output: a fixed-width `ctime` timestamp
 * ("Wed May  6 10:00:00 2026") followed by the full argument vector.
 */
export function parsePosixProcessIdentity(
  pid: number,
  output: string,
): Option.Option<ProcessIdentity> {
  const line = output.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return Option.none();

  const match = /^\s*(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(line);
  const lstart = match?.[1];
  const command = match?.[2];
  if (lstart === undefined || command === undefined) return Option.none();

  const startedAtMs = Date.parse(lstart);
  if (Number.isNaN(startedAtMs)) return Option.none();

  return Option.some({ pid, commandLine: command.trim(), startedAtMs });
}

/**
 * Reads the live identity of `pid`, or `None` when no such process exists.
 *
 * A query that fails outright — the tool is missing, the host denies access —
 * also yields `None`: callers use this to decide whether to terminate something,
 * and "we could not tell" must never be read as "yes, that is ours".
 */
export const readProcessIdentity = Effect.fn("processTree.readProcessIdentity")(function* (
  pid: number,
): Effect.fn.Return<
  Option.Option<ProcessIdentity>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const platform = yield* HostProcessPlatform;

  const output = yield* (
    platform === "win32"
      ? runCommand({
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CreationDate,CommandLine,Name | ConvertTo-Json -Compress`,
          ],
          pid,
          timeoutMillis: PROCESS_IDENTITY_TIMEOUT_MS,
        })
      : runCommand({
          command: "ps",
          args: ["-p", String(pid), "-o", "lstart=,args="],
          pid,
          timeoutMillis: PROCESS_IDENTITY_TIMEOUT_MS,
        })
  ).pipe(Effect.option);

  if (Option.isNone(output)) return Option.none();
  // `ps` exits non-zero for a pid that does not exist; PowerShell exits zero
  // and prints nothing. Both mean "no such process".
  if (output.value.exitCode !== 0) return Option.none();

  return platform === "win32"
    ? parseWindowsProcessIdentity(output.value.stdout)
    : parsePosixProcessIdentity(pid, output.value.stdout);
});

export interface RecordedProcess {
  readonly pid: number;
  /**
   * Distinctive fragments of the spawn invocation — typically the argument
   * vector. Matched as substrings rather than compared to a reconstructed
   * command line, because the OS re-quotes arguments on its way to
   * `CommandLine`/`args` and an exact rebuild never survives that round trip.
   */
  readonly commandLineTokens: ReadonlyArray<string>;
  readonly startedAtMs: number;
}

/**
 * Whether `identity` is still the process described by `recorded`, rather than
 * an unrelated process that inherited a recycled pid.
 *
 * The start-time window carries most of the weight; the token match is defence
 * in depth for the case where a pid is reused fast enough to land inside it.
 */
export function isSameProcess(recorded: RecordedProcess, identity: ProcessIdentity): boolean {
  if (identity.pid !== recorded.pid) return false;
  if (Math.abs(identity.startedAtMs - recorded.startedAtMs) > PROCESS_START_TIME_TOLERANCE_MS) {
    return false;
  }
  const tokens = recorded.commandLineTokens.filter((token) => token.length > 0);
  // No usable tokens means nothing to corroborate the start time with, so the
  // match is refused rather than decided on the timestamp alone.
  if (tokens.length === 0) return false;
  return tokens.every((token) => identity.commandLine.includes(token));
}

/**
 * Terminates `pid` and every process beneath it.
 *
 * Windows has no process groups to signal and maps every signal onto
 * `TerminateProcess` for a single target, so `taskkill /T /F` is both the only
 * way to reach the subtree and no blunter than a plain `process.kill` would
 * have been. This mirrors the teardown the Effect spawner performs when a scope
 * closes.
 *
 * On POSIX, children spawned detached lead their own process group, so a
 * negative pid reaches the group while preserving the requested signal's
 * semantics. Pass `leadsProcessGroup: false` for a target that merely belongs to
 * someone else's group, where signalling the group would reach unrelated
 * siblings.
 */
export const killProcessTree = Effect.fn("processTree.killProcessTree")(function* (input: {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
  readonly leadsProcessGroup: boolean;
}): Effect.fn.Return<void, ProcessTreeKillError, ChildProcessSpawner.ChildProcessSpawner> {
  const platform = yield* HostProcessPlatform;

  if (platform === "win32") {
    const output = yield* runCommand({
      command: "taskkill",
      args: ["/PID", String(input.pid), "/T", "/F"],
      pid: input.pid,
      timeoutMillis: PROCESS_TREE_KILL_TIMEOUT_MS,
    }).pipe(
      Effect.mapError(
        (cause) => new ProcessTreeKillError({ pid: input.pid, detail: cause.detail }),
      ),
    );
    if (output.exitCode !== 0) {
      return yield* new ProcessTreeKillError({
        pid: input.pid,
        detail: `taskkill exited with code ${output.exitCode}: ${output.stderr.trim()}`,
      });
    }
    return;
  }

  yield* Effect.try({
    try: () => {
      process.kill(input.leadsProcessGroup ? -input.pid : input.pid, input.signal);
    },
    catch: (cause) =>
      new ProcessTreeKillError({
        pid: input.pid,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
