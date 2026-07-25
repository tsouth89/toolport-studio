# Toolport Studio

**One workspace for every AI coding agent.**

Toolport Studio is a desktop workspace for using Codex, Claude, Cursor, Grok,
and OpenCode through their installed subscription-backed CLIs. It combines
conversation, projects, terminals, previews, screenshots, and provider
switching in one application.

Toolport Studio is built on the open-source
[T3 Code](https://github.com/pingdotgg/t3code) project and is currently under
active development.

## Product family

- [Toolport](https://toolport.app) is the MCP control plane. Studio discovers
  its local gateway and makes the same scoped tools available to every provider.
- [Ceiling](https://github.com/tsouth89/ceiling) supplies provider usage,
  quota, reset-window, spend, and activity intelligence.
- [Toolport Studio](https://toolport.studio) is the workspace where those
  providers and tools come together.

## Current foundation

- Subscription-backed Codex, Claude, Cursor, Grok, and OpenCode adapters
- Pasted screenshot and image support for Grok
- Internal preview automation MCP server
- Automatic discovery of Toolport's published gateway on Windows
- Multi-binding MCP injection through stdio or Streamable HTTP
- Stable Toolport client identity: `toolport-studio`

## Development

Toolport Studio uses [Vite+](https://viteplus.dev/guide/).

```bash
vp i
vp dev
```

The project retains T3 Code's internal storage keys and protocol identifiers
for migration compatibility while presenting the Toolport Studio product name
in the desktop and web clients.

## License

MIT. See [LICENSE](./LICENSE).
