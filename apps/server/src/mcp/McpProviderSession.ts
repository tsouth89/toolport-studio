// @effect-diagnostics nodeBuiltinImport:off
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
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

const INTERNAL_MCP_SERVER_NAME = "toolport-studio-preview";
const TOOLPORT_MCP_SERVER_NAME = "toolport";
const TOOLPORT_CLIENT_ID = "toolport-studio";
const TOOLPORT_GATEWAY_MANIFEST = "gateway-manifest.json";
const decodeGatewayManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ path: Schema.String })),
);

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toolportDataDirectories(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): ReadonlyArray<string> {
  const configured = nonEmpty(environment.CONDUIT_DATA_DIR);
  if (configured) return [configured];

  if (platform === "win32") {
    return [NodePath.join(homeDirectory, "AppData", "Roaming", "Conduit")];
  }

  const configDirectory =
    nonEmpty(environment.XDG_CONFIG_HOME) ??
    (platform === "darwin"
      ? NodePath.join(homeDirectory, "Library", "Application Support")
      : NodePath.join(homeDirectory, ".config"));
  return [NodePath.join(configDirectory, "Conduit")];
}

function gatewayPathFromManifest(dataDirectory: string): string | undefined {
  const manifestPath = NodePath.join(dataDirectory, "bin", TOOLPORT_GATEWAY_MANIFEST);
  try {
    const parsed = decodeGatewayManifest(NodeFs.readFileSync(manifestPath, "utf8"));
    if (parsed._tag === "None") return undefined;
    const gatewayPath = nonEmpty(parsed.value.path);
    return gatewayPath && NodeFs.existsSync(gatewayPath) ? gatewayPath : undefined;
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
      ? ["toolport-gateway.exe", "toolport-gateway.cmd", "toolport-gateway.bat"]
      : ["toolport-gateway"];
  for (const directory of searchPath.split(NodePath.delimiter)) {
    const trimmedDirectory = nonEmpty(directory);
    if (!trimmedDirectory) continue;
    for (const executableName of executableNames) {
      const candidate = NodePath.join(trimmedDirectory, executableName);
      if (NodeFs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveToolportGatewayPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOs.homedir(),
): string | undefined {
  const configured = nonEmpty(environment.TOOLPORT_GATEWAY_PATH);
  if (configured) return configured;

  for (const dataDirectory of toolportDataDirectories(environment, platform, homeDirectory)) {
    const fromManifest = gatewayPathFromManifest(dataDirectory);
    if (fromManifest) return fromManifest;
  }

  return gatewayPathFromSearchPath(environment, platform);
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
    env: {
      CONDUIT_CLIENT_ID: TOOLPORT_CLIENT_ID,
    },
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
  platform: NodeJS.Platform = process.platform,
  homeDirectory = NodeOs.homedir(),
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

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
