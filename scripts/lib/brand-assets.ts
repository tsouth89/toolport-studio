export const BRAND_ASSET_PATHS = {
  sourceSvg: "assets/studio/toolport-studio-app-icon.svg",
  canonicalPng: "assets/studio/generated/toolport-studio-app-1024.png",
  desktopPng: "assets/studio/generated/toolport-studio-desktop-1024.png",
  windowsIco: "assets/studio/generated/toolport-studio.ico",
  webFaviconIco: "assets/studio/generated/toolport-studio-web-favicon.ico",
  webFavicon16Png: "assets/studio/generated/toolport-studio-web-favicon-16x16.png",
  webFavicon32Png: "assets/studio/generated/toolport-studio-web-favicon-32x32.png",
  webAppleTouchIconPng: "assets/studio/generated/toolport-studio-web-apple-touch-180.png",

  developmentIosIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  developmentUniversalIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  developmentDesktopIconPng: "assets/studio/generated/toolport-studio-desktop-1024.png",
  developmentWindowsIconIco: "assets/studio/generated/toolport-studio.ico",
  developmentWebFaviconIco: "assets/studio/generated/toolport-studio-web-favicon.ico",
  developmentWebFavicon16Png: "assets/studio/generated/toolport-studio-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/studio/generated/toolport-studio-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng:
    "assets/studio/generated/toolport-studio-web-apple-touch-180.png",

  productionIosIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  productionMacIconPng: "assets/studio/generated/toolport-studio-desktop-1024.png",
  productionLinuxIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  productionWindowsIconIco: "assets/studio/generated/toolport-studio.ico",
  productionWebFaviconIco: "assets/studio/generated/toolport-studio-web-favicon.ico",
  productionWebFavicon16Png: "assets/studio/generated/toolport-studio-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/studio/generated/toolport-studio-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/studio/generated/toolport-studio-web-apple-touch-180.png",

  nightlyIosIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  nightlyMacIconPng: "assets/studio/generated/toolport-studio-desktop-1024.png",
  nightlyLinuxIconPng: "assets/studio/generated/toolport-studio-app-1024.png",
  nightlyWindowsIconIco: "assets/studio/generated/toolport-studio.ico",
  nightlyWebFaviconIco: "assets/studio/generated/toolport-studio-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/studio/generated/toolport-studio-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/studio/generated/toolport-studio-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/studio/generated/toolport-studio-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return version.includes("-nightly.") ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
