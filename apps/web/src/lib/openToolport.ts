import { ensureLocalApi, readLocalApi } from "../localApi";

/**
 * Toolport registers the `toolport` desktop scheme (legacy `conduit` still works).
 * A bare `toolport://` launch focuses the installed app; specific routes such as
 * import live under toolport://import?s=… — Studio only needs the app open for
 * MCP management until a native Studio MCP panel exists.
 */
export const TOOLPORT_APP_DEEP_LINK = "toolport://";
export const TOOLPORT_WEB_FALLBACK = "https://toolport.app";

export type OpenToolportResult = "app" | "web" | "failed";

/**
 * Prefer the installed Toolport app via deep link; fall back to the web app
 * when the protocol is unregistered or openExternal rejects.
 */
export async function openToolportApp(): Promise<OpenToolportResult> {
  const api = readLocalApi() ?? ensureLocalApi();

  try {
    await api.shell.openExternal(TOOLPORT_APP_DEEP_LINK);
    return "app";
  } catch {
    // Protocol missing, desktop bridge blocked, or app not installed.
  }

  try {
    await api.shell.openExternal(TOOLPORT_WEB_FALLBACK);
    return "web";
  } catch {
    return "failed";
  }
}
