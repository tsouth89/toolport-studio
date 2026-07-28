# Contributing to Toolport Studio

Toolport Studio is early, but thoughtful contributions are welcome.

## Before you start

- Search existing issues and pull requests.
- Open an issue before a large feature, architecture change, or provider
  integration so we can agree on the direction.
- Keep pull requests focused. Separate cleanup from behavior changes when
  possible.
- Never include provider credentials, access tokens, local transcripts, or
  private repository content.

## Good first contributions

- Provider compatibility and authentication fixes
- Windows desktop reliability
- Focused accessibility and interaction improvements
- Documentation and reproducible bug reports
- Tests for provider normalization and packaging behavior

## Pull requests

Explain what changed, why it matters, and how you verified it. Include
screenshots or a short recording for visible interface changes.

Toolport Studio still uses some inherited `@toolport-studio/*`, `T3CODE_*`, and `t3`
identifiers for technical continuity. Do not rename those mechanically across
the repository; migrations need to preserve existing user state and release
paths.

By contributing, you agree that your contribution is provided under the
repository's MIT license.
