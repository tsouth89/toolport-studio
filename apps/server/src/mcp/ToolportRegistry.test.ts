// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readToolportMcpStatusSnapshot } from "./ToolportRegistry.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function writeRegistry(home: string, body: unknown, leaf = "Toolport") {
  const dataDir = NodePath.join(home, "AppData", "Roaming", leaf);
  NodeFS.mkdirSync(dataDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dataDir, "registry.json"), JSON.stringify(body));
  return dataDir;
}

describe("readToolportMcpStatusSnapshot", () => {
  it("returns null when no registry exists", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toolport-reg-empty-"));
    tempRoots.push(home);
    expect(
      readToolportMcpStatusSnapshot(
        { TOOLPORT_DATA_DIR: NodePath.join(home, "missing") },
        "win32",
        home,
      ),
    ).toBeNull();
  });

  it("projects enabled servers for the active profile", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toolport-reg-"));
    tempRoots.push(home);
    const dataDir = writeRegistry(home, {
      version: 1,
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "Default",
          enabledServerIds: ["linear-2", "github"],
        },
      ],
      servers: [
        { id: "linear-2", name: "Linear", transport: "http", source: "catalog:curated" },
        { id: "github", name: "GitHub", transport: "http" },
        { id: "expo", name: "expo", transport: "http" },
      ],
    });
    const gateway = NodePath.join(dataDir, "toolport-gateway.exe");
    NodeFS.writeFileSync(gateway, "");

    const snapshot = readToolportMcpStatusSnapshot(
      { TOOLPORT_DATA_DIR: dataDir, TOOLPORT_GATEWAY_PATH: gateway },
      "win32",
      home,
    );

    expect(snapshot).toMatchObject({
      authoritative: true,
      gatewayAvailable: true,
      activeProfileName: "Default",
    });
    expect(snapshot?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "linear-2", name: "Linear", enabled: true }),
        expect.objectContaining({ id: "github", enabled: true }),
        expect.objectContaining({ id: "expo", enabled: false }),
      ]),
    );
  });
});
