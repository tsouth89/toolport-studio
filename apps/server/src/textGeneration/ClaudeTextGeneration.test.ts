// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ClaudeSettings, ProviderInstanceId } from "@toolport-studio/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@toolport-studio/shared/model";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import {
  FAKE_CLI_PRELUDE,
  withInjectedSpec,
  writeFakeProviderCli,
} from "./testing/fakeProviderCli.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Fake `claude` behaviour. Every expectation arrives through the environment the
 * adapter passes at spawn time, so this body is fixed and needs no spec.
 * Assertion order and exit codes mirror the shell fake this replaced.
 */
const CLAUDE_FAKE_BODY = `
const stdinContent = readStdin();

const requiredArgs = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
if (requiredArgs && !argsText.includes(requiredArgs)) {
  fail("args missing expected content", 2);
}

const forbiddenArgs = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
if (forbiddenArgs && argsText.includes(forbiddenArgs)) {
  fail("args contained forbidden content", 3);
}

const requiredStdin = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
if (requiredStdin && !stdinContent.includes(requiredStdin)) {
  fail("stdin missing expected content", 4);
}

const requiredConfigDir = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
if (requiredConfigDir && process.env.CLAUDE_CONFIG_DIR !== requiredConfigDir) {
  fail("CLAUDE_CONFIG_DIR was " + process.env.CLAUDE_CONFIG_DIR, 5);
}

const stderrText = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR;
if (stderrText) {
  writeStderr(stderrText + "\\n");
}

// No trailing newline, matching the shell fake's \`printf "%s"\`.
writeStdout(process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_OUTPUT ?? "");
process.exit(Number.parseInt(process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE ?? "0", 10) || 0);
`;

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    yield* writeFakeProviderCli({
      dir: binDir,
      name: "claude",
      source: withInjectedSpec({}, `${FAKE_CLI_PRELUDE}${CLAUDE_FAKE_BODY}`),
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const previousPath = process.env.PATH;
    const previousOutput = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain =
      process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // Windows separates PATH entries with `;`. Hardcoding `:` produced one
        // malformed entry, so the fake was never found and the real `claude` on
        // PATH answered instead.
        process.env.PATH = `${binDir}${NodePath.delimiter}${previousPath ?? ""}`;
        process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN =
              previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.TOOLPORT_STUDIO_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
