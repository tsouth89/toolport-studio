// @effect-diagnostics nodeBuiltinImport:off
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    // Prefer the post-rename leaf; keep legacy Conduit leaves as fallbacks so
    // Studio still finds a gateway that has not migrated yet.
    return [
      NodePath.join(roaming, "Toolport"),
      NodePath.join(roaming, "Conduit"),
      NodePath.join(roaming, "Toolport-dev"),
      NodePath.join(roaming, "Conduit-dev"),
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

function gatewayPathFromManifest(dataDirectory: string): string | undefined {
  const manifestPath = NodePath.join(dataDirectory, "bin", TOOLPORT_GATEWAY_MANIFEST);
  try {
    const parsed = decodeGatewayManifest(NodeFS.readFileSync(manifestPath, "utf8"));
    if (parsed._tag === "None") return undefined;
    const gatewayPath = nonEmpty(parsed.value.path);
    return gatewayPath && NodeFS.existsSync(gatewayPath) ? gatewayPath : undefined;
  } catch {
    return undefined;
  }
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
      if (NodeFS.existsSync(candidate)) return candidate;
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
  if (configured) return configured;

  for (const dataDirectory of toolportDataDirectories(environment, platform, homeDirectory)) {
    const fromManifest = gatewayPathFromManifest(dataDirectory);
    if (fromManifest) return fromManifest;
  }

  return gatewayPathFromSearchPath(environment, platform);
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

function toolportMcpBinding(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): McpProviderBinding | undefined {
  const enabled = nonEmpty(environment.TOOLPORT_STUDIO_TOOLPORT_MCP)?.toLowerCase();
  if (enabled === "0" || enabled === "false" || enabled === "off") return undefined;

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
  return {
    name: TOOLPORT_MCP_SERVER_NAME,
    transport: "stdio",
    command,
    args: [],
    env: { ...toolportStudioClientEnv() },
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
  if (internalSession) {
    bindings.push({
      name: INTERNAL_MCP_SERVER_NAME,
      transport: "http",
      url: internalSession.endpoint,
      headers: {
        Authorization: internalSession.authorizationHeader,
      },
    });
  }

  const toolport = toolportMcpBinding(environment, platform, homeDirectory);
  if (toolport) bindings.push(toolport);
  return bindings;
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
let filteredGrokHomeCleanupRegistered = false;

function filteredGrokHomeFor(realGrokHome: string): string {
  const cached = filteredGrokHomes.get(realGrokHome);
  if (cached && NodeFS.existsSync(cached)) {
    return cached;
  }

  const tempGrokHome = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "toolport-studio-grok-home-"),
  );
  filteredGrokHomes.set(realGrokHome, tempGrokHome);
  if (!filteredGrokHomeCleanupRegistered) {
    filteredGrokHomeCleanupRegistered = true;
    process.once("exit", () => {
      for (const directory of filteredGrokHomes.values()) {
        try {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        } catch {
          // Process-exit cleanup is best-effort.
        }
      }
    });
  }
  return tempGrokHome;
}

/**
 * If `$GROK_HOME/config.toml` (default `~/.grok/config.toml`) defines a Toolport
 * gateway entry, point the child at a temporary `GROK_HOME` whose config has that
 * entry removed and whose auth files are copied from the real home.
 *
 * Studio's session `mcpServers` injection then owns the gateway (client id
 * `toolport-studio`) without fighting the global Grok Build entry (client id
 * `grok`) written by the Toolport desktop app for terminal use.
 *
 * When there is nothing to strip, returns the original environment unchanged.
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
    if (!NodeFS.existsSync(source)) {
      NodeFS.rmSync(destination, { force: true });
      continue;
    }
    try {
      NodeFS.copyFileSync(source, destination);
    } catch {
      // Best-effort: missing auth still allows API-key env auth.
    }
  }

  return {
    ...baseEnvironment,
    GROK_HOME: tempGrokHome,
  };
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
