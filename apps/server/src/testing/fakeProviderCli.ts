// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isHostWindows } from "@toolport-studio/shared/hostProcess";

/**
 * Shebang line for the POSIX fakes.
 *
 * Interpolates the absolute interpreter path rather than using
 * `#!/usr/bin/env node`. Some suites hand the adapter a replacement environment,
 * and `env` resolves `node` through the PATH it is given, so the fake died with
 * `/usr/bin/env: 'node': No such file or directory`. The `#!/bin/sh` these
 * replaced was an absolute path and needed no lookup; this keeps that property.
 */
const posixShebang = (): string => `#!${process.execPath}\n`;

/**
 * `.cmd` shim contents for the Windows fakes.
 *
 * Quotes the absolute interpreter path for the same reason {@link posixShebang}
 * does: a bare `node` would be resolved through whatever PATH the adapter passes
 * at spawn time, and some suites replace it.
 */
const windowsShim = (scriptName: string): string =>
  `@"${process.execPath}" "%~dp0${scriptName}" %*\r\n`;

/**
 * Writes a fake provider CLI that both POSIX and Windows can actually execute,
 * and returns the path to hand to `binaryPath` (or to put on PATH).
 *
 * These fakes used to be `#!/bin/sh` scripts made executable with `chmod`, which
 * pinned every suite using one to POSIX: Windows has no shebang handling and no
 * execute bit, so the spawn failed before any assertion ran. Writing the fake in
 * JavaScript and launching it with the same Node that runs the test means both
 * platforms exercise byte-identical fake behaviour, so a passing suite on one
 * platform means something on the other.
 *
 * Only the launcher differs:
 *
 * - POSIX: one extensionless file with an absolute-interpreter shebang, mode
 *   0755, spawned directly.
 * - Windows: `<name>.cjs` holds the logic and a `<name>.cmd` shim invokes Node.
 *   Neither `.CJS` nor `.SH` is in PATHEXT and spawning one directly fails with
 *   `EFTYPE`, so a shim is the only form that resolves, whether the adapter is
 *   handed an absolute path or finds the command on PATH. `resolveSpawnCommand`
 *   already routes `.cmd` through shell mode. This is also how npm installs CLIs
 *   on Windows, so the test spawns the same shape as a real install.
 *
 * `source` must be CommonJS. Node treats an extensionless entry point as
 * CommonJS unless a parent `package.json` says otherwise, and these are written
 * under the OS temp directory, which has no parent manifest.
 */
export const writeFakeProviderCli = Effect.fn("testing.writeFakeProviderCli")(function* (input: {
  readonly dir: string;
  readonly name: string;
  readonly source: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.dir, { recursive: true });

  if (!(yield* isHostWindows)) {
    const executablePath = path.join(input.dir, input.name);
    yield* fs.writeFileString(executablePath, `${posixShebang()}${input.source}`);
    yield* fs.chmod(executablePath, 0o755);
    return executablePath;
  }

  const scriptName = `${input.name}.cjs`;
  yield* fs.writeFileString(path.join(input.dir, scriptName), input.source);
  const shimPath = path.join(input.dir, `${input.name}.cmd`);
  yield* fs.writeFileString(shimPath, windowsShim(scriptName));
  return shimPath;
});

/**
 * Synchronous form of {@link writeFakeProviderCli}, for suites that build their
 * fixtures with `node:fs` outside an Effect.
 */
export const writeFakeProviderCliSync = (input: {
  readonly dir: string;
  readonly name: string;
  readonly source: string;
}): string => {
  NodeFS.mkdirSync(input.dir, { recursive: true });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous fixture builder for suites that construct their fake outside an Effect.
  if (process.platform === "win32") {
    const scriptName = `${input.name}.cjs`;
    NodeFS.writeFileSync(NodePath.join(input.dir, scriptName), input.source, "utf8");
    const shimPath = NodePath.join(input.dir, `${input.name}.cmd`);
    NodeFS.writeFileSync(shimPath, windowsShim(scriptName), "utf8");
    return shimPath;
  }

  const executablePath = NodePath.join(input.dir, input.name);
  NodeFS.writeFileSync(executablePath, `${posixShebang()}${input.source}`, "utf8");
  NodeFS.chmodSync(executablePath, 0o755);
  return executablePath;
};

