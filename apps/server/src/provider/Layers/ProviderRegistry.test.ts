import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@toolport-studio/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@toolport-studio/shared/Struct";
import { HostProcessPlatform } from "@toolport-studio/shared/hostProcess";
import { createModelCapabilities } from "@toolport-studio/shared/model";
import { applyServerSettingsPatch } from "@toolport-studio/shared/serverSettings";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import {
  haveProvidersChanged,
  INDETERMINATE_TOLERANCE,
  type IndeterminateStreak,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  priorFailuresForObservation,
  resolveIndeterminateSnapshot,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

process.env.TOOLPORT_STUDIO_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      ...overrides,
    });
}

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/**
 * Pin the host platform for command resolution.
 *
 * `HostProcessPlatform` is a `Context.Reference` that defaults to the live
 * `process.platform`, and `resolveSpawnCommand` branches on it: on win32 it
 * resolves the binary through PATH + PATHEXT and, when that lands on a `.cmd`
 * or `.bat` shim, switches to shell mode and escapes every argument for
 * cmd.exe. So on a Windows host with the provider CLIs installed, a spawn these
 * tests expect to see as `--version` arrives as `^"--version^"`, and the
 * handlers below throw `Unexpected args`.
 *
 * That made the suite depend on both the developer's OS and whether they happen
 * to have `claude.cmd` on PATH — green on Linux CI, 18 failures on a Windows
 * machine with Claude Code installed. Pinning to linux short-circuits
 * `resolveSpawnCommand` before any of that, so these tests exercise provider
 * status logic on every host. The Windows escaping itself is covered by
 * `packages/shared/src/shell.test.ts`, which pins the platform the same way.
 */
const hostPlatformLayer = Layer.succeed(HostProcessPlatform, "linux");

/**
 * Waits in wall-clock time, independent of the ambient TestClock.
 *
 * Rebuilding a provider instance resolves its binary against the host PATH,
 * one filesystem probe per PATH entry per executable extension. That is real
 * async I/O, and advancing virtual time never lets it finish, so a poll loop
 * waiting on a rebuild has to hand the event loop back for real. How long it
 * takes scales with the size of the host PATH and with how loaded the machine
 * is, which is why a loop that only advanced TestClock passed on CI most of
 * the time and failed the rest.
 */
const sleepOffTestClock = (millis: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        // Deliberately not `Effect.sleep`: that resolves against the ambient
        // TestClock, which is the thing this needs to bypass.
        // @effect-diagnostics-next-line globalTimers:off
        globalThis.setTimeout(resolve, millis);
      }),
  );

/**
 * Poll a provider status cache file until `predicate` matches, or give up.
 *
 * Live-update persistence is driven by a forked stream fiber writing real
 * filesystem I/O. Advancing TestClock alone does not hand the event loop back
 * for those writes, so under Windows CI load a loop of `TestClock` +
 * `Effect.yieldNow` can time out with `cachedProvider === undefined` even
 * though the in-memory registry already settled (SOU-555).
 */
