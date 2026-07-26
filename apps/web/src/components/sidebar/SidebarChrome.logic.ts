/** Pure helpers for SOU-386 PR4 sidebar chrome. */

export type SidebarChromeNavId = "providers" | "mcp" | "settings" | "help";

export type SidebarChromeNavItem = {
  readonly id: SidebarChromeNavId;
  readonly label: string;
  readonly kind: "route" | "external";
  readonly target: string;
};

/**
 * Mockup-shaped left-rail bottom stack: providers / MCP / settings / help.
 * Routes stay in-app; MCP + Help open the Toolport product surfaces.
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
      kind: "external",
      target: "https://toolport.app",
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

export function formatSidebarChromeNavAriaLabel(label: string, kind: "route" | "external"): string {
  return kind === "external" ? `${label} (opens externally)` : label;
}
