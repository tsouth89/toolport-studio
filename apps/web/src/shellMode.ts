/**
 * Lightweight shell modes for secondary desktop windows (SOU-395).
 * Pop-outs load the same SPA with `?shell=chat` so we can skip full chrome.
 */

export function isChatOnlyShellHref(
  href: string = typeof window !== "undefined" ? window.location.href : "",
): boolean {
  return /(?:[?#&]|\/)shell=chat(?:&|$)/.test(href) || href.includes("shell=chat");
}
