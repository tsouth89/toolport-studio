// @effect-diagnostics nodeBuiltinImport:off
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@toolport-studio/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import {
  defaultStudioToolportOverlayPath,
  resolveUserToolportRegistryPath,
  STUDIO_PREVIEW_SECRET_ENV_KEY,
  toolportPreviewViaEnv,
  type PreviewMcpDeliveryMode,
} from "./ToolportPreviewBridge.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export type McpProviderBinding =
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    };

export type AcpMcpServerBinding =
  | {
      readonly type: "http";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }
  | {
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    };

/** Studio-owned preview automation MCP (browser control). */
export const INTERNAL_MCP_SERVER_NAME = "toolport-studio-preview";
/**
 * Shared gateway binding name. Matches the name Toolport writes into client
 * configs (`toolport`, legacy `conduit`) so provider-native config merges
 * replace rather than double-register when the key is the same.
 */
export const TOOLPORT_MCP_SERVER_NAME = "toolport";
/** Client id Toolport uses to scope Studio-originated gateway sessions. */
export const TOOLPORT_CLIENT_ID = "toolport-studio";
const TOOLPORT_GATEWAY_MANIFEST = "gateway-manifest.json";
const LEGACY_GATEWAY_ENTRY_NAMES = new Set(["toolport", "conduit"]);
const decodeGatewayManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ path: Schema.String })),
);

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();
/**
 * Threads that should expose Studio browser preview tools via **direct** inject.
 * When Toolport gateway is ready, preview rides through Toolport instead (no
 * arm required — lazy discovery avoids the schema tax). Arm still gates the
 * direct fallback path when the gateway is missing.
 */
const previewMcpArmedThreads = new Set<ThreadId>();

/** Optional Studio state dir so the Toolport registry overlay lands under userdata. */
let studioStateDirectoryForToolportOverlay: string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Point the Toolport preview overlay at Studio's state directory (call at server boot). */
export function setStudioStateDirectoryForToolportOverlay(
  stateDirectory: string | undefined,
): void {
  studioStateDirectoryForToolportOverlay = nonEmpty(stateDirectory);
}

/** True when a server name is Toolport's own gateway entry (current or legacy). */
export function isToolportGatewayServerName(name: string): boolean {
  return LEGACY_GATEWAY_ENTRY_NAMES.has(name.trim().toLowerCase());
}

/** True when a command path looks like the Toolport/Conduit gateway binary. */
export function isToolportGatewayCommand(command: string | undefined): boolean {
  if (!command) return false;
  const lower = command.replace(/\\/g, "/").toLowerCase();
  return lower.includes("toolport-gateway") || lower.includes("conduit-gateway");
}

/**
 * True when a provider-config MCP server is Toolport's gateway (by name or command).
 * Used to suppress global client-config gateway entries when Studio injects its own.
 */
export function isToolportGatewayIdentity(input: {
  readonly name?: string;
  readonly command?: string;
}): boolean {
  if (input.name && isToolportGatewayServerName(input.name)) return true;
  return isToolportGatewayCommand(input.command);
}

function toolportDataDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): ReadonlyArray<string> {
  // Prefer TOOLPORT_DATA_DIR; still honor CONDUIT_DATA_DIR from older installs/docs.
  const configured =
    nonEmpty(environment.TOOLPORT_DATA_DIR) ?? nonEmpty(environment.CONDUIT_DATA_DIR);
  if (configured) return [configured];

  if (platform === "win32") {
    const roaming = NodePath.join(homeDirectory, "AppData", "Roaming");
    const local = NodePath.join(homeDirectory, "AppData", "Local");
    // Prefer the post-rename leaf; keep legacy Conduit leaves as fallbacks so
    // Studio still finds a gateway that has not migrated yet. Local\Toolport is
    // a common installer layout (gateway at the data-dir root, not under bin/).
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

function isUsableGatewayFile(filePath: string): boolean {
  try {
    return NodeFS.existsSync(filePath) && NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function gatewayPathFromManifest(dataDirectory: string): string | undefined {
  const manifestPath = NodePath.join(dataDirectory, "bin", TOOLPORT_GATEWAY_MANIFEST);
  try {
    const parsed = decodeGatewayManifest(NodeFS.readFileSync(manifestPath, "utf8"));
    if (parsed._tag === "None") return undefined;
    const gatewayPath = nonEmpty(parsed.value.path);
    return gatewayPath && isUsableGatewayFile(gatewayPath) ? gatewayPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick an unversioned gateway, else the newest versioned binary in a bin/ leaf
 * (toolport-gateway-1.9.7-rc.1.exe). Covers stale manifest paths after upgrade.
 */
function gatewayPathFromBinDirectory(binDirectory: string): string | undefined {
  try {
    if (!NodeFS.existsSync(binDirectory)) {
      return undefined;
    }
    const preferredNames = [
      "toolport-gateway.exe",
      "toolport-gateway",
      "conduit-gateway.exe",
      "conduit-gateway",
    ];
    for (const name of preferredNames) {
      const candidate = NodePath.join(binDirectory, name);
      if (isUsableGatewayFile(candidate)) {
        return candidate;
      }
    }

    let best: { path: string; mtimeMs: number } | undefined;
    for (const entry of NodeFS.readdirSync(binDirectory)) {
      if (!/^(toolport|conduit)-gateway/i.test(entry)) {
        continue;
      }
      // Skip non-binaries (manifests, text files).
      if (/\.(json|log|txt|md|bak)$/i.test(entry)) {
        continue;
      }
      const candidate = NodePath.join(binDirectory, entry);
      try {
        const stat = NodeFS.statSync(candidate);
        if (!stat.isFile()) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path: candidate, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // ignore unreadable entries
      }
    }
    return best?.path;
  } catch {
    return undefined;
  }
}

function gatewayPathFromDataDirectory(
  dataDirectory: string,
  platform: NodeJS.Platform,
): string | undefined {
  const fromManifest = gatewayPathFromManifest(dataDirectory);
  if (fromManifest) return fromManifest;

  const fromBin = gatewayPathFromBinDirectory(NodePath.join(dataDirectory, "bin"));
  if (fromBin) return fromBin;

  // Installer root: Local\Toolport\toolport-gateway.exe
  const rootNames =
    platform === "win32"
      ? ["toolport-gateway.exe", "conduit-gateway.exe"]
      : ["toolport-gateway", "conduit-gateway"];
  for (const name of rootNames) {
    const candidate = NodePath.join(dataDirectory, name);
    if (isUsableGatewayFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function gatewayPathFromSearchPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const searchPath = nonEmpty(environment.PATH);
  if (!searchPath) return undefined;

  const executableNames =
    platform === "win32"
      ? [
          "toolport-gateway.exe",
          "toolport-gateway.cmd",
          "toolport-gateway.bat",
          "conduit-gateway.exe",
          "conduit-gateway.cmd",
          "conduit-gateway.bat",
        ]
      : ["toolport-gateway", "conduit-gateway"];
  for (const directory of searchPath.split(NodePath.delimiter)) {
    const trimmedDirectory = nonEmpty(directory);
    if (!trimmedDirectory) continue;
    for (const executableName of executableNames) {
      const candidate = NodePath.join(trimmedDirectory, executableName);
      if (isUsableGatewayFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveToolportGatewayPath(
  environment: NodeJS.ProcessEnv = process.env,
  // Pure synchronous resolver; callers can inject a platform for tests.
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): string | undefined {
  const configured = nonEmpty(environment.TOOLPORT_GATEWAY_PATH);
  // Prefer an explicit override when the file exists. A stale/missing override
  // falls through to data-dir discovery so dogfood installs still inject.
  if (configured && isUsableGatewayFile(configured)) {
    return configured;
  }

  for (const dataDirectory of toolportDataDirectories(environment, platform, homeDirectory)) {
    const resolved = gatewayPathFromDataDirectory(dataDirectory, platform);
    if (resolved) return resolved;
  }

  return gatewayPathFromSearchPath(environment, platform);
}

/**
 * Why inject is on but sessions may still lack a toolport binding.
 * Used for boot logs and Activity diagnostics.
 */
export function describeToolportGatewayResolution(
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): {
  readonly injectionEnabled: boolean;
  readonly gatewayPath: string | null;
  readonly configuredPath: string | null;
  readonly ready: boolean;
  readonly reason: "disabled" | "ready" | "gateway_not_found" | "configured_path_missing";
} {
  const injectionEnabled = isToolportMcpInjectionEnabled(environment);
  const configuredPath = nonEmpty(environment.TOOLPORT_GATEWAY_PATH) ?? null;
  if (!injectionEnabled) {
    return {
      injectionEnabled: false,
      gatewayPath: null,
      configuredPath,
      ready: false,
      reason: "disabled",
    };
  }
  const gatewayPath = resolveToolportGatewayPath(environment, platform, homeDirectory) ?? null;
  if (!gatewayPath) {
    // Prefer a specific reason when the only signal is a dead override.
    const reason =
      configuredPath !== null && !isUsableGatewayFile(configuredPath)
        ? "configured_path_missing"
        : "gateway_not_found";
    return {
      injectionEnabled: true,
      gatewayPath: null,
      configuredPath,
      ready: false,
      reason,
    };
  }
  return {
    injectionEnabled: true,
    gatewayPath,
    configuredPath,
    ready: true,
    reason: "ready",
  };
}

/**
 * Env vars written into the Studio-managed gateway spawn so Toolport scopes
 * Studio as its own client. Dual-write TOOLPORT_* + CONDUIT_* so both current
 * and pre-1.9.5 gateways recognize the identity.
 */
export function toolportStudioClientEnv(): Readonly<Record<string, string>> {
  return {
    TOOLPORT_CLIENT_ID: TOOLPORT_CLIENT_ID,
    CONDUIT_CLIENT_ID: TOOLPORT_CLIENT_ID,
  };
}

/**
 * Whether Studio should inject the Toolport gateway into provider sessions.
 *
 * Product default is **on** via server settings (`injectToolportMcpInProviderSessions`),
 * which writes `TOOLPORT_STUDIO_TOOLPORT_MCP=on|off` at server start/update.
 * When the env flag is unset (tests / raw process):
 * - explicit off/false/0 → disabled
 * - explicit on/true/1 → enabled
 * - `TOOLPORT_STUDIO_MCP_URL` set → enabled
 * - otherwise → disabled (safe for hermetic tests)
 */
export function isToolportMcpInjectionEnabled(environment: NodeJS.ProcessEnv): boolean {
  const flag = nonEmpty(environment.TOOLPORT_STUDIO_TOOLPORT_MCP)?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  if (flag === "1" || flag === "true" || flag === "on") {
    return true;
  }
  // Explicit streamable HTTP URL is treated as intentional configuration.
  return Boolean(nonEmpty(environment.TOOLPORT_STUDIO_MCP_URL));
}

/** Sync process env from the server settings toggle (adapters read env at turn start). */
export function applyToolportMcpInjectionEnv(enabled: boolean): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime
  process.env.TOOLPORT_STUDIO_TOOLPORT_MCP = enabled ? "on" : "off";
}

/**
 * Whether direct or via-Toolport preview is allowed for this thread.
 *
 * - `TOOLPORT_STUDIO_PREVIEW_MCP=off` → never
 * - `TOOLPORT_STUDIO_PREVIEW_MCP=on` → always when session credentials exist
 * - unset → via-Toolport when gateway can carry it (no arm); direct only after arm
 */
export function isPreviewMcpInjectionEnabled(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly toolportCanCarryPreview?: boolean },
): boolean {
  const flag = nonEmpty(environment.TOOLPORT_STUDIO_PREVIEW_MCP)?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  if (flag === "1" || flag === "true" || flag === "on") {
    return true;
  }
  // Via-Toolport is lazy (~900 meta-tool tokens). No need to wait for panel open.
  if (options?.toolportCanCarryPreview) {
    return true;
  }
  return previewMcpArmedThreads.has(threadId);
}

/** Mark a thread so **direct** preview inject is allowed when Toolport is unavailable. */
export function armPreviewMcpForThread(threadId: ThreadId): void {
  previewMcpArmedThreads.add(threadId);
}

export function isPreviewMcpArmedForThread(threadId: ThreadId): boolean {
  return previewMcpArmedThreads.has(threadId);
}

/**
 * Whether Studio can spawn a local Toolport gateway stdio child that we control
 * (registry overlay + secret env). Streamable-HTTP Toolport URLs cannot carry
 * Studio secrets this way — those fall back to direct preview inject.
 */
export function canRoutePreviewViaToolport(
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): boolean {
  if (!isToolportMcpInjectionEnabled(environment)) {
    return false;
  }
  // HTTP remote gateway — cannot inject TOOLPORT_REGISTRY / secret env.
  if (nonEmpty(environment.TOOLPORT_STUDIO_MCP_URL)) {
    return false;
  }
  if (environment.NODE_ENV === "test" && !nonEmpty(environment.TOOLPORT_GATEWAY_PATH)) {
    return false;
  }
  return resolveToolportGatewayPath(environment, platform, homeDirectory) != null;
}

/**
 * Resolve how Studio browser tools reach the provider for this thread.
 * Prefer via-Toolport (lazy) over direct full-schema inject.
 */
export function resolvePreviewMcpDeliveryMode(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): PreviewMcpDeliveryMode {
  const session = readMcpProviderSession(threadId);
  if (!session) {
    return "off";
  }
  const via = canRoutePreviewViaToolport(environment, platform, homeDirectory);
  if (!isPreviewMcpInjectionEnabled(threadId, environment, { toolportCanCarryPreview: via })) {
    return "off";
  }
  return via ? "via-toolport" : "direct";
}

/** Segment separator for {@link mcpBindingCatalogKey}. */
const CATALOG_KEY_SEPARATOR = "\0";
/** Segment prefixes that describe the catalog rather than name a server. */
const CATALOG_KEY_TAG_PREFIXES = ["preview:", "cred:"] as const;

/**
 * Server names encoded in a catalog key.
 *
 * The key mixes server names with tagged segments, and OpenCode needs the names
 * back to disconnect what a rebind dropped. Decoding lives next to the encoder
 * so adding a tag cannot leave a consumer treating it as a server name — which
 * is exactly what a `cred:` segment did when it was added.
 */
export function mcpBindingNamesFromCatalogKey(catalogKey: string): ReadonlySet<string> {
  return new Set(
    catalogKey
      .split(CATALOG_KEY_SEPARATOR)
      .filter(
        (segment) =>
          segment.length > 0 &&
          !CATALOG_KEY_TAG_PREFIXES.some((prefix) => segment.startsWith(prefix)),
      ),
  );
}

/**
 * Short, non-reversible digest of the preview credential a binding set carries.
 * Hashed because catalog keys are logged when an adapter recycles its child.
 */
function previewCredentialDigest(bindings: ReadonlyArray<McpProviderBinding>): string {
  const direct = bindings.find((binding) => binding.name === INTERNAL_MCP_SERVER_NAME);
  const toolport = bindings.find((binding) => binding.name === TOOLPORT_MCP_SERVER_NAME);
  const parts =
    direct?.transport === "http"
      ? [direct.url, direct.headers.Authorization]
      : toolport?.transport === "stdio"
        ? [
            toolport.env.TOOLPORT_REGISTRY,
            toolport.env[`TOOLPORT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`],
          ]
        : [];
  const material = parts.filter((part): part is string => Boolean(part)).join("\0");
  if (!material) return "none";
  return NodeCrypto.createHash("sha256").update(material).digest("hex").slice(0, 12);
}

/**
 * Stable fingerprint for adapter rebind/recycle checks.
 *
 * Includes server names plus whether Toolport carries Studio preview (secret
 * attached), so a silent drop from via-toolport to bare toolport still rebinds.
 *
 * Also includes a digest of the preview endpoint + bearer. Providers bake the
 * bearer into launch-time config (`-c mcp_servers.toolport.env.*`) with no
 * refresh channel, so a credential rotated under a live child — session reaped
 * for inactivity, thread stopped, instance switched — leaves that child holding
 * a revoked token and every `preview_*` call failing 401 forever. Names and
 * lane are identical across a rotation; only the digest moves.
 */
export function mcpBindingCatalogKey(bindings: ReadonlyArray<McpProviderBinding>): string {
  const names = bindings
    .map((binding) => binding.name)
    .toSorted()
    .join(CATALOG_KEY_SEPARATOR);
  const toolport = bindings.find(
    (binding) => binding.name === TOOLPORT_MCP_SERVER_NAME && binding.transport === "stdio",
  );
  const previewVia =
    toolport?.transport === "stdio" &&
    Boolean(toolport.env[`TOOLPORT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`]);
  const hasDirectPreview = bindings.some((binding) => binding.name === INTERNAL_MCP_SERVER_NAME);
  const previewLane = previewVia ? "via" : hasDirectPreview ? "direct" : "none";
  return [names, `preview:${previewLane}`, `cred:${previewCredentialDigest(bindings)}`].join(
    CATALOG_KEY_SEPARATOR,
  );
}

function toolportBindingCarriesPreview(binding: McpProviderBinding | undefined): boolean {
  return (
    binding?.transport === "stdio" &&
    Boolean(binding.env[`TOOLPORT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`])
  );
}

/**
 * Build the Studio-managed Toolport stdio/http binding.
 * When `attachPreviewVia` is true, write the overlay + secret env so preview
 * tools are reachable through lazy discovery.
 */
function toolportMcpBinding(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
  attachPreviewVia: boolean,
): McpProviderBinding | undefined {
  if (!isToolportMcpInjectionEnabled(environment)) {
    return undefined;
  }

  const url = nonEmpty(environment.TOOLPORT_STUDIO_MCP_URL);
  if (url) {
    const token = nonEmpty(environment.TOOLPORT_STUDIO_MCP_TOKEN);
    return {
      name: TOOLPORT_MCP_SERVER_NAME,
      transport: "http",
      url,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }

  // Provider adapter tests intentionally run against hermetic runtime inputs.
  // Only honor an explicit gateway path in that environment; do not let a
  // developer's real Toolport installation alter captured launch options.
  if (environment.NODE_ENV === "test" && !nonEmpty(environment.TOOLPORT_GATEWAY_PATH)) {
    return undefined;
  }

  const command = resolveToolportGatewayPath(environment, platform, homeDirectory);
  if (!command) return undefined;

  const env: Record<string, string> = { ...toolportStudioClientEnv() };
  if (attachPreviewVia) {
    const session = readMcpProviderSession(threadId);
    if (session) {
      const overlayPath =
        nonEmpty(environment.TOOLPORT_STUDIO_PREVIEW_REGISTRY) ??
        defaultStudioToolportOverlayPath(studioStateDirectoryForToolportOverlay, homeDirectory);
      const userRegistryPath = resolveUserToolportRegistryPath(
        environment,
        platform,
        homeDirectory,
      );
      const previewEnv = toolportPreviewViaEnv({
        session,
        overlayPath,
        userRegistryPath,
      });
      if (previewEnv) {
        Object.assign(env, previewEnv);
      }
    }
  }

  return {
    name: TOOLPORT_MCP_SERVER_NAME,
    transport: "stdio",
    command,
    args: [],
    env,
  };
}

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function readMcpProviderBindings(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv = process.env,
  // Pure synchronous resolver; callers can inject a platform for tests.
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): ReadonlyArray<McpProviderBinding> {
  const bindings: Array<McpProviderBinding> = [];
  const internalSession = readMcpProviderSession(threadId);
  const delivery = resolvePreviewMcpDeliveryMode(threadId, environment, platform, homeDirectory);

  const toolport = toolportMcpBinding(
    threadId,
    environment,
    platform,
    homeDirectory,
    delivery === "via-toolport",
  );
  // Never leave "via" half-configured: if overlay/secret setup failed, fall back
  // to direct full-schema inject so browser tools still work in dogfood.
  const previewViaOk = delivery === "via-toolport" && toolportBindingCarriesPreview(toolport);
  const useDirectPreview =
    Boolean(internalSession) &&
    (delivery === "direct" || (delivery === "via-toolport" && !previewViaOk));

  if (useDirectPreview && internalSession) {
    bindings.push({
      name: INTERNAL_MCP_SERVER_NAME,
      transport: "http",
      url: internalSession.endpoint,
      headers: {
        Authorization: internalSession.authorizationHeader,
      },
    });
  }

  if (toolport) bindings.push(toolport);
  return bindings;
}

/**
 * Effective preview delivery after fallthrough (for diagnostics / Activity).
 * Distinct from {@link resolvePreviewMcpDeliveryMode}, which is intent only.
 */
export function resolveEffectivePreviewMcpDelivery(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOS.homedir(),
): PreviewMcpDeliveryMode {
  const bindings = readMcpProviderBindings(threadId, environment, platform, homeDirectory);
  if (bindings.some((binding) => binding.name === INTERNAL_MCP_SERVER_NAME)) {
    return "direct";
  }
  const toolport = bindings.find((binding) => binding.name === TOOLPORT_MCP_SERVER_NAME);
  if (toolportBindingCarriesPreview(toolport)) {
    return "via-toolport";
  }
  return "off";
}

export function toAcpMcpServers(
  bindings: ReadonlyArray<McpProviderBinding>,
): ReadonlyArray<AcpMcpServerBinding> {
  return bindings.map((binding) =>
    binding.transport === "stdio"
      ? {
          name: binding.name,
          command: binding.command,
          args: binding.args,
          env: Object.entries(binding.env).map(([name, value]) => ({ name, value })),
        }
      : {
          type: "http" as const,
          name: binding.name,
          url: binding.url,
          headers: Object.entries(binding.headers).map(([name, value]) => ({ name, value })),
        },
  );
}

/**
 * Strip Toolport gateway server tables from a Grok/Codex-style TOML config so a
 * Studio-injected `toolport` binding is the only gateway for that session.
 *
 * Removes `[mcp_servers.toolport]` / `[mcp_servers.conduit]` (and dotted-key
 * forms) plus nested `[mcp_servers.<name>.env]` tables. Leaves all other MCP
 * servers and non-MCP config intact so terminal-oriented entries still work
 * outside Studio.
 */
export function stripToolportGatewayTablesFromToml(toml: string): string {
  const lines = toml.split(/\r?\n/);
  const out: Array<string> = [];
  let skipping = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const table = header[1]?.trim().toLowerCase() ?? "";
      // [mcp_servers.toolport], [mcp_servers.conduit], [mcp_servers.toolport.env], …
      const gatewayTable = /^mcp_servers\.(toolport|conduit)(\.|$)/.test(table);
      skipping = gatewayTable;
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }

  // Collapse runs of blank lines left by removals.
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n");
}

const GROK_HOME_AUTH_FILES = ["auth.json", "mcp_credentials.json", "credentials.json"] as const;
const filteredGrokHomes = new Map<string, string>();
const TOOLPORT_STUDIO_GROK_HOME_DIRECTORY = ".toolport-studio";

function filteredGrokHomeFor(realGrokHome: string): string {
  const cached = filteredGrokHomes.get(realGrokHome);
  if (cached && NodeFS.existsSync(cached)) {
    return cached;
  }

  const persistentGrokHome = NodePath.join(realGrokHome, TOOLPORT_STUDIO_GROK_HOME_DIRECTORY);
  try {
    NodeFS.mkdirSync(persistentGrokHome, { recursive: true, mode: 0o700 });
    filteredGrokHomes.set(realGrokHome, persistentGrokHome);
    return persistentGrokHome;
  } catch {
    // Read-only/custom Grok homes still need a usable isolation fallback.
    const tempGrokHome = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-grok-home-"),
    );
    filteredGrokHomes.set(realGrokHome, tempGrokHome);
    return tempGrokHome;
  }
}

function synchronizeGrokAuthFile(realPath: string, studioPath: string): void {
  if (!NodeFS.existsSync(realPath)) {
    NodeFS.rmSync(studioPath, { force: true });
    return;
  }
  try {
    if (
      NodeFS.existsSync(studioPath) &&
      NodeFS.statSync(studioPath).mtimeMs > NodeFS.statSync(realPath).mtimeMs
    ) {
      // Grok refreshed its cached subscription token inside Studio. Persist
      // that newer credential so the next desktop or terminal session reuses it.
      NodeFS.copyFileSync(studioPath, realPath);
      return;
    }
    NodeFS.copyFileSync(realPath, studioPath);
  } catch {
    // Best-effort: missing auth still allows API-key env auth.
  }
}

/**
 * If `$GROK_HOME/config.toml` (default `~/.grok/config.toml`) defines a Toolport
 * gateway entry, point the child at a private persistent `GROK_HOME` whose
 * config has that entry removed and whose auth files track the real home.
 *
 * Studio's session `mcpServers` injection then owns the gateway (client id
 * `toolport-studio`) without fighting the global Grok Build entry (client id
 * `grok`) written by the Toolport desktop app for terminal use.
 *
 * Persistence is intentional: Grok session/load, caches, and subscription auth
 * must survive Studio restarts. When there is nothing to strip, returns the
 * original environment unchanged.
 */
export function environmentSuppressingGrokConfigToolportGateway(
  baseEnvironment: NodeJS.ProcessEnv,
  homeDirectory = NodeOS.homedir(),
): NodeJS.ProcessEnv {
  const realGrokHome = nonEmpty(baseEnvironment.GROK_HOME) ?? NodePath.join(homeDirectory, ".grok");
  const configPath = NodePath.join(realGrokHome, "config.toml");

  let original: string;
  try {
    original = NodeFS.readFileSync(configPath, "utf8");
  } catch {
    return baseEnvironment;
  }

  if (!/^\s*\[mcp_servers\.(toolport|conduit)(\.|\]|\s)/im.test(original)) {
    return baseEnvironment;
  }

  const stripped = stripToolportGatewayTablesFromToml(original);
  if (stripped.trim() === original.trim()) {
    return baseEnvironment;
  }

  const tempGrokHome = filteredGrokHomeFor(realGrokHome);
  NodeFS.writeFileSync(NodePath.join(tempGrokHome, "config.toml"), stripped, "utf8");

  for (const fileName of GROK_HOME_AUTH_FILES) {
    const source = NodePath.join(realGrokHome, fileName);
    const destination = NodePath.join(tempGrokHome, fileName);
    synchronizeGrokAuthFile(source, destination);
  }

  return {
    ...baseEnvironment,
    GROK_HOME: tempGrokHome,
  };
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
  previewMcpArmedThreads.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  previewMcpArmedThreads.clear();
}
