import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

/**
 * Packages the CLI bundle must NOT inline. Everything else is bundled.
 *
 * The list used to be the other way round — an allowlist of workspace packages —
 * which left every third-party runtime dep external. External deps have to exist
 * on the real filesystem because the WSL backend launches plain `wsl.exe -- node`,
 * which cannot read inside an asar, so the desktop build unpacks
 * `**\/node_modules\/**` wholesale. A staged Windows build measured 22,155
 * unpacked files, of which only 29 were actually native (SOU-467). NSIS install
 * time tracks file count, so those 22,126 pure-JS files were the install cost.
 *
 * Two reasons a package earns a place here:
 *
 * - Native addons. A .node binary cannot be inlined into JS, and must sit on
 *   disk for both the Windows primary and the Linux Node inside WSL.
 * - Bun-only entry points. `@effect/platform-bun` and `@effect/sql-sqlite-bun`
 *   are reached through a runtime-conditional dynamic import and resolve
 *   `bun:sqlite`, which does not exist when bundling for Node.
 */
const externalPackagePrefixes = [
  // Native addons (.node)
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "node-addon-api",
  // Bun-only: dynamically imported, resolves bun:* specifiers
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
];

export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !externalPackagePrefixes.some((prefix) => id.startsWith(prefix));
}

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@toolport-studio/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __TOOLPORT_STUDIO_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __TOOLPORT_STUDIO_BUILD_RELAY_URL__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_RELAY_URL?.trim() ?? "",
        ),
        __TOOLPORT_STUDIO_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __TOOLPORT_STUDIO_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __TOOLPORT_STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __TOOLPORT_STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __TOOLPORT_STUDIO_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.TOOLPORT_STUDIO_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
