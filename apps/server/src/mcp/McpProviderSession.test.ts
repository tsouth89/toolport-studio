// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

it.effect("omits preview MCP until the thread is armed (default)", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        { PATH: "" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toEqual([]);

    McpProviderSession.armPreviewMcpForThread(threadId);
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

it.effect("force-injects preview MCP when TOOLPORT_STUDIO_PREVIEW_MCP=on", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();

    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        { PATH: "", TOOLPORT_STUDIO_PREVIEW_MCP: "on" },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toEqual([expect.objectContaining({ name: "toolport-studio-preview", transport: "http" })]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("adds an explicitly configured Toolport stdio gateway with dual client ids", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();
    McpProviderSession.armPreviewMcpForThread(threadId);

    // Configured path must resolve to a real file (stale overrides no longer inject).
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toolport-studio-gateway-"));
    const gatewayPath = NodePath.join(root, "toolport-gateway.exe");
    NodeFS.writeFileSync(gatewayPath, "");
    const overlayPath = NodePath.join(root, "overlay-registry.json");

    // Toolport inject off → direct preview only (armed fallback).
    expect(
      McpProviderSession.readMcpProviderBindings(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: gatewayPath,
        },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toEqual([expect.objectContaining({ name: "toolport-studio-preview", transport: "http" })]);

    // Toolport inject on → preview rides through gateway (no dual full-schema bind).
    const withToolport = McpProviderSession.readMcpProviderBindings(
      threadId,
      {
        TOOLPORT_GATEWAY_PATH: gatewayPath,
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        TOOLPORT_STUDIO_PREVIEW_REGISTRY: overlayPath,
        TOOLPORT_DATA_DIR: NodePath.join(root, "missing-user-registry"),
      },
      "win32",
      "C:\\Users\\tester",
    );
    expect(withToolport).toHaveLength(1);
    expect(withToolport[0]).toMatchObject({
      name: "toolport",
      transport: "stdio",
      command: gatewayPath,
    });
    expect(withToolport[0]?.transport).toBe("stdio");
    if (withToolport[0]?.transport === "stdio") {
      expect(withToolport[0].env).toMatchObject({
        TOOLPORT_CLIENT_ID: "toolport-studio",
        CONDUIT_CLIENT_ID: "toolport-studio",
        TOOLPORT_REGISTRY: overlayPath,
        TOOLPORT_SECRET_STUDIO_PREVIEW_BEARER: "preview-token",
      });
    }
    expect(withToolport.some((b) => b.name === "toolport-studio-preview")).toBe(false);
    expect(
      McpProviderSession.resolvePreviewMcpDeliveryMode(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: gatewayPath,
          TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("via-toolport");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("via-toolport does not require arm; force-off disables preview entirely", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();
    // Not armed.

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toolport-via-preview-"));
    const gatewayPath = NodePath.join(root, "toolport-gateway.exe");
    NodeFS.writeFileSync(gatewayPath, "");
    const overlayPath = NodePath.join(root, "overlay.json");

    const via = McpProviderSession.readMcpProviderBindings(
      threadId,
      {
        TOOLPORT_GATEWAY_PATH: gatewayPath,
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        TOOLPORT_STUDIO_PREVIEW_REGISTRY: overlayPath,
        TOOLPORT_DATA_DIR: NodePath.join(root, "no-reg"),
      },
      "win32",
      "C:\\Users\\tester",
    );
    expect(via).toHaveLength(1);
    expect(via[0]?.name).toBe("toolport");
    if (via[0]?.transport === "stdio") {
      expect(via[0].env.TOOLPORT_SECRET_STUDIO_PREVIEW_BEARER).toBe("preview-token");
    }
    expect(
      McpProviderSession.resolveEffectivePreviewMcpDelivery(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: gatewayPath,
          TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
          TOOLPORT_STUDIO_PREVIEW_REGISTRY: overlayPath,
          TOOLPORT_DATA_DIR: NodePath.join(root, "no-reg"),
        },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("via-toolport");
    expect(McpProviderSession.mcpBindingCatalogKey(via)).toContain("preview:via");

    const off = McpProviderSession.readMcpProviderBindings(
      threadId,
      {
        TOOLPORT_GATEWAY_PATH: gatewayPath,
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        TOOLPORT_STUDIO_PREVIEW_MCP: "off",
        TOOLPORT_STUDIO_PREVIEW_REGISTRY: overlayPath,
      },
      "win32",
      "C:\\Users\\tester",
    );
    expect(off).toEqual([
      {
        name: "toolport",
        transport: "stdio",
        command: gatewayPath,
        args: [],
        env: {
          TOOLPORT_CLIENT_ID: "toolport-studio",
          CONDUIT_CLIENT_ID: "toolport-studio",
        },
      },
    ]);
    expect(McpProviderSession.mcpBindingCatalogKey(off)).toContain("preview:none");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to direct preview when via-toolport overlay cannot be written", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    setInternalPreviewSession();

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toolport-via-fallback-"));
    const gatewayPath = NodePath.join(root, "toolport-gateway.exe");
    NodeFS.writeFileSync(gatewayPath, "");
    // Point overlay at a path under a file (not a directory) so write fails.
    const notADir = NodePath.join(root, "blocked-as-file");
    NodeFS.writeFileSync(notADir, "x");
    const badOverlay = NodePath.join(notADir, "overlay.json");

    const bindings = McpProviderSession.readMcpProviderBindings(
      threadId,
      {
        TOOLPORT_GATEWAY_PATH: gatewayPath,
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        TOOLPORT_STUDIO_PREVIEW_REGISTRY: badOverlay,
        TOOLPORT_DATA_DIR: NodePath.join(root, "no-reg"),
      },
      "win32",
      "C:\\Users\\tester",
    );

    expect(bindings.map((b) => b.name).toSorted()).toEqual(["toolport", "toolport-studio-preview"]);
    expect(McpProviderSession.mcpBindingCatalogKey(bindings)).toContain("preview:direct");
    expect(
      McpProviderSession.resolveEffectivePreviewMcpDelivery(
        threadId,
        {
          TOOLPORT_GATEWAY_PATH: gatewayPath,
          TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
          TOOLPORT_STUDIO_PREVIEW_REGISTRY: badOverlay,
          TOOLPORT_DATA_DIR: NodePath.join(root, "no-reg"),
        },
        "win32",
        "C:\\Users\\tester",
      ),
    ).toBe("direct");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discovers Toolport's published Windows gateway under the Toolport data leaf", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-home-"),
    );
    const gatewayPath = NodePath.join(homeDirectory, "toolport-gateway-1.9.5.exe");
    NodeFS.writeFileSync(gatewayPath, "");
    const manifestDirectory = NodePath.join(homeDirectory, "AppData", "Roaming", "Toolport", "bin");
    NodeFS.mkdirSync(manifestDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(manifestDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.9.5", path: gatewayPath, size: 0 }),
    );

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      gatewayPath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to the legacy Conduit data leaf when Toolport is absent", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-legacy-"),
    );
    const gatewayPath = NodePath.join(homeDirectory, "toolport-gateway-1.9.4.exe");
    NodeFS.writeFileSync(gatewayPath, "");
    const manifestDirectory = NodePath.join(homeDirectory, "AppData", "Roaming", "Conduit", "bin");
    NodeFS.mkdirSync(manifestDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(manifestDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.9.4", path: gatewayPath, size: 0 }),
    );

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      gatewayPath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to versioned bin gateway when the manifest path is missing", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-stale-manifest-"),
    );
    const binDirectory = NodePath.join(homeDirectory, "AppData", "Roaming", "Toolport", "bin");
    NodeFS.mkdirSync(binDirectory, { recursive: true });
    const stalePath = NodePath.join(binDirectory, "toolport-gateway-missing.exe");
    const livePath = NodePath.join(binDirectory, "toolport-gateway-1.9.7-rc.1.exe");
    NodeFS.writeFileSync(livePath, "");
    NodeFS.writeFileSync(
      NodePath.join(binDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.9.7-rc.1", path: stalePath, size: 0 }),
    );

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      livePath,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finds gateway at Local\\Toolport installer root", () =>
  Effect.sync(() => {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-local-install-"),
    );
    const gatewayPath = NodePath.join(
      homeDirectory,
      "AppData",
      "Local",
      "Toolport",
      "toolport-gateway.exe",
    );
    NodeFS.mkdirSync(NodePath.dirname(gatewayPath), { recursive: true });
    NodeFS.writeFileSync(gatewayPath, "");

    expect(McpProviderSession.resolveToolportGatewayPath({}, "win32", homeDirectory)).toBe(
      gatewayPath,
    );

    // Stale TOOLPORT_GATEWAY_PATH must not block auto-discovery.
    expect(
      McpProviderSession.resolveToolportGatewayPath(
        { TOOLPORT_GATEWAY_PATH: "C:\\missing\\toolport-gateway.exe" },
        "win32",
        homeDirectory,
      ),
    ).toBe(gatewayPath);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("describes injection readiness for diagnostics", () => {
  expect(
    McpProviderSession.describeToolportGatewayResolution({
      TOOLPORT_STUDIO_TOOLPORT_MCP: "off",
    }),
  ).toMatchObject({ injectionEnabled: false, ready: false, reason: "disabled" });

  // Hermetic home: no install leaves, so a dead override surfaces clearly.
  expect(
    McpProviderSession.describeToolportGatewayResolution(
      {
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        TOOLPORT_GATEWAY_PATH: "C:\\missing\\toolport-gateway.exe",
        PATH: "",
      },
      "win32",
      "C:\\Users\\no-toolport-install",
    ),
  ).toMatchObject({
    injectionEnabled: true,
    ready: false,
    reason: "configured_path_missing",
    configuredPath: "C:\\missing\\toolport-gateway.exe",
  });

  // Inject on with empty PATH and no home install → not found (no false ready).
  expect(
    McpProviderSession.describeToolportGatewayResolution(
      {
        TOOLPORT_STUDIO_TOOLPORT_MCP: "on",
        PATH: "",
      },
      "win32",
      "C:\\Users\\no-toolport-install",
    ),
  ).toMatchObject({
    injectionEnabled: true,
    ready: false,
    reason: "gateway_not_found",
  });
});

it("treats unset env as off; explicit on/off/url control injection", () => {
  // Hermetic default: unset env → off (server settings write on/off at boot).
  expect(McpProviderSession.isToolportMcpInjectionEnabled({})).toBe(false);
  expect(
    McpProviderSession.isToolportMcpInjectionEnabled({ TOOLPORT_STUDIO_TOOLPORT_MCP: "on" }),
  ).toBe(true);
  expect(
    McpProviderSession.isToolportMcpInjectionEnabled({
      TOOLPORT_STUDIO_MCP_URL: "http://127.0.0.1:8765/mcp",
    }),
  ).toBe(true);
  expect(
    McpProviderSession.isToolportMcpInjectionEnabled({ TOOLPORT_STUDIO_TOOLPORT_MCP: "off" }),
  ).toBe(false);
});

it.effect("supports Toolport streamable HTTP and an explicit opt-out", () =>
  Effect.sync(() => {
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
  Effect.sync(() => {
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
  Effect.sync(() => {
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "toolport-studio-grok-home-"),
    );
    const grokDir = NodePath.join(homeDirectory, ".grok");
    NodeFS.mkdirSync(grokDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(grokDir, "config.toml"),
      `[mcp_servers.toolport]
command = "toolport-gateway"

[mcp_servers.other]
command = "echo"
`,
      "utf8",
    );
    NodeFS.writeFileSync(NodePath.join(grokDir, "auth.json"), '{"token":"x"}', "utf8");

    const env = McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(env.GROK_HOME).toBeTruthy();
    expect(env.GROK_HOME).not.toBe(grokDir);
    expect(env.GROK_HOME).toBe(NodePath.join(grokDir, ".toolport-studio"));
    const filtered = NodeFS.readFileSync(
      NodePath.join(env.GROK_HOME as string, "config.toml"),
      "utf8",
    );
    expect(filtered).toContain("[mcp_servers.other]");
    expect(filtered).not.toMatch(/mcp_servers\.toolport/);
    expect(NodeFS.existsSync(NodePath.join(env.GROK_HOME as string, "auth.json"))).toBe(true);

    NodeFS.writeFileSync(NodePath.join(grokDir, "auth.json"), '{"token":"refreshed"}', "utf8");
    const refreshedEnv = McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(refreshedEnv.GROK_HOME).toBe(env.GROK_HOME);
    expect(
      NodeFS.readFileSync(NodePath.join(refreshedEnv.GROK_HOME as string, "auth.json"), "utf8"),
    ).toBe('{"token":"refreshed"}');

    const studioAuthPath = NodePath.join(refreshedEnv.GROK_HOME as string, "auth.json");
    NodeFS.writeFileSync(studioAuthPath, '{"token":"studio-refreshed"}', "utf8");
    const futureSeconds = NodeFS.statSync(studioAuthPath).mtimeMs / 1_000 + 5;
    NodeFS.utimesSync(studioAuthPath, futureSeconds, futureSeconds);
    McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(NodeFS.readFileSync(NodePath.join(grokDir, "auth.json"), "utf8")).toBe(
      '{"token":"studio-refreshed"}',
    );

    const durableSessionPath = NodePath.join(
      refreshedEnv.GROK_HOME as string,
      "session-survives-restart.json",
    );
    NodeFS.writeFileSync(durableSessionPath, '{"session":"durable"}', "utf8");
    const repeatedEnv = McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(repeatedEnv.GROK_HOME).toBe(refreshedEnv.GROK_HOME);
    expect(NodeFS.readFileSync(durableSessionPath, "utf8")).toBe('{"session":"durable"}');

    NodeFS.rmSync(NodePath.join(grokDir, "auth.json"));
    const withoutAuthEnv = McpProviderSession.environmentSuppressingGrokConfigToolportGateway(
      { PATH: "/usr/bin", HOME: homeDirectory },
      homeDirectory,
    );
    expect(NodeFS.existsSync(NodePath.join(withoutAuthEnv.GROK_HOME as string, "auth.json"))).toBe(
      false,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recognizes gateway identity by name and command", () =>
  Effect.sync(() => {
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
