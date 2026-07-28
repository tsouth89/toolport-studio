/** Pure helpers for SOU-386 PR4 sidebar chrome. */

export type SidebarChromeNavId = "providers" | "mcp" | "settings" | "help";

export type SidebarChromeNavKind = "route" | "external" | "toolport";

export type SidebarChromeNavItem = {
  readonly id: SidebarChromeNavId;
  readonly label: string;
  readonly kind: SidebarChromeNavKind;
  readonly target: string;
};

/**
 * Mockup-shaped left-rail bottom stack: providers / MCP / settings / help.
 * Routes stay in-app; MCP launches the installed Toolport app (web fallback);
 * Help opens the Studio site for now.
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
