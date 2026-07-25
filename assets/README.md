# Toolport Studio icons

Toolport Studio has one product identity across development, nightly, and
production builds. Release channels remain visible in the product name, but the
application, installer, dock, taskbar, splash-screen, and web icons all use the
same approved porthole mark.

The editable vector sources live in `studio/`. The canonical 1024px raster and
its generated platform renditions live in `studio/generated/`.

Run these commands from the repository root:

```sh
pnpm icons:export
pnpm icons:check
```

The exporter is cross-platform. It derives the macOS safe-area PNG, Windows ICO,
web favicons, Apple touch icon, and desktop development resources from the
canonical 1024px raster. It also copies the current web assets into
`apps/web/public`.

When the vector artwork changes, export
`studio/toolport-studio-app-icon.svg` to
`studio/generated/toolport-studio-app-1024.png` at exactly 1024 by 1024 pixels,
then run `pnpm icons:export`. Do not edit smaller generated files directly.

The macOS ICNS checked into `apps/desktop/resources` is a development fallback.
Release packaging creates a fresh ICNS from
`studio/generated/toolport-studio-desktop-1024.png` on macOS.
