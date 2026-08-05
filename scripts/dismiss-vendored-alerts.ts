#!/usr/bin/env node

// Dismisses Dependabot alerts raised against vendored reference material.
//
// `.repos/` holds upstream repositories vendored as read-only reference for
// coding agents. Git subtree brings the whole tree, manifests and lockfiles
// included, so GitHub's dependency graph indexes them and raises alerts against
// packages this workspace never installs: `.repos/` sits outside the
// pnpm-workspace.yaml globs, nothing resolves those manifests, and AGENTS.md
// forbids application code importing from them.
//
// There is no path exclusion for Dependabot *alerts* — `.github/dependabot.yml`
// configures update pull requests, while the alert list is generated from the
// dependency graph, which indexes every manifest it finds. Dismissal is the
// supported mechanism, and because each upstream sync can surface a fresh batch,
// it needs to be one command rather than a manual pass through the UI.
//
// Alerts outside a vendored prefix are never touched. They are reported instead,
// because those are the ones against code that actually gets installed and run.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { referenceRepos } from "./lib/reference-repos.ts";

/** GitHub caps `dismissed_comment`; a longer body is rejected with HTTP 422. */
export const DISMISSAL_COMMENT_MAX_LENGTH = 280;

export const DISMISSAL_REASON = "not_used";

export const DISMISSAL_COMMENT =
  "Vendored reference under .repos/ - never installed or shipped. Outside the " +
  "pnpm-workspace.yaml globs, so nothing resolves it; AGENTS.md forbids importing " +
  "from it. Advisories against installed deps are handled by the security-floor " +
  "overrides in pnpm-workspace.yaml.";

export interface DependabotAlert {
  readonly number: number;
  readonly manifestPath: string;
  readonly packageName: string;
  readonly severity: string;
}

export interface VendoredAlertPartition {
  /** Raised against vendored reference material; safe to dismiss. */
  readonly vendored: ReadonlyArray<DependabotAlert>;
  /** Everything else — against code that is actually installed. Left alone. */
  readonly other: ReadonlyArray<DependabotAlert>;
}

export class DismissVendoredAlertsCommandError extends Schema.TaggedErrorClass<DismissVendoredAlertsCommandError>()(
  "DismissVendoredAlertsCommandError",
  {
    operation: Schema.Literals(["spawn", "communicate", "exit", "parse"]),
    command: Schema.String,
    argumentCount: Schema.Number,
    exitCode: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub CLI operation "${this.operation}" failed for "${this.command}".`;
  }
}

/** Subtree prefixes, so adding a vendored repo extends coverage automatically. */
export function vendoredPrefixes(): ReadonlyArray<string> {
  return referenceRepos.map((repo) => repo.prefix);
}

/**
 * Whether `manifestPath` sits inside a vendored prefix.
 *
 * Matches on a path boundary rather than a bare `startsWith`, so a sibling
 * directory that merely shares a name stem — `.repos/effect-smol-fork` beside
 * `.repos/effect-smol` — is not swept up by the prefix for its neighbour.
 */
export function isVendoredManifestPath(
  manifestPath: string,
  prefixes: ReadonlyArray<string> = vendoredPrefixes(),
): boolean {
  const normalized = manifestPath.replaceAll("\\", "/");
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

export function partitionVendoredAlerts(
  alerts: ReadonlyArray<DependabotAlert>,
  prefixes: ReadonlyArray<string> = vendoredPrefixes(),
): VendoredAlertPartition {
  const vendored: Array<DependabotAlert> = [];
  const other: Array<DependabotAlert> = [];
  for (const alert of alerts) {
    (isVendoredManifestPath(alert.manifestPath, prefixes) ? vendored : other).push(alert);
  }
  return { vendored, other };
}

export function parseOpenAlerts(payload: string): ReadonlyArray<DependabotAlert> {
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) return [];

  const alerts: Array<DependabotAlert> = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const dependency = record.dependency as Record<string, unknown> | undefined;
    const pkg = dependency?.package as Record<string, unknown> | undefined;
    const advisory = record.security_advisory as Record<string, unknown> | undefined;
    const number = typeof record.number === "number" ? record.number : null;
    const manifestPath =
      typeof dependency?.manifest_path === "string" ? dependency.manifest_path : null;
    if (number === null || manifestPath === null) continue;

    alerts.push({
      number,
      manifestPath,
      packageName: typeof pkg?.name === "string" ? pkg.name : "unknown",
      severity: typeof advisory?.severity === "string" ? advisory.severity : "unknown",
    });
  }
  return alerts;
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runGh = Effect.fn("runGh")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = { command: "gh", argumentCount: args.length } as const;
  const child = yield* spawner
    .spawn(ChildProcess.make("gh", args))
    .pipe(
      Effect.mapError(
        (cause) =>
          new DismissVendoredAlertsCommandError({ ...errorContext, operation: "spawn", cause }),
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DismissVendoredAlertsCommandError({ ...errorContext, operation: "communicate", cause }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new DismissVendoredAlertsCommandError({
      ...errorContext,
      operation: "exit",
      exitCode,
      stderrLength: stderr.length,
    });
  }
  return stdout;
});

export const dismissVendoredAlerts = Effect.fn("dismissVendoredAlerts")(function* (options: {
  readonly dryRun: boolean;
}) {
  const payload = yield* runGh([
    "api",
    "repos/:owner/:repo/dependabot/alerts?state=open",
    "--paginate",
  ]).pipe(Effect.scoped);

  const alerts = yield* Effect.try({
    try: () => parseOpenAlerts(payload),
    catch: (cause) =>
      new DismissVendoredAlertsCommandError({
        operation: "parse",
        command: "gh",
        argumentCount: 3,
        cause,
      }),
  });

  const { vendored, other } = partitionVendoredAlerts(alerts);

  if (other.length > 0) {
    yield* Console.log(
      `${other.length} open alert(s) are NOT vendored and were left untouched — these are against installed code:`,
    );
    for (const alert of other) {
      yield* Console.log(
        `  #${alert.number} ${alert.severity} ${alert.packageName} ${alert.manifestPath}`,
      );
    }
  }

  if (vendored.length === 0) {
    yield* Console.log("No open alerts against vendored reference material.");
    return { dismissed: [] as ReadonlyArray<number>, skipped: other.map((alert) => alert.number) };
  }

  for (const alert of vendored) {
    yield* Console.log(
      `${options.dryRun ? "Would dismiss" : "Dismissing"} #${alert.number} ${alert.packageName} (${alert.manifestPath})`,
    );
    if (options.dryRun) continue;
    yield* runGh([
      "api",
      "-X",
      "PATCH",
      `repos/:owner/:repo/dependabot/alerts/${alert.number}`,
      "-f",
      "state=dismissed",
      "-f",
      `dismissed_reason=${DISMISSAL_REASON}`,
      "-f",
      `dismissed_comment=${DISMISSAL_COMMENT}`,
    ]).pipe(Effect.scoped);
  }

  return {
    dismissed: vendored.map((alert) => alert.number),
    skipped: other.map((alert) => alert.number),
  };
});

export const dismissVendoredAlertsCommand = Command.make(
  "dismiss-vendored-alerts",
  {
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("List the alerts that would be dismissed without calling GitHub."),
      Flag.withDefault(false),
    ),
  },
  ({ dryRun }) => dismissVendoredAlerts({ dryRun }),
).pipe(
  Command.withDescription(
    "Dismiss Dependabot alerts raised against vendored reference material under .repos/.",
  ),
);

if (import.meta.main) {
  Command.run(dismissVendoredAlertsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