const awaitCachedProvider = (filePath: string, predicate: (provider: ServerProvider) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const cachedProvider = yield* readProviderStatusCache(filePath);
      if (cachedProvider !== undefined && predicate(cachedProvider)) {
        return cachedProvider;
      }
      yield* TestClock.adjust("10 millis");
      // Yield the real event loop so the forked persist fiber can run. Duration
      // is a scheduling quantum, not a write-time budget — once the fiber runs,
      // the atomic rename completes and the next read observes it.
      yield* sleepOffTestClock(5);
    }
    // Final read after the last yield so a write that landed in that quantum is
    // observed (atomic temp+rename). Return undefined when the predicate never
    // matched — returning a stale non-matching snapshot would let callers that
    // only assert on models pass through a persistence timeout.
    const finalCachedProvider = yield* readProviderStatusCache(filePath);
    return finalCachedProvider !== undefined && predicate(finalCachedProvider)
      ? finalCachedProvider
      : undefined;
  });

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.merge(
    hostPlatformLayer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const cmd = command as unknown as { args: ReadonlyArray<string> };
        return Effect.succeed(mockHandle(handler(cmd.args)));
      }),
    ),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const layer = Layer.merge(
    hostPlatformLayer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const cmd = command as unknown as {
          args: ReadonlyArray<string>;
          options?: {
            readonly env?: NodeJS.ProcessEnv;
          };
        };
        commands.push({ args: cmd.args, env: cmd.options?.env });
        return Effect.succeed(mockHandle(handler(cmd.args)));
      }),
    ),
  );
  return { layer, commands };
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.merge(
    hostPlatformLayer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const cmd = command as unknown as {
          command: string;
          args: ReadonlyArray<string>;
        };
        return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
      }),
    ),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingScopedSpawnerLayer(killCalls: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (current) => current + 1),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        return handle;
      }),
    ),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }),
      );

      it.effect("passes configured launch args to the Codex provider probe", () =>
        Effect.gen(function* () {
          let observedLaunchArgs: string | undefined;
          const settings = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });

          const status = yield* checkCodexProviderStatus(settings, (input) => {
            observedLaunchArgs = input.launchArgs;
            return Effect.succeed(makeCodexProbeSnapshot());
          });

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(observedLaunchArgs, "--strict-config --enable foo");
        }),
      );

      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("returns an Amazon Bedrock label for codex Bedrock auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "amazonBedrock" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "amazonBedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }),
      );

      it.effect("closes the app-server probe scope when provider status times out", () =>
        Effect.gen(function* () {
          const killCalls = yield* Ref.make(0);
          const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(hangingScopedSpawnerLayer(killCalls)),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          yield* TestClock.adjust("11 seconds");
          yield* Effect.yieldNow;

          const status = yield* Fiber.join(statusFiber);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(
            status.message,
            "Timed out while checking Codex app-server provider status.",
          );
          assert.strictEqual(yield* Ref.get(killCalls), 1);
        }),
      );
    });

    describe("resolveIndeterminateSnapshot", () => {
      const observed = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2.1.220",
        models: [
          { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;

      /** What a timed-out probe produces: an error that knows nothing. */
      const timedOut = {
        ...observed,
        status: "error",
        installed: true,
        version: null,
        auth: { status: "unknown" },
        checkedAt: "2026-04-14T00:05:00.000Z",
        models: [],
        indeterminate: true,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      } as const satisfies ServerProvider;

      const now = "2026-04-14T00:05:00.000Z";

      it("keeps the last observed status on a first indeterminate probe", () => {
        const outcome = resolveIndeterminateSnapshot({
          previous: observed,
          next: timedOut,
          consecutiveFailures: 0,
          now,
        });

        // The whole point: a blip must not make the provider unselectable.
        assert.strictEqual(outcome.provider.status, "ready");
        assert.strictEqual(outcome.provider.auth.status, "authenticated");
        assert.strictEqual(outcome.provider.version, "2.1.220");
        assert.strictEqual(outcome.provider.checkedAt, observed.checkedAt);
        assert.deepStrictEqual(outcome.provider.models, [...observed.models]);
        assert.deepStrictEqual(outcome.provider.refreshFailure, {
          at: now,
          message: timedOut.message,
        });
        assert.strictEqual(outcome.consecutiveFailures, 1);
      });

      it("reports the failure once the streak passes the tolerance", () => {
        const outcome = resolveIndeterminateSnapshot({
          previous: observed,
          next: timedOut,
          consecutiveFailures: INDETERMINATE_TOLERANCE,
          now,
        });

        // Absorbing forever would let a permanently broken CLI report ready.
        assert.strictEqual(outcome.provider.status, "error");
        assert.strictEqual(outcome.provider.message, timedOut.message);
        assert.strictEqual(outcome.provider.refreshFailure, undefined);
        assert.strictEqual(outcome.consecutiveFailures, INDETERMINATE_TOLERANCE + 1);
      });

      it("absorbs one probe timeout that gets published twice", () => {
        // Boot subscribes to the live source and then reads it directly. A
        // result landing between those two steps arrives on both paths, and
        // counting it twice used to exhaust the tolerance in the same
        // millisecond and report the provider broken.
        let streak: IndeterminateStreak | undefined;
        // `previousByKey` reads back from `providersRef`, so the second
        // delivery sees whatever the first one published.
        let published: ServerProvider = observed;
        const publish = (next: ServerProvider) => {
          const outcome = resolveIndeterminateSnapshot({
            previous: published,
            next,
            consecutiveFailures: priorFailuresForObservation(streak, next === timedOut),
            now,
          });
          streak = {
            consecutiveFailures: outcome.consecutiveFailures,
          };
          published = outcome.provider;
          return outcome;
        };

        const first = publish(timedOut);
        assert.strictEqual(first.provider.status, "ready");
        assert.strictEqual(first.consecutiveFailures, 1);

        // Same observation, second delivery: must not advance the streak.
        const second = publish(timedOut);
        assert.strictEqual(second.consecutiveFailures, 1);
        assert.strictEqual(second.provider.status, "ready");
      });

      it("still accumulates across genuinely separate probes", () => {
        // Independent observations must still pass the tolerance even when a
        // coarse clock gives both probes the same timestamp.
        const streak: IndeterminateStreak = {
          consecutiveFailures: 1,
        };
        const later = { ...timedOut } as const;

        const outcome = resolveIndeterminateSnapshot({
          previous: observed,
          next: later,
          consecutiveFailures: priorFailuresForObservation(streak, later === timedOut),
          now,
        });

        assert.strictEqual(outcome.consecutiveFailures, 2);
        assert.strictEqual(outcome.provider.status, "error");
      });

      it("clears the streak and the marker on any determinate result", () => {
        const outcome = resolveIndeterminateSnapshot({
          previous: { ...observed, refreshFailure: { at: now, message: "stale" } },
          next: { ...observed, checkedAt: "2026-04-14T00:06:00.000Z" },
          consecutiveFailures: 3,
          now,
        });

        assert.strictEqual(outcome.provider.status, "ready");
        assert.strictEqual(outcome.provider.checkedAt, "2026-04-14T00:06:00.000Z");
        assert.strictEqual(outcome.provider.refreshFailure, undefined);
        assert.strictEqual(outcome.consecutiveFailures, 0);
      });

      it("passes a determinate failure straight through", () => {
        const notInstalled = {
          ...observed,
          status: "error",
          installed: false,
          version: null,
          auth: { status: "unknown" },
          message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
        } as const satisfies ServerProvider;

        const outcome = resolveIndeterminateSnapshot({
          previous: observed,
          next: notInstalled,
          consecutiveFailures: 0,
          now,
        });

        // A missing binary is a fact, not a failure to look.
        assert.strictEqual(outcome.provider.status, "error");
        assert.strictEqual(outcome.provider.installed, false);
        assert.strictEqual(outcome.consecutiveFailures, 0);
      });

      it("does not invent state when nothing was observed before", () => {
        const outcome = resolveIndeterminateSnapshot({
          previous: undefined,
          next: timedOut,
          consecutiveFailures: 0,
          now,
        });

        assert.strictEqual(outcome.provider.status, "error");
        assert.strictEqual(outcome.provider.refreshFailure, undefined);
        assert.strictEqual(outcome.consecutiveFailures, 1);
      });

      it("does not carry forward a previous snapshot that was itself failing", () => {
        const previouslyUnauthenticated = {
          ...observed,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Claude is not authenticated. Run `claude auth login` and try again.",
        } as const satisfies ServerProvider;

        const outcome = resolveIndeterminateSnapshot({
          previous: previouslyUnauthenticated,
          next: timedOut,
          consecutiveFailures: 0,
          now,
        });

        // Nothing good to protect, so the new result wins rather than pinning a
        // stale "not authenticated" that may no longer be true.
        assert.strictEqual(outcome.provider.message, timedOut.message);
        assert.strictEqual(outcome.provider.refreshFailure, undefined);
      });

      it("never leaks the indeterminate input flag onto a published snapshot", () => {
        for (const consecutiveFailures of [0, INDETERMINATE_TOLERANCE + 1]) {
          const outcome = resolveIndeterminateSnapshot({
            previous: observed,
            next: timedOut,
            consecutiveFailures,
            now,
          });
          assert.strictEqual(outcome.provider.indeterminate, undefined);
        }
      });
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("drops stale OpenCode models missing from a successful refresh", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
      });

      it("retains stale OpenCode models when a refresh fails", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("classifies pending, logout, uninstall, and reconnect OpenCode inventories", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const pendingProvider = {
          ...previousProvider,
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          version: null,
          models: [],
          message: "OpenCode provider status has not been checked in this session yet.",
        } satisfies ServerProvider;
        const loggedOutProvider = {
          ...previousProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:02:00.000Z",
          models: [],
          message: "OpenCode is available, but it did not report any connected upstream providers.",
        } satisfies ServerProvider;
        const missingProvider = {
          ...previousProvider,
          status: "error",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:03:00.000Z",
          version: null,
          models: [],
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        } satisfies ServerProvider;
        const authoritativeProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:04:00.000Z",
          models: [previousProvider.models[0]!],
        } satisfies ServerProvider;
        const failedProvider = {
          ...authoritativeProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:05:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, pendingProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).models,
          [],
        );
        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, missingProvider).models, []);

        const afterRemoval = mergeProviderSnapshot(previousProvider, authoritativeProvider);
        const afterFailure = mergeProviderSnapshot(afterRemoval, failedProvider);

        assert.deepStrictEqual(afterFailure.models, [authoritativeProvider.models[0]!]);
      });

      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [],
              }),
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it.effect("does not run provider probes during layer construction", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const initialProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "warning",
            enabled: true,
            installed: false,
            auth: { status: "unknown" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: null,
            message: "Checking Codex provider status.",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshCalls = yield* Ref.make(0);
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Effect.never),
              ),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-background-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
            assert.strictEqual(yield* Ref.get(refreshCalls), 0);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it("persists merged provider snapshots for the providers that were refreshed", () => {
        const previousProviders = [
          {
            instanceId: ProviderInstanceId.make("cursor"),
            driver: ProviderDriverKind.make("cursor"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                    booleanDescriptor("fastMode", "Fast Mode"),
                    booleanDescriptor("thinking", "Thinking"),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;
        const refreshedCursor = {
          ...previousProviders[0],
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        const mergedProviders = mergeProviderSnapshots(previousProviders, [refreshedCursor]);
        const persistedProviders = selectProvidersByKind(
          mergedProviders,
          new Set([ProviderDriverKind.make("cursor")]),
        );

        assert.deepStrictEqual(persistedProviders, [
          {
            ...refreshedCursor,
            models: [...previousProviders[0].models],
          },
        ]);
      });

      it.effect("persists the merged snapshot when a live update has empty models", () =>
        Effect.gen(function* () {
          const cursorDriver = ProviderDriverKind.make("cursor");
          const cursorInstanceId = ProviderInstanceId.make("cursor");
          const initialProvider = {
            instanceId: cursorInstanceId,
            driver: cursorDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:01:00.000Z",
            models: [],
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: cursorInstanceId,
            driverKind: cursorDriver,
            continuationIdentity: {
              driverKind: cursorDriver,
              continuationKey: "cursor:instance:cursor",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: cursorDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: cursorInstanceId,
            });

            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              ...initialProvider.models,
            ]);
            yield* PubSub.publish(changes, refreshedProvider);

            const cachedProvider = yield* awaitCachedProvider(
              filePath,
              (provider) => provider.checkedAt === refreshedProvider.checkedAt,
            );

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
        () =>
          Effect.gen(function* () {
            const openCodeDriver = ProviderDriverKind.make("opencode");
            const openCodeInstanceId = ProviderInstanceId.make("opencode");
            const initialProvider = {
              instanceId: openCodeInstanceId,
              driver: openCodeDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-07-17T00:00:00.000Z",
              version: "1.0.0",
              models: [
                {
                  slug: "github/gpt-5",
                  name: "GPT-5",
                  subProvider: "GitHub",
                  isCustom: false,
                  capabilities: null,
                },
                {
                  slug: "removed-plugin/model",
                  name: "Removed Plugin Model",
                  subProvider: "Removed Plugin",
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const authoritativeProvider = {
              ...initialProvider,
              checkedAt: "2026-07-17T00:01:00.000Z",
              models: [initialProvider.models[0]!],
            } satisfies ServerProvider;
            const failedProvider = {
              ...authoritativeProvider,
              status: "error",
              auth: { status: "unknown" },
              checkedAt: "2026-07-17T00:02:00.000Z",
              models: [],
              message: "Failed to refresh OpenCode models.",
            } satisfies ServerProvider;
            const changes = yield* PubSub.unbounded<ServerProvider>();
            const instance = {
              instanceId: openCodeInstanceId,
              driverKind: openCodeDriver,
              continuationIdentity: {
                driverKind: openCodeDriver,
                continuationKey: "opencode:instance:opencode",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: openCodeDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(initialProvider),
                refresh: Effect.succeed(authoritativeProvider),
                streamChanges: Stream.fromPubSub(changes),
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const instanceRegistryLayer = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (instanceId) =>
                  Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
                listInstances: Effect.succeed([instance]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                  PubSub.subscribe(pubsub),
                ),
              },
            );
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const runtimeServices = yield* Layer.build(
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-opencode-authoritative-persist-",
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const config = yield* ServerConfig.ServerConfig;
              const filePath = yield* resolveProviderStatusCachePath({
                cacheDir: config.providerStatusCacheDir,
                instanceId: openCodeInstanceId,
              });

              yield* PubSub.publish(changes, authoritativeProvider);

              let cachedProvider = yield* awaitCachedProvider(
                filePath,
                (provider) => provider.checkedAt === authoritativeProvider.checkedAt,
              );

              assert.strictEqual(cachedProvider?.checkedAt, authoritativeProvider.checkedAt);
              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

              yield* PubSub.publish(changes, failedProvider);
              cachedProvider = yield* awaitCachedProvider(
                filePath,
                (provider) => provider.checkedAt === failedProvider.checkedAt,
              );

              assert.strictEqual(cachedProvider?.checkedAt, failedProvider.checkedAt);
              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);
              assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
                authoritativeProvider.models[0]!,
              ]);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("returns the cached provider list when a manual refresh fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("reuses a recent full refresh instead of re-probing every caller", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshCalls = yield* Ref.make(0);
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
                Effect.as(cachedProvider),
              ),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-if-stale-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            // Construction already forked a probe for every managed instance,
            // so a client connecting right after boot must not start a second
            // round of them.
            yield* registry.refreshIfStale();
            assert.strictEqual(yield* Ref.get(refreshCalls), 0);

            yield* TestClock.adjust(Duration.seconds(61));
            yield* registry.refreshIfStale();
            assert.strictEqual(yield* Ref.get(refreshCalls), 1);

            yield* registry.refreshIfStale();
            assert.strictEqual(yield* Ref.get(refreshCalls), 1);

            // An explicit refresh is user intent and always re-probes.
            yield* registry.refresh();
            assert.strictEqual(yield* Ref.get(refreshCalls), 2);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("collapses a burst of concurrent stale refreshes into one", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshCalls = yield* Ref.make(0);
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              // Suspends so a second caller can reach the staleness check
              // while the first refresh is still in flight.
              refresh: Effect.yieldNow.pipe(
                Effect.andThen(Ref.update(refreshCalls, (count) => count + 1)),
                Effect.as(cachedProvider),
              ),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-burst-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            // Past the boot window, so these are genuinely stale rather than
            // covered by the probes construction already forked.
            yield* TestClock.adjust(Duration.seconds(61));

            // Several clients connecting at once all see the same stale
            // timestamp. Only the first may probe; the rest reuse its result.
            yield* Effect.all(
              [registry.refreshIfStale(), registry.refreshIfStale(), registry.refreshIfStale()],
              { concurrency: "unbounded" },
            );

            assert.strictEqual(yield* Ref.get(refreshCalls), 1);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const codexProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = () => Effect.yieldNow;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === instanceId),
                  ),
                ),
              listInstances: Effect.gen(function* () {
                const shouldFail = yield* Ref.get(failNextList);
                if (shouldFail) {
                  yield* Ref.set(failNextList, false);
                  return yield* Effect.die(new Error("simulated registry list failure"));
                }
                return yield* Ref.get(instancesRef);
              }),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait();
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // This test intentionally avoids `mockCommandSpawnerLayer` so the real
      // `probeCodexAppServerProvider` path runs — including the full
      // `codex app-server` RPC handshake via `CodexClient.layerChildProcess`.
      // We point `binaryPath` at a name that cannot exist on any machine so
      // the real `ChildProcessSpawner` deterministically returns ENOENT; the
      // probe wraps that as `CodexAppServerSpawnError` and
      // `checkCodexProviderStatus` turns it into the user-visible "not
      // installed" error snapshot. If the aggregator's `syncLiveSources`
      // breaks — the `codex_personal`-never-probes bug we are guarding
      // against — that snapshot never lands in `getProviders` and the
      // assertions below fail.
      it.effect("propagates real Codex probe failures to the aggregator at boot", () =>
        Effect.gen(function* () {
          const missingBinary = `t3code_codex_missing_`;
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  // Disable every built-in probe that would otherwise spawn
                  // on the CI host. `enabled: false` short-circuits each
                  // driver's probe *before* it touches the spawner, so the
                  // test environment stays isolated from the dev
                  // machine's PATH.
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
                // `providerInstances` keys are branded `ProviderInstanceId`;
                // the branded index signature rejects plain string literals
                // at the TS level even though the runtime schema happily
                // accepts + decodes them. Cast the patch to `unknown` so
                // the `Schema.decodeSync` below does the real validation.
                providerInstances: {
                  // Matches the shape the user had in `.t3/dev/settings.json`
                  // when the bug was reported: a custom enabled Codex instance
                  // pointing at a binary the server has to actually spawn.
                  codex_personal: {
                    driver: "codex",
                    displayName: "Codex Personal",
                    enabled: true,
                    config: {
                      binaryPath: missingBinary,
                      homePath: `/tmp/${missingBinary}_home`,
                    },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            // NO spawner mock — `ChildProcessSpawner` is supplied by the
            // outer `NodeServices.layer` on `it.layer(...)` and will
            // genuinely spawn a subprocess. The missing-binary ENOENT is
            // what exercises the same failure mode as a misconfigured
            // production `binaryPath`.
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            let providers = yield* registry.getProviders;
            for (
              let attempts = 0;
              attempts < 50 &&
              providers.find((provider) => provider.instanceId === "codex_personal")?.status !==
                "error";
              attempts += 1
            ) {
              yield* Effect.yieldNow;
              providers = yield* registry.getProviders;
            }
            const codexPersonal = providers.find(
              (provider) => provider.instanceId === "codex_personal",
            );
            assert.notStrictEqual(
              codexPersonal,
              undefined,
              `Expected the aggregator to know about codex_personal; instead saw: ${providers
                .map((provider) => provider.instanceId)
                .join(", ")}`,
            );
            assert.strictEqual(
              codexPersonal?.status,
              "error",
              "Real Codex probe against a missing binary should surface as 'error' in the aggregator",
            );
            assert.strictEqual(codexPersonal?.installed, false);
            assert.strictEqual(
              codexPersonal?.message,
              "Codex CLI (`codex`) is not installed or not on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // Guards the second half of the reported bug: changing
      // `providers.codex.binaryPath` in settings must tear down the live
      // instance and rebuild it so a fresh probe runs with the new binary.
      // This test drives the real settings stream → registry reconcile →
      // aggregator sync pipeline and asserts that `getProviders` reflects
      // the new background probe's outcome.
      //
      it.effect("re-probes when settings change the codex binaryPath", () =>
        Effect.gen(function* () {
          const firstMissing = `t3code_codex_first_`;
          const secondMissing = `t3code_codex_second_`;
          const spawnedCommands: Array<string> = [];
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
              ChildProcessSpawner.make((command) => {
                spawnedCommands.push((command as { readonly command: string }).command);
                return spawner.spawn(command);
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            // Boot-time probe: the default codex instance is enabled with
            // `firstMissing`, so the real spawner yields ENOENT and the
            // snapshot should be `status: "error"`.
            let initialProviders = yield* registry.getProviders;
            for (
              let attempts = 0;
              attempts < 50 &&
              initialProviders.find((provider) => provider.instanceId === "codex")?.status !==
                "error";
              attempts += 1
            ) {
              yield* TestClock.adjust("10 millis");
              yield* Effect.yieldNow;
              initialProviders = yield* registry.getProviders;
            }
            const initialCodex = initialProviders.find(
              (provider) => provider.instanceId === "codex",
            );
            assert.strictEqual(initialCodex?.status, "error");
            assert.strictEqual(initialCodex?.installed, false);
            assert.deepStrictEqual(spawnedCommands, [firstMissing]);

            // Drive a settings change. The Hydration layer's
            // `SettingsWatcherLive` consumes this via `streamChanges`,
            // calls `reconcile`, which rebuilds the codex instance (the
            // envelope changed because `binaryPath` differs → `entryEqual`
            // is false). The registry's `Stream.runForEach(
            // instanceRegistry.streamChanges, () => syncLiveSources)`
            // fires `syncLiveSources`, which subscribes and launches a fresh
            // background refresh on the rebuilt instance.
            yield* serverSettings.updateSettings({
              providers: {
                codex: { enabled: true, binaryPath: secondMissing },
              },
            });

            // Poll until the injected process boundary observes the new
            // executable. This verifies the public settings-to-probe behavior
            // without depending on timestamps assigned by TestClock.
            const refreshed = yield* Effect.gen(function* () {
              for (let attempts = 0; attempts < 200; attempts += 1) {
                const providers = yield* registry.getProviders;
                const codex = providers.find((provider) => provider.instanceId === "codex");
                if (
                  codex !== undefined &&
                  codex.status === "error" &&
                  spawnedCommands.includes(secondMissing)
                ) {
                  return providers;
                }
                yield* TestClock.adjust("50 millis");
                yield* sleepOffTestClock(20);
              }
              return yield* registry.getProviders;
            });

            const reprobedCodex = refreshed.find((provider) => provider.instanceId === "codex");
            assert.deepStrictEqual(spawnedCommands, [firstMissing, secondMissing]);
            assert.strictEqual(reprobedCodex?.status, "error");
            assert.strictEqual(reprobedCodex?.installed, false);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("includes unavailable instance snapshots in getProviders", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps cursor disabled and skips probing when the provider setting is disabled",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              decodeServerSettings(
                deepMerge(encodedDefaultServerSettings, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    cursor: {
                      enabled: false,
                    },
                    grok: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );
            let cursorSpawned = false;
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              ),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-",
                }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  if (command === "cursor-agent") {
                    cursorSpawned = true;
                  }
                  const joined = args.join(" ");
                  if (joined === "--version") {
                    return {
                      stdout: `${command} 1.0.0\n`,
                      stderr: "",
                      code: 0,
                    };
                  }
                  if (joined === "auth status") {
                    return {
                      stdout: '{"authenticated":true}\n',
                      stderr: "",
                      code: 0,
                    };
                  }
                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );
            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const providers = yield* registry.getProviders;
              const cursorProvider = providers.find(
                (provider) => provider.instanceId === ProviderInstanceId.make("cursor"),
              );

              assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
                "claudeAgent",
                "codex",
                "cursor",
                "grok",
                "opencode",
              ]);
              assert.strictEqual(cursorProvider?.enabled, false);
              assert.strictEqual(cursorProvider?.status, "disabled");
              assert.strictEqual(
                cursorProvider?.message,
                "Cursor is disabled in Toolport Studio settings.",
              );
              assert.strictEqual(cursorSpawned, false);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in Toolport Studio settings.");
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns ready and labels Bedrock-backed Claude as authenticated", () =>
        Effect.gen(function* () {
          // Bedrock authenticates via external AWS credentials, so the SDK init
          // reports only `apiProvider` with no subscription or token.
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ apiProvider: "bedrock" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "bedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes Claude Opus 5 on supported Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          const opus5 = status.models.find((model) => model.slug === "claude-opus-5");
          assert.strictEqual(opus5?.name, "Claude Opus 5");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.219\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Opus 5 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-5"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.218 is too old for Claude Opus 5. Upgrade to v2.1.219 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.218\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes Claude Fable 5 on supported Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          const fable5 = status.models.find((model) => model.slug === "claude-fable-5");
          assert.strictEqual(fable5?.name, "Claude Fable 5");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.169\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Fable 5 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-fable-5"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.168 is too old for Claude Fable 5. Upgrade to v2.1.169 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.168\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect(
        "includes Claude Opus 4.7 with xhigh as the default effort on supported versions",
        () =>
          Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities(),
            );
            const opus47 = status.models.find((model) => model.slug === "claude-opus-4-7");
            if (!opus47) {
              assert.fail("Expected Claude Opus 4.7 to be present for Claude Code v2.1.111.");
            }
            if (!opus47.capabilities) {
              assert.fail(
                "Expected Claude Opus 4.7 capabilities to be present for Claude Code v2.1.111.",
              );
            }
            const effortDescriptor = opus47.capabilities.optionDescriptors?.find(
              (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.isDefault)
                : undefined,
              { id: "xhigh", label: "Extra High", isDefault: true },
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "2.1.111\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("hides Claude Opus 4.7 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-7"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.110 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.110\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ subscriptionType: "maxplan" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in full subscription labels", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max Subscription",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max Subscription");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in provider-prefixed subscription names", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns claude auth email from initialization result", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ email: "claude@example.com" }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("runs Claude status probes with the configured CLAUDE_CONFIG_DIR", () => {
        const claudeConfigDir = "/tmp/t3code-claude-home";
        const recorded = recordingMockSpawnerLayer((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
          if (joined === "auth status")
            return {
              stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
              stderr: "",
              code: 0,
            };
          throw new Error(`Unexpected args: ${joined}`);
        });

        return Effect.gen(function* () {
          const path = yield* Path.Path;
          const status = yield* checkClaudeProviderStatus(
            {
              ...defaultClaudeSettings,
              homePath: claudeConfigDir,
            },
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          // `resolveClaudeHomePath` resolves the configured path to absolute, so
          // the POSIX literal above arrives as `C:\tmp\...` on Windows. Compare
          // against the platform's own resolution rather than the raw literal:
          // the point of the test is that `homePath` reaches the probe as
          // `CLAUDE_CONFIG_DIR`, not that the string passes through untouched.
          // Deduplicated rather than compared element-wise: an account-less capabilities probe
          // now falls through to `claude auth status`, so the number of spawns is an
          // implementation detail. What this asserts is that every one of them carries the
          // configured home.
          assert.deepStrictEqual(
            [...new Set(recorded.commands.map((command) => command.env?.CLAUDE_CONFIG_DIR))],
            [path.resolve(claudeConfigDir)],
          );
        }).pipe(Effect.provide(recorded.layer));
      });

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () => {
        const secretStderr = "Something went wrong: secret-token-value";
        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.message, "Claude Agent CLI is installed but failed to run.");
          assert.ok(!(status.message ?? "").includes(secretStderr));
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return {
                  stdout: "",
                  stderr: secretStderr,
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );
      });

      it.effect("falls back to claude auth status when initialization is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
          assert.strictEqual(status.auth.type, "max");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined.includes("--version")) return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined.includes("auth") && joined.includes("status"))
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"claude@example.com","subscriptionType":"max"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when Claude initialization and auth status agree", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Claude is not authenticated. Run `claude auth login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined.includes("--version")) return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined.includes("auth") && joined.includes("status"))
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
