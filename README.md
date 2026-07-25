# Toolport Studio

**One desktop home for Claude, Codex, Cursor, Grok, and the tools around them.**

Toolport Studio turns subscription-backed AI coding CLIs into a cohesive desktop
workspace. Start with a normal conversation, paste screenshots, switch providers
and models, then attach a folder when the work becomes a project.

The goal is not to create separate “chat” and “coding” products. A conversation
starts with as little context as you want and grows into a coding workspace when
you add a project, terminal, preview, source control, or Toolport tools.

> [!IMPORTANT]
> Toolport Studio is an early alpha. Provider support depends on the corresponding
> CLI being installed and authenticated on your machine.

## What works today

- Claude, Codex, Cursor, Grok, and OpenCode provider adapters
- Subscription-backed authentication through installed provider CLIs
- Screenshot and image pasting, including Grok Build conversations
- A curated Recommended model list with the full catalog one click away
- Projects, terminals, previews, source control, and provider switching
- Automatic discovery of the local Toolport gateway
- Toolport-managed MCP servers injected into provider sessions
- Independent Toolport Studio application identity and data directory

## The product model

Toolport Studio has one conversation surface with progressive context:

1. **Start anywhere** — Open the app and talk without choosing a repository.
2. **Choose a provider** — Switch between supported providers without learning a
   different interface for each CLI.
3. **Add context when needed** — Attach a folder, repository, screenshot, file, or
   Toolport tool to the same conversation.
4. **Move into build mode naturally** — Terminals, diffs, previews, approvals, and
   source control appear when the task needs them.

This keeps casual questions lightweight without creating an artificial wall
between asking about code and working on it.

Read [the product foundation](./docs/product/vision.md) for the design principles
and phased roadmap.

## Toolport ecosystem

- [Toolport](https://toolport.app) is the MCP control plane. It gives every
  provider the same governed tools and server configuration.
- [Ceiling](https://ceiling.win) provides provider usage, quota,
  reset-window, spend, and activity intelligence.
- [Toolport Studio](https://toolport.studio) is where conversations, providers,
  projects, tools, and usage context come together.

## Install

Windows alpha builds are published on the
[GitHub Releases page](https://github.com/tsouth89/toolport-studio/releases).
The current builds are not code-signed, so Windows SmartScreen may require
**More info → Run anyway**.

Before opening Studio, install and sign in to the provider CLIs you want to use.
Toolport Studio does not resell model access or convert API keys into subscription
access.

## Development

Some internal package names still use the inherited `@t3tools/*` namespace for
technical continuity (imports, state paths, and release wiring). Product-facing
identity is Toolport Studio.

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm test:desktop-smoke
pnpm build:desktop
pnpm dist:desktop:win:x64
```

See [the documentation index](./docs/README.md) for architecture, provider, and
release details.

## Heritage and license

Toolport Studio is based on the open-source
[T3 Code](https://github.com/pingdotgg/t3code) project (MIT). T3 Code is
ancestry, not an active upstream. Credit to T3 Tools Inc. is permanent.

See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
