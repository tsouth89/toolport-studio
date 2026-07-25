import { useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

export function SettingsSidebar() {
  const pathname = useLocation({ select: (location) => location.pathname });

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SettingsSidebarNav pathname={pathname} />
    </>
  );
}
