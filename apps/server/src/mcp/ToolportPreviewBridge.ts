// @effect-diagnostics nodeBuiltinImport:off
/**
 * Phase 2: Studio browser preview MCP rides through the Toolport gateway.
 *
 * Why: Direct inject of `toolport-studio-preview` dumps ~14 tool schemas into
 * every provider turn (heavy for Claude). Toolport lazy discovery costs ~900
 * tokens for meta-tools; agents search/call `preview_*` on demand.
 *
 * How:
 * 1. Merge the user's Toolport registry with a Studio-managed HTTP server entry
 *    into a session overlay (`TOOLPORT_REGISTRY`).
 * 2. Pass the per-session Studio MCP bearer via `TOOLPORT_SECRET_STUDIO_PREVIEW_BEARER`
 *    so only Studio-spawned gateways can auth to localhost preview.
 * 3. Providers bind only `toolport` (no second full MCP server) when this path
 *    is active. Direct inject remains the fallback when the gateway is missing.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

/** Stable registry id — matches INTERNAL_MCP_SERVER_NAME for Activity identity. */
export const STUDIO_PREVIEW_SERVER_ID = "toolport-studio-preview";
export const STUDIO_PREVIEW_SERVER_NAME = "Studio Preview";
/** Secret env key on the registry entry; gateway resolves via TOOLPORT_SECRET_*. */
export const STUDIO_PREVIEW_SECRET_ENV_KEY = "STUDIO_PREVIEW_BEARER";
export const STUDIO_PREVIEW_SOURCE = "studio:preview";
export const STUDIO_PREVIEW_OVERLAY_FILE = "toolport-preview-registry.json";

export type PreviewMcpDeliveryMode = "off" | "direct" | "via-toolport";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function extractBearerToken(authorizationHeader: string): string | undefined {
  const trimmed = authorizationHeader.trim();
  if (!trimmed) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() || undefined;
}

/**
 * Find the user's on-disk Toolport registry.json (same search order as Activity).
 */
