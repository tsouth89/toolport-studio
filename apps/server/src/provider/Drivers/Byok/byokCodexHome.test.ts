import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BYOK_CATALOG_FILE_NAME,
  BYOK_CONFIG_FILE_NAME,
  buildCodexConfigToml,
  buildCodexModelCatalog,
  materializeByokCodexHome,
  toTomlString,
} from "./byokCodexHome.ts";
import { findByokPreset, type ByokPreset } from "./byokPresets.ts";

const deepseek = findByokPreset("deepseek")!;

const catalogEntry = (preset: ByokPreset, slug: string) => {
  const entry = buildCodexModelCatalog(preset).models.find((model) => model["slug"] === slug);
  if (!entry) throw new Error(`missing catalog entry for ${slug}`);
  return entry;
};

describe("toTomlString", () => {
  it("escapes backslashes so Windows paths survive a round trip", () => {
    expect(toTomlString("C:\\Users\\me\\.codex")).toBe('"C:\\\\Users\\\\me\\\\.codex"');
  });

  it("escapes embedded quotes", () => {
    expect(toTomlString('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("buildCodexConfigToml", () => {
  const toml = buildCodexConfigToml({
    preset: deepseek,
    modelSlug: "deepseek-v4-flash",
    catalogPath: "C:\\state\\byok\\deepseek\\models.json",
  });

  it("selects the model and its provider block", () => {
    expect(toml).toContain('model = "deepseek-v4-flash"');
    expect(toml).toContain('model_provider = "deepseek"');
    expect(toml).toContain("[model_providers.deepseek]");
    expect(toml).toContain('base_url = "https://api.deepseek.com/"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("names the key's environment variable instead of embedding the key", () => {
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    // Codex's own schema discourages the inline token field.
    expect(toml).not.toContain("experimental_bearer_token");
    expect(toml).not.toContain("sk-");
  });

  it("pins API-key auth so a login prompt cannot hang a headless session", () => {
    expect(toml).toContain('forced_login_method = "api"');
  });

  it("points at the catalog with an escaped absolute path", () => {
    expect(toml).toContain('model_catalog_json = "C:\\\\state\\\\byok\\\\deepseek\\\\models.json"');
  });

  it("seeds the starting effort from the selected model", () => {
    expect(toml).toContain('model_reasoning_effort = "high"');
  });
});

describe("buildCodexModelCatalog", () => {
  it("declares reasoning levels per model rather than per provider", () => {
    // DeepSeek documents pro as temporarily rejecting `low`, so the two
    // models in one preset must not share an effort list.
    expect(
      (
        catalogEntry(deepseek, "deepseek-v4-flash")["supported_reasoning_levels"] as {
          effort: string;
        }[]
      ).map((level) => level.effort),
    ).toEqual(["low", "high", "max"]);
    expect(
      (
        catalogEntry(deepseek, "deepseek-v4-pro")["supported_reasoning_levels"] as {
          effort: string;
        }[]
      ).map((level) => level.effort),
    ).toEqual(["high", "max"]);
  });

  it("leaves service tiers empty so the picker shows no OpenAI tier row", () => {
    const entry = catalogEntry(deepseek, "deepseek-v4-flash");
    expect(entry["service_tiers"]).toEqual([]);
    expect(entry["additional_speed_tiers"]).toEqual([]);
  });

  it("marks a vision-less model text-only", () => {
    const entry = catalogEntry(deepseek, "deepseek-v4-flash");
    expect(entry["input_modalities"]).toEqual(["text"]);
    expect(entry["supports_image_detail_original"]).toBe(false);
  });

  it("carries the real context window", () => {
    expect(catalogEntry(deepseek, "deepseek-v4-flash")["context_window"]).toBe(1_000_000);
  });

  it("populates base_instructions even though the harness ignores it", () => {
    // Required by Codex's schema. Verified unused on the third-party path,
    // but a stub would be dangerous if a future release starts honoring it.
    const instructions = catalogEntry(deepseek, "deepseek-v4-flash")["base_instructions"];
    expect(typeof instructions).toBe("string");
    expect((instructions as string).length).toBeGreaterThan(80);
  });
});

it.layer(NodeServices.layer)("materializeByokCodexHome", (it) => {
  it.effect("writes both files and reports their paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "byok-home-" });
      const homePath = path.join(root, "deepseek");

      const result = yield* materializeByokCodexHome({
        homePath,
        preset: deepseek,
        modelSlug: "deepseek-v4-flash",
      });

      expect(result.configPath).toBe(path.join(homePath, BYOK_CONFIG_FILE_NAME));
      expect(result.catalogPath).toBe(path.join(homePath, BYOK_CATALOG_FILE_NAME));

      const catalog = JSON.parse(yield* fileSystem.readFileString(result.catalogPath)) as {
        models: ReadonlyArray<{ slug: string }>;
      };
      expect(catalog.models.map((model) => model.slug)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
      ]);

      // Codex requires an absolute catalog path, and the config must point at
      // the file we actually wrote.
      const config = yield* fileSystem.readFileString(result.configPath);
      expect(path.isAbsolute(result.catalogPath)).toBe(true);
      expect(config).toContain(toTomlString(result.catalogPath));
    }).pipe(Effect.scoped),
  );

  it.effect("regenerates over an existing home without failing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "byok-home-" });

      yield* materializeByokCodexHome({
        homePath: root,
        preset: deepseek,
        modelSlug: "deepseek-v4-flash",
      });
      const result = yield* materializeByokCodexHome({
        homePath: root,
        preset: deepseek,
        modelSlug: "deepseek-v4-pro",
      });

      const config = yield* fileSystem.readFileString(result.configPath);
      expect(config).toContain('model = "deepseek-v4-pro"');
      expect(config).not.toContain('model = "deepseek-v4-flash"');
    }).pipe(Effect.scoped),
  );
});
