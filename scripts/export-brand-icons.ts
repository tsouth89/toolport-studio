#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone deterministic asset generator.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { PNG } from "pngjs";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const checkOnly = process.argv.includes("--check");
const appIconSizes = [16, 32, 48, 64, 128, 256, 512] as const;

function readPng(relativePath: string): PNG {
  return PNG.sync.read(NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath)));
}

function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png, { colorType: 6 });
}

function resize(source: PNG, width: number, height: number): PNG {
  const target = new PNG({ width, height });
  const scaleX = source.width / width;
  const scaleY = source.height / height;

  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceY = (targetY + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const yWeight = sourceY - Math.floor(sourceY);

    for (let targetX = 0; targetX < width; targetX += 1) {
      const sourceX = (targetX + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const xWeight = sourceX - Math.floor(sourceX);
      const targetOffset = (targetY * width + targetX) * 4;
      const samples = [
        { x: x0, y: y0, weight: (1 - xWeight) * (1 - yWeight) },
        { x: x1, y: y0, weight: xWeight * (1 - yWeight) },
        { x: x0, y: y1, weight: (1 - xWeight) * yWeight },
        { x: x1, y: y1, weight: xWeight * yWeight },
      ];

      let alpha = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (const sample of samples) {
        const sourceOffset = (sample.y * source.width + sample.x) * 4;
        const sampleAlpha = source.data[sourceOffset + 3]! / 255;
        const weightedAlpha = sampleAlpha * sample.weight;
        alpha += weightedAlpha;
        red += source.data[sourceOffset]! * weightedAlpha;
        green += source.data[sourceOffset + 1]! * weightedAlpha;
        blue += source.data[sourceOffset + 2]! * weightedAlpha;
      }

      target.data[targetOffset] = alpha > 0 ? Math.round(red / alpha) : 0;
      target.data[targetOffset + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
      target.data[targetOffset + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
      target.data[targetOffset + 3] = Math.round(alpha * 255);
    }
  }

  return target;
}

function center(source: PNG, canvasSize: number): PNG {
  const target = new PNG({ width: canvasSize, height: canvasSize });
  const left = Math.floor((canvasSize - source.width) / 2);
  const top = Math.floor((canvasSize - source.height) / 2);
  PNG.bitblt(source, target, 0, 0, source.width, source.height, left, top);
  return target;
}

function addOutput(outputs: Map<string, Buffer>, relativePath: string, contents: Buffer): void {
  outputs.set(relativePath.replaceAll("\\", "/"), contents);
}

function buildOutputs(): Map<string, Buffer> {
  const outputs = new Map<string, Buffer>();
  const canonical = readPng(BRAND_ASSET_PATHS.canonicalPng);
  if (canonical.width !== 1024 || canonical.height !== 1024) {
    throw new Error("The canonical Toolport Studio raster must be 1024x1024.");
  }

  const renditions = new Map<number, Buffer>();
  for (const size of new Set([...appIconSizes, ...WINDOWS_ICON_SIZES, 180])) {
    renditions.set(size, encodePng(resize(canonical, size, size)));
  }

  for (const size of appIconSizes) {
    addOutput(
      outputs,
      `assets/studio/generated/toolport-studio-app-${size}.png`,
      renditions.get(size)!,
    );
  }

  const desktopIcon = encodePng(center(resize(canonical, 824, 824), 1024));
  addOutput(outputs, BRAND_ASSET_PATHS.desktopPng, desktopIcon);
  addOutput(outputs, BRAND_ASSET_PATHS.webAppleTouchIconPng, renditions.get(180)!);
  addOutput(outputs, BRAND_ASSET_PATHS.webFavicon16Png, renditions.get(16)!);
  addOutput(outputs, BRAND_ASSET_PATHS.webFavicon32Png, renditions.get(32)!);

  const ico = encodePngIco(
    WINDOWS_ICON_SIZES.map((size) => ({ size, contents: renditions.get(size)! })),
  );
  addOutput(outputs, BRAND_ASSET_PATHS.windowsIco, ico);
  addOutput(outputs, BRAND_ASSET_PATHS.webFaviconIco, ico);

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const contents = outputs.get(override.sourceRelativePath);
    if (!contents) {
      throw new Error(`Missing generated web icon: ${override.sourceRelativePath}`);
    }
    addOutput(outputs, override.targetRelativePath, contents);
  }

  addOutput(outputs, "apps/desktop/resources/icon.png", desktopIcon);
  addOutput(outputs, "apps/desktop/resources/icon.ico", ico);
  return outputs;
}

function writeOutputs(outputs: Map<string, Buffer>): void {
  const stale: string[] = [];
  for (const [relativePath, expected] of outputs) {
    const absolutePath = NodePath.join(repositoryRoot, relativePath);
    const current = NodeFS.existsSync(absolutePath) ? NodeFS.readFileSync(absolutePath) : undefined;
    if (current?.equals(expected)) continue;
    stale.push(relativePath);
    if (checkOnly) continue;
    NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
    NodeFS.writeFileSync(absolutePath, expected);
  }

  if (checkOnly && stale.length > 0) {
    throw new Error(`Generated Toolport Studio assets are stale:\n${stale.join("\n")}`);
  }

  console.log(
    checkOnly
      ? `All ${outputs.size} Toolport Studio icon assets are current.`
      : `Updated ${stale.length} of ${outputs.size} Toolport Studio icon assets.`,
  );
}

writeOutputs(buildOutputs());
