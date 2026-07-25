# Desktop release process

Toolport Studio currently publishes desktop prereleases manually while signing
and updater infrastructure are being established.

## Windows alpha

1. Start from a clean, pushed commit.
2. Build the web, server, and Electron bundles.
3. Build the x64 NSIS artifact with the intended prerelease version.
4. Audit the installer contents for unexpected platform binaries, source maps,
   credentials, and local data.
5. Run the packaged server import/startup check and desktop smoke test.
6. Compute SHA-256 and publish the installer plus blockmap to a GitHub
   prerelease.
7. Verify GitHub's asset digest matches the local checksum.

```powershell
pnpm build:desktop
pnpm exec node scripts/build-desktop-artifact.ts `
  --platform win `
  --target nsis `
  --arch x64 `
  --build-version 0.1.0-alpha.3 `
  --output-dir release/toolport-studio-0.1.0-alpha.3 `
  --skip-build
```

Unsigned alpha installers may trigger Microsoft Defender SmartScreen. Public
stable releases should not be declared until code signing and updater validation
are in place.

## Release scope

The release artifact contains the desktop shell, local server, and web client.
The old T3 marketing, mobile, and hosted relay products are intentionally not
part of Toolport Studio releases.

## Future automation

Before enabling tag-driven releases:

- add Windows code signing
- establish macOS signing and notarization
- produce platform-specific artifacts without cross-platform payloads
- publish update manifests from Toolport Studio's repository
- require smoke checks before release publication
