/** Pure helpers for sidebar chrome destinations. */

export type SidebarChromeNavId = "providers" | "mcp" | "settings" | "help";

export type SidebarChromeNavKind = "route" | "external" | "toolport";

export type SidebarChromeNavItem = {
  readonly id: SidebarChromeNavId;
  readonly label: string;
  readonly kind: SidebarChromeNavKind;
  readonly target: string;
};

/**
 * Sidebar destinations. The chrome groups providers + MCP under Connections,
 * links Settings directly, and exposes Help from the Settings navigation.
 */
export function resolveSidebarChromeNavItems(): ReadonlyArray<SidebarChromeNavItem> {
  return [
    {
      id: "providers",
      label: "Providers",
      kind: "route",
      target: "/settings/providers",
    },
    {
      id: "mcp",
      label: "MCP servers",
      kind: "toolport",
      // Deep link handled by openToolportApp; target is documentation only.
      target: "toolport://",
    },
    {
      id: "settings",
      label: "Settings",
      kind: "route",
      target: "/settings",
    },
    {
      id: "help",
      label: "Help",
      kind: "external",
      target: "https://toolport.studio",
    },
  ];
}

export function formatSidebarChromeNavAriaLabel(label: string, kind: SidebarChromeNavKind): string {
  if (kind === "toolport") {
    return `${label} (opens Toolport)`;
  }
  return kind === "external" ? `${label} (opens externally)` : label;
}
