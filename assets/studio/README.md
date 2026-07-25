# Toolport Studio brand assets

Toolport Studio uses a sibling variant of the Toolport porthole rather than an
unrelated mark. The geometry and navy/orange palette remain shared with the
parent brand; Studio moves the orange accent to the portal ring and uses a small
white signal at the center so Toolport and Studio remain distinguishable when
both are pinned to the taskbar. The center stays intentionally geometric and
symbol-free so it remains legible at system-tray sizes.

Source files:

- `toolport-studio-mark.svg` — transparent product mark
- `toolport-studio-app-icon.svg` — full-color application/taskbar tile
- `toolport-studio-tray-dark.svg` — monochrome tray glyph for light chrome
- `toolport-studio-tray-light.svg` — monochrome tray glyph for dark chrome

Generated platform renditions live under `generated/`. Keep the SVG sources as
the editable source of truth and the 1024px application PNG as the canonical
raster companion. Run `pnpm icons:export` after changing that raster so the web,
desktop, dock, taskbar, and installer assets stay synchronized.
