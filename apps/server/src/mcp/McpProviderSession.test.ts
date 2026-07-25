// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpProviderSession from "./McpProviderSession.ts";

const threadId = ThreadId.make("thread-toolport-studio");
const encodeGatewayManifest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      path: Schema.String,
      size: Schema.Number,
    }),
  ),
);

function setInternalPreviewSession(): void {
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make("environment-local"),
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer preview-token",
  });
}

it.effect("returns the internal preview MCP binding without inventing a Toolport install", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        { PATH: "" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toEqual([
      {
        name: "toolport-studio-preview",
        transport: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: { Authorization: "Bearer preview-token" },
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("adds an explicitly configured Toolport stdio gateway with dual client ids", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: "C:\\Program Files\\Toolport\\toolport-gateway.exe",
        },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toEqual([
      expect.objectContaining({ name: "toolport-studio-preview", transport: "http" }),
      {
        name: "toolport",
        transport: "stdio",
        command: "C:\\Program Files\\Toolport\\toolport-gateway.exe",
        args: [],
        env: {
          TOOLPORT_CLIENT_ID: "toolport-studio",
          CONDUIT_CLIENT_ID: "toolport-studio",
        },
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discovers Toolport's published Windows gateway under the Toolport data leaf", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = mkdtempSync(join(tmpdir(), "toolport-studio-home-"));
    const gatewayPath = join(homeDirectory, "toolport-gateway-1.9.5.exe");
    writeFileSync(gatewayPath, "");
    const manifestDirectory = join(homeDirectory, "AppData", "Roaming", "Toolport", "bin");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
      join(manifestDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.9.5", path: gatewayPath, size: 0 }),
    );

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      gatewayPath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to the legacy Conduit data leaf when Toolport is absent", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = mkdtempSync(join(tmpdir(), "toolport-studio-legacy-"));
    const gatewayPath = join(homeDirectory, "toolport-gateway-1.9.4.exe");
    writeFileSync(gatewayPath, "");
    const manifestDirectory = join(homeDirectory, "AppData", "Roaming", "Conduit", "bin");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
      join(manifestDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.9.4", path: gatewayPath, size: 0 }),
    );

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      gatewayPath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("supports Toolport streamable HTTP and an explicit opt-out", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        {
          TOOLPORT_STUDIO_MCP_URL: "http://127.0.0.1:8765/mcp",
          TOOLPORT_STUDIO_MCP_TOKEN: "secret",
        },
        "linux",
        "/home/tester",
      ),
    ).toEqual([
      {
        name: "toolport",
        transport: "http",
        url: "http://127.0.0.1:8765/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    ]);

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: "/usr/local/bin/toolport-gateway",
          TOOLPORT_STUDIO_TOOLPORT_MCP: "off",
        },
        "linux",
        "/home/tester",
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("strips Toolport gateway tables from Grok config.toml", () =>
  Effect.gen(function* () {
    const input = `# comment
model = "grok"

[mcp_servers.toolport]
command = 'C:\\Toolport\\toolport-gateway.exe'

[mcp_servers.toolport.env]
TOOLPORT_CLIENT_ID = "grok"

[mcp_servers.other]
command = "npx"
args = ["-y", "foo"]

[mcp_servers.conduit]
command = "conduit-gateway"
`;
    const stripped = McpProviderSession.stripToolportGatewayTablesFromToml(input);
    expect(stripped).toContain("[mcp_servers.other]");
    expect(stripped).toContain("npx");
    expect(stripped).not.toMatch(/mcp_servers\.toolport/);
    expect(stripped).not.toMatch(/mcp_servers\.conduit/);
    expect(stripped).not.toContain("toolport-gateway");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("points GROK_HOME at a filtered home when a global toolport entry exists", () =>
  Effect.gen(function* () {
    const homeDirectory = mkdtempSync(join(tmpdir(), "toolport-studio-grok-home-"));
    const grokDir = join(homeDirectory, ".grok");
    mkdirSync(grokDir, { recursive: true });
    writeFileSync(
      join(grokDir, "config.toml"),
      `[mcp_servers.toolport]
command = "toolport-gateway"

[mcp_servers.other]
command = "echo"
`,
      "utf8",
    );
    writeFileSync(join(grokDir, "auth.json"), '{"token":"x"}', "utf8");

    const env = McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(env.GROK_HOME).toBeTruthy();
    expect(env.GROK_HOME).not.toBe(grokDir);
    const filtered = readFileSync(join(env.GROK_HOME as string, "config.toml"), "utf8");
    expect(filtered).toContain("[mcp_servers.other]");
    expect(filtered).not.toMatch(/mcp_servers\.toolport/);
    expect(existsSync(join(env.GROK_HOME as string, "auth.json"))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recognizes gateway identity by name and command", () =>
  Effect.gen(function* () {
    expect(McpProviderSession.isToolportGatewayServerName("toolport")).toBe(true);
    expect(McpProviderSession.isToolportGatewayServerName("conduit")).toBe(true);
    expect(McpProviderSession.isToolportGatewayServerName("linear")).toBe(false);
    expect(
      McpProviderSession.isToolportGatewayCommand(
        "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\Toolport\\\\bin\\\\toolport-gateway-1.9.5.exe",
      ),
    ).toBe(true);
    expect(McpProviderSession.isToolportGatewayCommand("npx")).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
