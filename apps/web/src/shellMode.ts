/**
 * Lightweight shell modes for secondary desktop windows (SOU-395).
 * Pop-outs load the same SPA with `?shell=chat` so we can skip full chrome.
 */

export function isChatOnlyShellHref(
  href: string = typeof window !== "undefined" ? window.location.href : "",
): boolean {
  return /(?:[?#&]|\/)shell=chat(?:&|$)/.test(href) || href.includes("shell=chat");
}

/**
 * Whether *this window* is a chat-only pop-out, decided once from the URL the
 * window was opened with.
 *
 * Captured at module load rather than re-read per call for two reasons. It is
 * consulted on hot render paths (every markdown block asks whether preview is
 * available), and the marker lives in the hash, which routing rewrites — so a
 * live read would flip a pop-out back to "full shell" the moment the user
 * navigated inside it. A window does not change what kind of window it is.
 */
// Read defensively: this runs at import time, and test environments mount
// partial DOMs where `window` exists but `window.location` does not. Throwing
// here would take down every module that transitively imports this one.
const CHAT_ONLY_SHELL_WINDOW = isChatOnlyShellHref(
  typeof window === "undefined" ? "" : (window.location?.href ?? ""),
);

export function isChatOnlyShellWindow(): boolean {
  return CHAT_ONLY_SHELL_WINDOW;
}
