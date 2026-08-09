import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
} from "@toolport-studio/contracts/settings";

export const DEFAULT_SANS_FONT_STACK =
  '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

export function appearanceFontStack(custom: string, defaultStack: string): string {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

function clampFontSize(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function clampInterfaceFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
}

export function clampPromptFontSize(value: number): number {
  return clampFontSize(value, MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE);
}

export function clampCodeFontSize(value: number): number {
  return clampFontSize(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

export interface AppearanceFontPreferences {
  readonly sans: string;
  readonly code: string;
  readonly composer: string;
  readonly sizeInterface: number;
  readonly sizePrompt: number;
  readonly sizeCode: number;
  readonly smoothing: boolean;
}

export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const families: ReadonlyArray<readonly [string, string, string]> = [
    ["--font-sans", preferences.sans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", preferences.code, DEFAULT_CODE_FONT_STACK],
    ["--font-composer", preferences.composer, "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) root.style.removeProperty(variable);
    else root.style.setProperty(variable, `${list}, ${fallback}`);
  }

  root.style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  root.style.setProperty("--font-size-prompt", `${clampPromptFontSize(preferences.sizePrompt)}px`);
  const codeSize = clampCodeFontSize(preferences.sizeCode);
  root.style.setProperty("--font-size-code", `${codeSize}px`);
  root.style.setProperty("--diffs-font-size", `${codeSize}px`);
  if (preferences.smoothing) root.style.setProperty("-webkit-font-smoothing", "antialiased");
  else root.style.removeProperty("-webkit-font-smoothing");
}
