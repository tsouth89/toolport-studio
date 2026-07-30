// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isHostWindows } from "@toolport-studio/shared/hostProcess";

/** Body shared by the ACP wrapper fakes: apply env, check args, hand off to the mock agent. */
export const ACP_WRAPPER_FAKE_BODY = `
for (const [key, value] of Object.entries(SPEC.env)) {
  process.env[key] = value;
}

if (SPEC.expectedArgs.some((expected, index) => args[index] !== expected)) {
  fail("unexpected args: " + argsText, 11);
}

// Loaded in-process rather than spawned. The shell fake used \`exec\`, so the
// mock agent replaced the wrapper and was the adapter's direct child; an extra
// process layer would leave the agent as a grandchild that never sees the
// adapter close stdin, so teardown assertions would hang.
require(SPEC.mockAgentPath);
`;

/**
 * Shebang line for the POSIX fakes.
 *
 * Interpolates the absolute interpreter path rather than using
 * `#!/usr/bin/env node`. Some suites hand the adapter a replacement environment,
 * and `env` resolves `node` through the PATH it is given, so the fake died with
 * `/usr/bin/env: 'node': No such file or directory`. The old `#!/bin/sh` was an
 * absolute path and needed no lookup; this keeps that property.
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
 * and returns the path to hand to `binaryPath`.
 *
 * These fakes used to be `#!/bin/sh` scripts made executable with `chmod`, which
 * pinned every text-generation suite to POSIX: Windows has no shebang handling
 * and no execute bit, so the spawn failed before any assertion ran. Writing the
 * fake in JavaScript and launching it with the same Node that runs the test
 * means both platforms exercise byte-identical fake behaviour, so a passing
 * suite on one platform means something on the other.
 *
 * Only the launcher differs:
 *
 * - POSIX: one extensionless file with an absolute-interpreter shebang (see
 *   {@link posixShebang}), mode 0755, spawned directly.
 * - Windows: `<name>.cjs` holds the logic and a `<name>.cmd` shim invokes Node.
 *   `.CJS` is not in PATHEXT and a direct spawn of one fails with `EFTYPE`, so a
 *   shim is the only way the command resolves. `resolveSpawnCommand` already
 *   routes `.cmd` through shell mode. This is also how npm installs CLIs on
 *   Windows, so the test spawns the same shape as a real install.
 *
 * `source` must be CommonJS. Node treats an extensionless entry point as
 * CommonJS unless a parent `package.json` says otherwise, and these are written
 * under the OS temp directory, which has no parent manifest.
 */
export const writeFakeProviderCli = Effect.fn("textGeneration.testing.writeFakeProviderCli")(
  function* (input: { readonly dir: string; readonly name: string; readonly source: string }) {
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
  },
);

/**
 * Writes a fake CLI for the ACP suites, whose adapters accept a Node script as
 * `binaryPath` and launch it with `process.execPath` (see `isNodeScript` in
 * `CursorAcpSupport` / `GrokAcpSupport`).
 *
 * On Windows this returns the `.cjs` path so the adapter spawns Node directly.
 * A `.cmd` shim would work for a plain invocation but not for these suites: it
 * routes through `cmd.exe`, and the teardown tests kill the child and then wait
 * for the mock agent to record its own exit. Killing the shell orphans the
 * agent, so the exit never lands and the assertion hangs. Spawning Node
 * directly keeps the fake as the adapter's immediate child, which is what the
 * old shell fake achieved with `exec`.
 *
 * POSIX keeps the extensionless shebang file, so the platforms cover both
 * branches of the adapter's launcher.
 */
export const writeFakeAcpWrapperSync = (input: {
  readonly dir: string;
  readonly name: string;
  readonly source: string;
}): string => {
  NodeFS.mkdirSync(input.dir, { recursive: true });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Synchronous fixture builder for suites that construct their fake outside an Effect.
  if (process.platform === "win32") {
    const scriptPath = NodePath.join(input.dir, `${input.name}.cjs`);
    NodeFS.writeFileSync(scriptPath, input.source, "utf8");
    return scriptPath;
  }

  const executablePath = NodePath.join(input.dir, input.name);
  NodeFS.writeFileSync(executablePath, `${posixShebang()}${input.source}`, "utf8");
  NodeFS.chmodSync(executablePath, 0o755);
  return executablePath;
};

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
