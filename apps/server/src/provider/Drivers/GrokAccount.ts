/**
 * Grok account metadata, read from the CLI's own credential store.
 *
 * Grok signs in through xAI's OAuth and caches the result in
 * `$GROK_HOME/auth.json` (default `~/.grok/auth.json`), keyed by issuer and
 * client id. Alongside the tokens it records the signed-in identity: email,
 * name, and a numeric plan `tier`.
 *
 * Reading it lets the provider card match Codex and Claude, which both show
 * who is signed in. It also turns an inference into a fact: the probe used to
 * conclude "authenticated" purely because an ACP session started.
 *
 * Nothing here touches the tokens themselves. Only the identity fields are
 * read, and the file is treated as untrusted input — any shape that is not
 * what we expect degrades to "no account info" rather than failing the probe.
 *
 * @module provider/Drivers/GrokAccount
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const GROK_HOME_ENV = "GROK_HOME";
export const GROK_AUTH_FILE_NAME = "auth.json";

export interface GrokAccount {
  readonly email: string | undefined;
  readonly planLabel: string | undefined;
}

/**
 * Map xAI's numeric plan tier onto the name users know it by.
 *
 * Only tiers we have confirmed are mapped. An unknown tier deliberately
 * yields no label rather than a guess: a provider card that invents a plan
 * name is worse than one that shows only the account.
 */
export function grokPlanLabelForTier(tier: unknown): string | undefined {
  return tier === 5 ? "SuperGrok Heavy" : undefined;
}

function decodeJwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const payload = segments[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const claims: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    // A malformed or rotated token is not worth failing a status probe over.
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extract the signed-in account from the contents of `auth.json`.
 *
 * The file holds one entry per issuer/client pair. In practice there is a
 * single entry; when there are several we take the first that carries an
 * email, because an entry without one tells the user nothing.
 *
 * The plan tier lives in the access token's claims rather than the entry
 * itself, so it is read from there when present.
 */
export function parseGrokAuthFile(contents: string): GrokAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const entries = Object.values(parsed as Record<string, unknown>).filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  if (entries.length === 0) return undefined;

  const preferred = entries.find((entry) => nonEmptyString(entry["email"]) !== undefined);
  const entry = preferred ?? entries[0];
  if (!entry) return undefined;

  const email = nonEmptyString(entry["email"]);
  const claims = decodeJwtClaims(entry["key"]);
  const planLabel = grokPlanLabelForTier(claims?.["tier"]);

  if (!email && !planLabel) return undefined;
  return { email, planLabel };
}

/** Resolve `$GROK_HOME/auth.json`, falling back to `~/.grok`. */
export const resolveGrokAuthFilePath = Effect.fn("resolveGrokAuthFilePath")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = environment[GROK_HOME_ENV]?.trim();
  const grokHome = home && home.length > 0 ? home : path.join(NodeOS.homedir(), ".grok");
  return path.join(path.resolve(grokHome), GROK_AUTH_FILE_NAME);
});

/**
 * Best-effort account lookup. A missing or unreadable file is normal (the
 * user may not have signed in yet), so every failure resolves to `undefined`
 * and the caller falls back to reporting authentication without an account.
 */
export const readGrokAccount = Effect.fn("readGrokAccount")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<GrokAccount | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = yield* resolveGrokAuthFilePath(environment);
  const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  return contents.length > 0 ? parseGrokAuthFile(contents) : undefined;
});
