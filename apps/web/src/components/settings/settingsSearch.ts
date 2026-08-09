export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/beta"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/source-control": "Source Control",
  "/settings/connections": "Connections",
  "/settings/beta": "Beta",
  "/settings/archived": "Archived chats",
};

/**
 * Searchable destinations use stable section anchors. Individual controls can
 * share a target when they live in the same compact settings section.
 */
export const SETTINGS_SEARCH_ITEMS = [
  { id: "theme", title: "Theme", to: "/settings/appearance", targetId: "appearance" },
  {
    id: "glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
    targetId: "appearance",
  },
  { id: "general", title: "General", to: "/settings/general" },
  { id: "keybindings", title: "Keybindings", to: "/settings/keybindings" },
  { id: "providers", title: "Providers", to: "/settings/providers" },
  { id: "source-control", title: "Source control", to: "/settings/source-control" },
  {
    id: "connections",
    title: "Connections and network access",
    to: "/settings/connections",
  },
  { id: "beta", title: "Beta features", to: "/settings/beta" },
  { id: "archived", title: "Archived chats", to: "/settings/archived" },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter((item) =>
    normalizeSearchText(`${item.title} ${SETTINGS_SECTION_LABELS[item.to]}`).includes(
      normalizedQuery,
    ),
  );
}
