// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  extractBearerToken,
  mergeStudioPreviewIntoRegistry,
  STUDIO_PREVIEW_SECRET_ENV_KEY,
  STUDIO_PREVIEW_SERVER_ID,
  toolportPreviewViaEnv,
  writeStudioToolportPreviewOverlay,
} from "./ToolportPreviewBridge.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("ToolportPreviewBridge", () => {
  it("extracts bearer tokens", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("bearer  xyz  ")).toBe("xyz");
    expect(extractBearerToken("not-a-bearer")).toBeUndefined();
  });

  it("merges Studio preview into an existing registry and enables it on profiles", () => {
    const merged = mergeStudioPreviewIntoRegistry(
      {
        version: 1,
        activeProfileId: "default",
        profiles: [
          { id: "default", name: "Default", enabledServerIds: ["linear-2"] },
          { id: "work", name: "Work", enabledServerIds: [] },
        ],
        servers: [{ id: "linear-2", name: "Linear", transport: "http", url: "https://example" }],
      },
      "http://127.0.0.1:3773/mcp",
    );

    expect(merged.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "linear-2" }),
        expect.objectContaining({
          id: STUDIO_PREVIEW_SERVER_ID,
          transport: "http",
          url: "http://127.0.0.1:3773/mcp",
          source: "studio:preview",
          env: [{ key: STUDIO_PREVIEW_SECRET_ENV_KEY, secret: true }],
        }),
      ]),
    );
    expect(merged.profiles).toEqual([
      expect.objectContaining({
        id: "default",
        enabledServerIds: expect.arrayContaining(["linear-2", STUDIO_PREVIEW_SERVER_ID]),
      }),
      expect.objectContaining({
        id: "work",
        enabledServerIds: [STUDIO_PREVIEW_SERVER_ID],
      }),
    ]);
  });

  it("replaces a stale Studio preview entry instead of duplicating", () => {
    const merged = mergeStudioPreviewIntoRegistry(
      {
        version: 1,
        servers: [
          {
            id: STUDIO_PREVIEW_SERVER_ID,
            name: "old",
            transport: "http",
            url: "http://127.0.0.1:1/mcp",
          },
        ],
        profiles: [
          { id: "default", name: "Default", enabledServerIds: [STUDIO_PREVIEW_SERVER_ID] },
        ],
      },
      "http://127.0.0.1:9999/mcp",
    );
    const previews = (merged.servers as Array<{ id: string; url: string }>).filter(
      (s) => s.id === STUDIO_PREVIEW_SERVER_ID,
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]?.url).toBe("http://127.0.0.1:9999/mcp");
  });

  it("writes overlay + secret env for a session credential", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-preview-bridge-"));
    tempRoots.push(root);
    const userReg = NodePath.join(root, "user-registry.json");
    const overlay = NodePath.join(root, "overlay.json");
    NodeFS.writeFileSync(
      userReg,
      JSON.stringify({
        version: 1,
        profiles: [{ id: "default", name: "Default", enabledServerIds: ["github"] }],
        servers: [{ id: "github", name: "GitHub", transport: "http", url: "https://gh" }],
      }),
    );

    const env = toolportPreviewViaEnv({
      session: {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "ps",
        providerInstanceId: ProviderInstanceId.make("grok"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer session-token-xyz",
      },
      overlayPath: overlay,
      userRegistryPath: userReg,
    });

    expect(env).toMatchObject({
      TOOLPORT_REGISTRY: overlay,
      CONDUIT_REGISTRY: overlay,
      [`TOOLPORT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`]: "session-token-xyz",
      [`CONDUIT_SECRET_${STUDIO_PREVIEW_SECRET_ENV_KEY}`]: "session-token-xyz",
    });
    const written = JSON.parse(NodeFS.readFileSync(overlay, "utf8")) as {
      servers: Array<{ id: string }>;
    };
    expect(written.servers.some((s) => s.id === STUDIO_PREVIEW_SERVER_ID)).toBe(true);
    expect(written.servers.some((s) => s.id === "github")).toBe(true);
  });

  it("returns undefined overlay path when write fails softly", () => {
    // Invalid path components vary by OS; empty endpoint is the reliable soft-fail.
    expect(
      writeStudioToolportPreviewOverlay({
        previewEndpoint: "   ",
        overlayPath: NodePath.join(NodeOS.tmpdir(), "x.json"),
      }),
    ).toBeUndefined();
  });
});