export function resolveUserToolportRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): string | undefined {
  const configured =
    nonEmpty(environment.TOOLPORT_DATA_DIR) ?? nonEmpty(environment.CONDUIT_DATA_DIR);
  const dataDirectories: string[] = configured
    ? [configured]
    : platform === "win32"
      ? [
          NodePath.join(homeDirectory, "AppData", "Roaming", "Toolport"),
          NodePath.join(homeDirectory, "AppData", "Local", "Toolport"),
          NodePath.join(homeDirectory, "AppData", "Roaming", "Conduit"),
          NodePath.join(homeDirectory, "AppData", "Local", "Conduit"),
          NodePath.join(homeDirectory, "AppData", "Roaming", "Toolport-dev"),
          NodePath.join(homeDirectory, "AppData", "Local", "Toolport-dev"),
          NodePath.join(homeDirectory, "AppData", "Roaming", "Conduit-dev"),
          NodePath.join(homeDirectory, "AppData", "Local", "Conduit-dev"),
        ]
      : (() => {
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
        })();

  for (const dataDirectory of dataDirectories) {
    const registryPath = NodePath.join(dataDirectory, "registry.json");
    try {
      if (NodeFS.existsSync(registryPath) && NodeFS.statSync(registryPath).isFile()) {
        return registryPath;
      }
    } catch {
      // try next leaf
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function studioPreviewServerEntry(endpoint: string): Record<string, unknown> {
  return {
    id: STUDIO_PREVIEW_SERVER_ID,
    name: STUDIO_PREVIEW_SERVER_NAME,
    transport: "http",
    args: [],
    env: [{ key: STUDIO_PREVIEW_SECRET_ENV_KEY, secret: true }],
    url: endpoint,
    source: STUDIO_PREVIEW_SOURCE,
  };
}

/**
 * Merge Studio preview into a Toolport registry document (pure).
 * Always enables the preview server on every profile so Studio-scoped gateways
 * can reach it; other clients without the secret env still fail auth on call.
 */
export function mergeStudioPreviewIntoRegistry(
  rawRegistry: unknown,
  previewEndpoint: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(rawRegistry) ? { ...rawRegistry } : { version: 1 };
  const serversIn: unknown[] = Array.isArray(base.servers) ? base.servers : [];
  const servers = serversIn.filter((server: unknown) => {
    if (!isRecord(server)) return true;
    const id = typeof server.id === "string" ? server.id.trim() : "";
    return id !== STUDIO_PREVIEW_SERVER_ID;
  });
  servers.push(studioPreviewServerEntry(previewEndpoint));
  base.servers = servers;

  const profilesIn: unknown[] = Array.isArray(base.profiles) ? base.profiles : [];
  if (profilesIn.length === 0) {
    base.profiles = [
      {
        id: "default",
        name: "Default",
        enabledServerIds: [STUDIO_PREVIEW_SERVER_ID],
      },
    ];
    if (base.activeProfileId == null) {
      base.activeProfileId = "default";
    }
  } else {
    base.profiles = profilesIn.map((profile: unknown) => {
      if (!isRecord(profile)) return profile;
      const enabled = Array.isArray(profile.enabledServerIds)
        ? profile.enabledServerIds.filter((id): id is string => typeof id === "string")
        : [];
      if (!enabled.includes(STUDIO_PREVIEW_SERVER_ID)) {
        return { ...profile, enabledServerIds: [...enabled, STUDIO_PREVIEW_SERVER_ID] };
      }
      return profile;
    });
  }

  if (base.version == null) {
    base.version = 1;
  }
  return base;
}

/**
 * Load user registry (or empty), merge preview, write Studio overlay.
 * Returns the overlay path when written successfully.
 */
export function writeStudioToolportPreviewOverlay(input: {
  readonly previewEndpoint: string;
  readonly overlayPath: string;
  readonly userRegistryPath?: string | undefined;
}): string | undefined {
  const endpoint = nonEmpty(input.previewEndpoint);
  const overlayPath = nonEmpty(input.overlayPath);
  if (!endpoint || !overlayPath) return undefined;

  let raw: unknown = { version: 1, servers: [], profiles: [] };
  const userPath = nonEmpty(input.userRegistryPath);
  if (userPath) {
    try {
      raw = JSON.parse(NodeFS.readFileSync(userPath, "utf8")) as unknown;
    } catch {
      // Fall through to empty base — preview-only overlay still works.
      raw = { version: 1, servers: [], profiles: [] };
    }
  }

  const merged = mergeStudioPreviewIntoRegistry(raw, endpoint);
  try {
    NodeFS.mkdirSync(NodePath.dirname(overlayPath), { recursive: true });
    const body = `${JSON.stringify(merged, null, 2)}\n`;
    const tmp = `${overlayPath}.${process.pid}.studio-tmp`;
    NodeFS.writeFileSync(tmp, body, { encoding: "utf8" });
    NodeFS.renameSync(tmp, overlayPath);
    return overlayPath;
  } catch {
    return undefined;
  }
}

/**
 * Env injected into the Studio-managed Toolport gateway stdio spawn so preview
 * is reachable through lazy discovery without a second provider MCP binding.
 */
export function toolportPreviewViaEnv(input: {
  readonly session: McpProviderSessionConfig;
  readonly overlayPath: string;
  readonly userRegistryPath?: string | undefined;
}): Readonly<Record<string, string>> | undefined {
  const token = extractBearerToken(input.session.authorizationHeader);
  if (!token) return undefined;

  const written = writeStudioToolportPreviewOverlay({
    previewEndpoint: input.session.endpoint,
    overlayPath: input.overlayPath,
    userRegistryPath: input.userRegistryPath,
  });
  if (!written) return undefined;

  return {
    TOOLPORT_REGISTRY: written,
    CONDUIT_REGISTRY: written,
    [`TOOLPORT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`]: token,
    [`CONDUIT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`]: token,
  };
}

/** Default overlay path under Studio state dir (or ~/.toolport-studio/userdata). */
export function defaultStudioToolportOverlayPath(
  stateDirectory?: string,
  homeDirectory = NodeOS.homedir(),
): string {
  const base =
    nonEmpty(stateDirectory) ?? NodePath.join(homeDirectory, ".toolport-studio", "userdata");
  return NodePath.join(base, STUDIO_PREVIEW_OVERLAY_FILE);
}