const readWhenNonEmpty = Effect.fn("testing.readWhenNonEmpty")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const content = yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.void));
    if (content !== undefined && content.trim().length > 0) {
      return content;
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

/**
 * Asserts an adapter shut its ACP child down, using whichever evidence the
 * platform can actually produce.
 *
 * POSIX reads the agent's own record and checks it for `posixReason`. Windows
 * cannot: `kill("SIGTERM")` maps to `TerminateProcess` there, so the agent's
 * `SIGTERM` and `exit` handlers never run and the exit log stays empty however
 * cleanly the adapter shut the child down. Waiting on the pid the agent recorded
 * at startup checks the stronger property instead, that the process is gone,
 * rather than skipping the case on the platform where process teardown is most
 * likely to go wrong.
 */
export const expectAcpChildClosed = Effect.fn("testing.expectAcpChildClosed")(function* (input: {
  readonly exitLogPath: string;
  readonly posixReason: string;
}) {
  if (!(yield* isHostWindows)) {
    const exitLog = yield* readWhenNonEmpty(input.exitLogPath);
    if (!exitLog.includes(input.posixReason)) {
      return yield* Effect.die(
        `expected the ACP exit log to contain ${input.posixReason}, got: ${exitLog.trim()}`,
      );
    }
    return;
  }

  const pid = Number.parseInt((yield* readWhenNonEmpty(`${input.exitLogPath}.pid`)).trim(), 10);
  if (!Number.isInteger(pid)) {
    return yield* Effect.die(`ACP agent recorded an unusable pid for ${input.exitLogPath}`);
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = yield* Effect.sync(() => {
      try {
        // Signal 0 probes for existence without delivering anything.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) {
      return;
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(
    `ACP child ${pid} was still running after the adapter should have closed it`,
  );
});

/**
 * Renders a fake CLI body that reads its expectations from an injected `SPEC`
 * constant.
 *
 * The shell fakes interpolated each assertion as a conditional block, so the
 * generator and the assertions were tangled together and every new expectation
 * meant more generated code. Injecting the spec as data keeps the body a fixed,
 * readable program.
 */
export const withInjectedSpec = (spec: unknown, body: string): string =>
  `"use strict";\nconst SPEC = ${JSON.stringify(spec)};\n${body}`;

/**
 * Shared prelude for fake CLIs: exposes the argument vector, a `fail` helper
 * that mirrors each fake's exit codes, and lazy stdin/output helpers.
 *
 * `readStdin` is deliberately a function rather than a captured value. The ACP
 * wrappers hand their stdin to a mock agent, so draining fd 0 up front would eat
 * the protocol stream.
 */
export const FAKE_CLI_PRELUDE = `
const nodeFs = require("node:fs");

const args = process.argv.slice(2);
const argsText = args.join(" ");

const readStdin = () => {
  try {
    return nodeFs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

// writeSync, not process.stdout.write: stdout and stderr are pipes here, so
// those writes are asynchronous and process.exit can drop them.
const writeStdout = (text) => nodeFs.writeSync(1, text);
const writeStderr = (text) => nodeFs.writeSync(2, text);

const fail = (message, code) => {
  writeStderr(message + "\\n");
  process.exit(code);
};

const writeOutput = (outputPath, contents) => {
  if (outputPath) {
    nodeFs.writeFileSync(outputPath, contents + "\\n");
  }
};
`;

/**
 * Body for fakes that only wrap the ACP mock agent: apply env, check the
 * argument vector, hand off.
 *
 * The mock agent is loaded in-process rather than spawned, matching the `exec`
 * the shell wrappers used: one process, and the agent inherits this process's
 * real stdin and stdout so the ACP stream is untouched.
 */
export const ACP_WRAPPER_FAKE_BODY = `
for (const [key, value] of Object.entries(SPEC.env)) {
  process.env[key] = value;
}

if (SPEC.expectedArgs.some((expected, index) => args[index] !== expected)) {
  fail("unexpected args: " + argsText, 11);
}

require(SPEC.mockAgentPath);
`;
