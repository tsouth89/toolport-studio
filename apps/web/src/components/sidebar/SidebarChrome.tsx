import { useAtomValue } from "@effect/atom-react";
import {
  BoxesIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ServerIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME, APP_STAGE_LABEL } from "../../branding";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { openToolportApp } from "../../lib/openToolport";
import { cn } from "../../lib/utils";
import { primaryServerConfigAtom } from "../../state/server";
import { resolveSidebarStageBadgeLabel } from "../Sidebar.logic";
import { SidebarStageBackdrop, resolveSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import {
  formatSidebarChromeNavAriaLabel,
  resolveSidebarChromeNavItems,
  type SidebarChromeNavId,
} from "./SidebarChrome.logic";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  newThreadDisabled,
  newThreadShortcutLabel,
  onNewThread,
}: {
  isElectron: boolean;
  newThreadDisabled?: boolean;
  newThreadShortcutLabel?: string | null;
  onNewThread?: () => void;
}) {
  const stageLabel = useSidebarStageLabel();
  const backdropVariant = resolveSidebarStageBackdropVariant(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <SidebarStageBackdrop variant={backdropVariant} />
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop />
      {onNewThread ? (
        <button
          type="button"
          aria-label="New chat without a project"
          className="relative z-10 ml-auto mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-white/80 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={newThreadDisabled}
          onClick={onNewThread}
          title={
            newThreadShortcutLabel
              ? `New chat without a project (${newThreadShortcutLabel})`
              : "New chat without a project"
          }
        >
          <SquarePenIcon className="size-4" />
        </button>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <ToolportStudioMark onBlueprint={onBackdrop} />
      <span
        className={cn(
          "truncate text-sm font-medium tracking-tight drop-shadow-sm",
          onBackdrop ? "text-white" : "text-foreground",
        )}
      >
        {APP_BASE_NAME}
      </span>
    </Link>
  );
}

function useSidebarStageLabel() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveSidebarStageBadgeLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

/**
 * Studio product mark (gear-ring + orange). On the blueprint header the navy
 * fills used to match Toolport's default mark vanish into the blue field —
 * only the orange ring remained. Use a high-contrast on-blueprint palette
 * (light metal + orange) instead of a full invert / plain Toolport wordmark.
 */
function ToolportStudioMark({ onBlueprint = false }: { onBlueprint?: boolean }) {
  const metal = onBlueprint ? "#F4F8FF" : "#1E3A66";
  const hole = onBlueprint ? "#0B1B3A" : "#FFFFFF";
  const ring = "#F97316";
  return (
    <svg
      aria-hidden
      className="size-5 shrink-0"
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <polygon
          id="toolport-studio-sidebar-nut"
          points="0,-24 -20.78,-12 -20.78,12 0,24 20.78,12 20.78,-12"
        />
        <polygon
          id="toolport-studio-sidebar-nut-hole"
          points="0,-10 -8.66,-5 -8.66,5 0,10 8.66,5 8.66,-5"
        />
      </defs>
      {/* Soft plate so the mark reads as a badge on loud blueprint gradients */}
      {onBlueprint ? <circle cx="256" cy="256" r="230" fill="rgb(8 16 40 / 0.42)" /> : null}
      <circle cx="256" cy="256" r="195" fill="none" stroke={ring} strokeWidth="90" />
      <g fill={metal}>
        <use href="#toolport-studio-sidebar-nut" x="256" y="61" />
        <use href="#toolport-studio-sidebar-nut" x="451" y="256" />
        <use href="#toolport-studio-sidebar-nut" x="256" y="451" />
        <use href="#toolport-studio-sidebar-nut" x="61" y="256" />
      </g>
      <g fill={hole}>
        <use href="#toolport-studio-sidebar-nut-hole" x="256" y="61" />
        <use href="#toolport-studio-sidebar-nut-hole" x="451" y="256" />
        <use href="#toolport-studio-sidebar-nut-hole" x="256" y="451" />
        <use href="#toolport-studio-sidebar-nut-hole" x="61" y="256" />
      </g>
      <circle cx="256" cy="256" r="58" fill={metal} />
      {onBlueprint ? <circle cx="256" cy="256" r="28" fill={hole} /> : null}
    </svg>
  );
}

function sidebarChromeNavIcon(id: SidebarChromeNavId) {
  switch (id) {
    case "providers":
      return ServerIcon;
    case "mcp":
      return BoxesIcon;
    case "settings":
      return SettingsIcon;
    case "help":
      return CircleHelpIcon;
  }
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const navItems = resolveSidebarChromeNavItems();
  const connectionItems = navItems.filter((item) => item.id === "providers" || item.id === "mcp");
  const settingsItem = navItems.find((item) => item.id === "settings") ?? null;

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const openExternal = useCallback((url: string) => {
    const api = readLocalApi() ?? ensureLocalApi();
    void api.shell.openExternal(url).catch(() => {
      /* best-effort external nav */
    });
  }, []);

  const handleNav = useCallback(
    (item: (typeof navItems)[number]) => {
      closeMobileSidebar();
      if (item.kind === "toolport") {
        void openToolportApp();
        return;
      }
      if (item.kind === "external") {
        openExternal(item.target);
        return;
      }
      void navigate({ to: item.target });
    },
    [closeMobileSidebar, navigate, openExternal],
  );

  return (
    <SidebarFooter className="gap-1.5 border-t border-sidebar-border/60 p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <Menu>
            <MenuTrigger
              render={
                <SidebarMenuButton
                  size="sm"
                  className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-sidebar-muted-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  aria-label="Open connections"
                />
              }
            >
              <ServerIcon className="size-4 shrink-0 opacity-90" />
              <span className="truncate">Connections</span>
              <ChevronRightIcon className="ml-auto size-3.5 opacity-50" />
            </MenuTrigger>
            <MenuPopup align="end" side="right" className="w-44">
              {connectionItems.map((item) => {
                const Icon = sidebarChromeNavIcon(item.id);
                return (
                  <MenuItem
                    key={item.id}
                    aria-label={formatSidebarChromeNavAriaLabel(item.label, item.kind)}
                    onClick={() => handleNav(item)}
                  >
                    <Icon className="size-4" />
                    <span>{item.label}</span>
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
        </SidebarMenuItem>
        {settingsItem ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-sidebar-muted-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              aria-label={formatSidebarChromeNavAriaLabel(settingsItem.label, settingsItem.kind)}
              onClick={() => handleNav(settingsItem)}
            >
              <SettingsIcon className="size-4 shrink-0 opacity-90" />
              <span className="truncate">{settingsItem.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarFooter>
  );
});
