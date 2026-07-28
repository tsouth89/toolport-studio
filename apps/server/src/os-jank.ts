import { HostProcessEnvironment, HostProcessPlatform } from "@toolport-studio/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@toolport-studio/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

const APP_HOME_DIR_NAME = ".toolport-studio";
/** Pre-rename home directory. See {@link migrateLegacyBaseDir}. */
const LEGACY_APP_HOME_DIR_NAME = ".t3";

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), APP_HOME_DIR_NAME);
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

/**
 * Moves the pre-rename `~/.t3` home to `~/.toolport-studio` once.
 *
 * The home directory holds userdata, secrets, caches and worktrees, so simply
 * pointing at the new name would leave a working install looking empty. This
 * runs only when the new directory does not exist yet and the old one does, so
 * it is a no-op on a fresh install and on every launch after the first.
 *
 * Callers must skip it when the base directory was set explicitly — that
 * choice is the operator's, not something to migrate out from under them.
 *
 * A failed move is reported and swallowed: the data is still intact under the
 * old name, and refusing to start would be a worse outcome than starting
 * empty.
 */
export const migrateLegacyBaseDir = Effect.fn(function* (homeDir?: string) {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const home = homeDir ?? NodeOS.homedir();
  const current = join(home, APP_HOME_DIR_NAME);
  const legacy = join(home, LEGACY_APP_HOME_DIR_NAME);

  if ((yield* fs.exists(current)) || !(yield* fs.exists(legacy))) {
    return false;
  }

  return yield* fs.rename(legacy, current).pipe(
    Effect.as(true),
    Effect.catch((cause) => {
      logPathHydrationWarning(
        `could not move ${legacy} to ${current}; starting with an empty home directory, previous data is untouched:`,
        cause,
      );
      return Effect.succeed(false);
    }),
  );
});
