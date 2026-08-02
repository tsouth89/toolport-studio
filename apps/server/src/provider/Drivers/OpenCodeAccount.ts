/**
 * Which OpenCode subscription is signed in.
 *
 * OpenCode records credentials in `auth.json` under its data directory
 * (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`), keyed by the
 * account it belongs to — `opencode-go` for the OpenCode Go plan, or a model
 * vendor's id when a key was added directly.
 *
 * This is a different question from the one the provider card used to answer.
 * "2 upstream providers connected" counts *model providers OpenCode can
 * reach*, which is not a subscription and not an account, so as a headline it
 * answered something nobody asked.
 *
 * Only the account keys are read. The stored credentials are never touched,
 * and no account name or email is available in that file, so nothing beyond
 * the plan is reported.
 *
 * @module provider/Drivers/OpenCodeAccount
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";
export const OPENCODE_AUTH_FILE_NAME = "auth.json";

/** Account ids we can name. Anything else is shown verbatim. */
const KNOWN_ACCOUNT_LABELS: Readonly<Record<string, string>> = {
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
};

export function openCodeAccountLabel(accountId: string): string {
  return KNOWN_ACCOUNT_LABELS[accountId] ?? accountId;
}

/**
 * Read the signed-in account ids out of `auth.json`.
 *
 * Returns them in file order; callers generally want the first. Any shape
 * other than an object of entries yields an empty list, because a status
 * probe should degrade rather than fail on a file it does not own.
 */
export function parseOpenCodeAuthFile(contents: string): ReadonlyArray<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).filter((key) => key.trim().length > 0);
}

export const resolveOpenCodeAuthFilePath = Effect.fn("resolveOpenCodeAuthFilePath")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const dataHome = environment[XDG_DATA_HOME_ENV]?.trim();
  const base =
    dataHome && dataHome.length > 0
      ? path.join(dataHome, "opencode")
      : path.join(NodeOS.homedir(), ".local", "share", "opencode");
  return path.join(path.resolve(base), OPENCODE_AUTH_FILE_NAME);
});

/**
 * Best-effort lookup of the signed-in subscription label. Undefined when no
 * credential file exists, which is the normal state for a user running
 * OpenCode purely against their own model keys.
 */
export const readOpenCodeAccountLabel = Effect.fn("readOpenCodeAccountLabel")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = yield* resolveOpenCodeAuthFilePath(environment);
  const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  const accountId = parseOpenCodeAuthFile(contents)[0];
  return accountId ? openCodeAccountLabel(accountId) : undefined;
});
