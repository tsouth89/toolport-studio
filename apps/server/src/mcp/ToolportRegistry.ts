// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read Toolport's on-disk registry for Activity MCP status.
 * Toolport remains source of truth for MCP config; Studio only projects it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import {
  describeToolportGatewayResolution,
  resolveToolportGatewayPath,
} from "./McpProviderSession.ts";

const decodeRegistry = Schema.decodeUnknownOption(
  Schema.Struct({
    version: Schema.optional(Schema.Number),
    servers: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        transport: Schema.optional(Schema.String),
        source: Schema.optional(Schema.String),
        command: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
      }),
    ),
    profiles: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          enabledServerIds: Schema.Array(Schema.String),
        }),
      ),
    ),
    activeProfileId: Schema.optional(Schema.String),
  }),
);

export type ToolportMcpServerSnapshot = {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: "http" | "stdio" | "unknown";
  readonly source?: string;
};

export type ToolportMcpInjectionReason =
  | "disabled"
  | "ready"
  | "gateway_not_found"
  | "configured_path_missing";

export type ToolportMcpStatusSnapshot = {
  /**
   * Registry file was found and parsed. When false, servers are empty and the
   * snapshot only carries Studio inject / gateway readiness.
   */
  readonly authoritative: boolean;
  readonly gatewayAvailable: boolean;
  readonly activeProfileId: string | null;
  readonly activeProfileName: string | null;
  readonly servers: ReadonlyArray<ToolportMcpServerSnapshot>;
  readonly injectionEnabled: boolean;
  readonly injectionReady: boolean;
  readonly injectionReason: ToolportMcpInjectionReason;
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toolportDataDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): ReadonlyArray<string> {
  const configured =
    nonEmpty(environment.TOOLPORT_DATA_DIR) ?? nonEmpty(environment.CONDUIT_DATA_DIR);
  if (configured) return [configured];

  if (platform === "win32") {
    const roaming = NodePath.join(homeDirectory, "AppData", "Roaming");
    const local = NodePath.join(homeDirectory, "AppData", "Local");
    return [
      NodePath.join(roaming, "Toolport"),
      NodePath.join(local, "Toolport"),
      NodePath.join(roaming, "Conduit"),
      NodePath.join(local, "Conduit"),
      NodePath.join(roaming, "Toolport-dev"),
      NodePath.join(local, "Toolport-dev"),
      NodePath.join(roaming, "Conduit-dev"),
      NodePath.join(local, "Conduit-dev"),
    ];
  }

  const configDirectory =
    nonEmpty(environment.XDG_CONFIG_HOME) ??
    (platform === "darwin"
      ? NodePath.join(homeDirectory, "Library", "Application Support")
      : NodePath.join(homeDirectory, ".config"));
  return [
    NodePath.join(configDirectory, "Toolport"),
    NodePath.join(configDirectory, "Conduit"),
    NodePath.join(configDirectory, "Toolport-dev"),
    NodePath.join(configDirectory, "Conduit-dev"),
  ];
}

function normalizeTransport(value: string | undefined): "http" | "stdio" | "unknown" {
  const t = value?.trim().toLowerCase();
  if (t === "http" || t === "sse" || t === "streamable-http") return "http";
  if (t === "stdio") return "stdio";
  return "unknown";
}

type RegistryProjection = {
  readonly activeProfileId: string | null;
  readonly activeProfileName: string | null;
  readonly servers: ReadonlyArray<ToolportMcpServerSnapshot>;
};

function readRegistryProjection(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): RegistryProjection | null {
  for (const dataDirectory of toolportDataDirectories(environment, platform, homeDirectory)) {
    const registryPath = NodePath.join(dataDirectory, "registry.json");
    if (!NodeFS.existsSync(registryPath)) {
      continue;
    }
    try {
      const raw = NodeFS.readFileSync(registryPath, "utf8");
      const parsed = decodeRegistry(JSON.parse(raw) as unknown);
      if (parsed._tag === "None") {
        continue;
      }
      const registry = parsed.value;
      const profiles = registry.profiles ?? [];
      const activeProfileId = nonEmpty(registry.activeProfileId) ?? profiles[0]?.id ?? null;
      const activeProfile =
        profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
      const enabledIds = new Set(
        (activeProfile?.enabledServerIds ?? []).map((id) => id.trim().toLowerCase()),
      );

      const servers: ToolportMcpServerSnapshot[] = registry.servers
        .map((server) => {
          const id = server.id.trim();
          const name = server.name.trim() || id;
          if (!id || !name) {
            return null;
          }
          const enabled = enabledIds.size === 0 ? true : enabledIds.has(id.toLowerCase());
          const source = nonEmpty(server.source);
          return {
            id,
            name,
            enabled,
            transport: normalizeTransport(server.transport),
            ...(source ? { source } : {}),
          } satisfies ToolportMcpServerSnapshot;
        })
        .filter((server): server is ToolportMcpServerSnapshot => server !== null);

      return {
        activeProfileId: activeProfile?.id ?? activeProfileId,
        activeProfileName: activeProfile?.name ?? null,
        servers,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Activity MCP status: registry inventory (when present) plus Studio inject /
 * gateway readiness. Returns null only when inject is off and no registry exists
 * (nothing useful to show). Inject-on without a registry still surfaces so the
 * user can see gateway-missing vs ready.
 */
export function readToolportMcpStatusSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): ToolportMcpStatusSnapshot | null {
  const resolution = describeToolportGatewayResolution(environment, platform, homeDirectory);
  const registry = readRegistryProjection(environment, platform, homeDirectory);
  if (!resolution.injectionEnabled && registry === null) {
    return null;
  }

  const gatewayAvailable = resolveToolportGatewayPath(environment, platform, homeDirectory) != null;

  return {
    authoritative: registry !== null,
    gatewayAvailable,
    activeProfileId: registry?.activeProfileId ?? null,
    activeProfileName: registry?.activeProfileName ?? null,
    servers: registry?.servers ?? [],
    injectionEnabled: resolution.injectionEnabled,
    injectionReady: resolution.ready,
    injectionReason: resolution.reason,
  };
}
