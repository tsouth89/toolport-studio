// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

it.effect("adds an explicitly configured Toolport stdio gateway", () =>
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
        env: { CONDUIT_CLIENT_ID: "toolport-studio" },
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discovers Toolport's published Windows gateway manifest", () =>
  Effect.gen(function* () {
    McpProviderSession.clearAllMcpProviderSessions();
    const homeDirectory = mkdtempSync(join(tmpdir(), "toolport-studio-home-"));
    const gatewayPath = join(homeDirectory, "toolport-gateway-1.7.2.exe");
    writeFileSync(gatewayPath, "");
    const manifestDirectory = join(homeDirectory, "AppData", "Roaming", "Conduit", "bin");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
      join(manifestDirectory, "gateway-manifest.json"),
      encodeGatewayManifest({ version: "1.7.2", path: gatewayPath, size: 0 }),
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
