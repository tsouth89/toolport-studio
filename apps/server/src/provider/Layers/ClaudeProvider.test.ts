import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ClaudeSettings } from "@toolport-studio/contracts";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import { writeFakeProviderCli } from "../../testing/fakeProviderCli.ts";

/**
 * A `claude` stand-in answering the two commands the status check runs: `--version`, so the probe
 * gets past "installed", and `auth status`, the fallback under test. `authStatusStdout: null`
 * makes that fallback exit non-zero, which is the inconclusive case.
 */
const makeFakeClaudeCli = (input: { readonly authStatusStdout: string | null }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-provider-" });
    const binaryPath = yield* writeFakeProviderCli({
      dir,
      name: "claude",
      source: `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2.1.219 (Claude Code)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
${
  input.authStatusStdout === null
    ? `  process.stderr.write("not available\\n");
  process.exit(1);`
    : `  process.stdout.write(${JSON.stringify(input.authStatusStdout)});
  process.exit(0);`
}
}
process.exit(0);
`,
    });
    return { binaryPath, cwd: yield* path.fromFileUrl(new URL(".", import.meta.url)) };
  });

const settingsFor = (binaryPath: string): ClaudeSettings =>
  ({
    enabled: true,
    binaryPath,
    homePath: "",
    customModels: [],
  }) as unknown as ClaudeSettings;

/** What `probeClaudeCapabilities` returns against an empty config dir: no account at all. */
const accountLessProbe = {
  email: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiProvider: undefined,
  slashCommands: [],
};

describe("checkClaudeProviderStatus auth reporting", () => {
  // SOU-527. The capabilities probe starts the Agent SDK and reads its initialization result
  // without sending a request, which succeeds against an empty config directory too. Treating
  // "the probe returned an object" as proof of auth reported a credential-less instance as
  // Authenticated, with the missing account line as the only tell.
  it.effect(
    "reports unauthenticated when no account was seen and auth status says logged out",
    () =>
      Effect.gen(function* () {
        const { binaryPath, cwd } = yield* makeFakeClaudeCli({
          authStatusStdout: JSON.stringify({ loggedIn: false }),
        });
        const provider = yield* checkClaudeProviderStatus(
          settingsFor(binaryPath),
          () => Effect.succeed(accountLessProbe),
          { ...process.env },
          cwd,
        );

        expect(provider).toMatchObject({
          installed: true,
          status: "error",
          auth: { status: "unauthenticated" },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Absence of evidence is not evidence of absence. A probe that saw nothing plus a fallback that
  // could not answer means unknown, not logged out — telling a working instance it is signed out
  // is the worse failure.
  it.effect("reports unknown when no account was seen and auth status is inconclusive", () =>
    Effect.gen(function* () {
      const { binaryPath, cwd } = yield* makeFakeClaudeCli({ authStatusStdout: null });
      const provider = yield* checkClaudeProviderStatus(
        settingsFor(binaryPath),
        () => Effect.succeed(accountLessProbe),
        { ...process.env },
        cwd,
      );

      expect(provider).toMatchObject({
        installed: true,
        status: "warning",
        auth: { status: "unknown" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The case the fix must not regress: an API-key instance populates tokenSource, so it really is
  // authenticated and must still render its label without consulting the fallback. The fake would
  // report logged out if the fallback ran.
  it.effect(
    "reports authenticated with an API key label when the probe carries a token source",
    () =>
      Effect.gen(function* () {
        const { binaryPath, cwd } = yield* makeFakeClaudeCli({
          authStatusStdout: JSON.stringify({ loggedIn: false }),
        });
        const provider = yield* checkClaudeProviderStatus(
          settingsFor(binaryPath),
          () => Effect.succeed({ ...accountLessProbe, tokenSource: "apiKey" }),
          { ...process.env },
          cwd,
        );

        expect(provider).toMatchObject({
          installed: true,
          status: "ready",
          auth: { status: "authenticated", label: "Claude API Key" },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps slash commands from the probe even when auth cannot be confirmed", () =>
    Effect.gen(function* () {
      const { binaryPath, cwd } = yield* makeFakeClaudeCli({ authStatusStdout: null });
      const provider = yield* checkClaudeProviderStatus(
        settingsFor(binaryPath),
        () =>
          Effect.succeed({
            ...accountLessProbe,
            slashCommands: [{ name: "review", description: "Review changes" }],
          }),
        { ...process.env },
        cwd,
      );

      expect(provider.auth).toMatchObject({ status: "unknown" });
      expect(provider.slashCommands.map((command) => command.name)).toEqual(["review"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
