import { ProviderDriverKind } from "@toolport-studio/contracts";
import {
  ApiKeyProviderIcon,
  ClaudeAI,
  CursorIcon,
  DeepSeekIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  OpenRouterIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("byok")]: ApiKeyProviderIcon,
};

/**
 * Logos for BYOK presets. One driver serves every API-key provider, so the
 * brand follows the preset rather than the driver kind; without this a
 * DeepSeek instance and a future Kimi instance would render identically.
 */
export const PROVIDER_ICON_BY_BYOK_PRESET: Readonly<Record<string, Icon>> = {
  deepseek: DeepSeekIcon,
  openrouter: OpenRouterIcon,
};

/**
 * Resolve the mark for a provider instance. Prefers the preset's own logo
 * and falls back to the driver's, so a preset we have no artwork for still
 * renders the neutral key rather than nothing.
 */
export function resolveProviderInstanceIcon(input: {
  readonly driverKind: ProviderDriverKind;
  readonly presetId?: string | undefined;
}): Icon | null {
  const presetIcon = input.presetId ? PROVIDER_ICON_BY_BYOK_PRESET[input.presetId] : undefined;
  return presetIcon ?? PROVIDER_ICON_BY_PROVIDER[input.driverKind] ?? null;
}

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isCustom?: boolean | undefined;
  isDefault?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
