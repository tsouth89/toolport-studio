# Architecture

Toolport Studio is an Electron desktop shell around a local Node.js server and a
React client.

```text
Electron desktop
  ├─ React conversation and workspace client
  └─ Local Toolport Studio server
       ├─ Provider adapters
       │    ├─ Claude Agent SDK + installed Claude CLI
       │    ├─ Codex app-server
       │    ├─ Cursor ACP
       │    ├─ Grok ACP
       │    └─ OpenCode ACP
       ├─ Provider-neutral orchestration and persistence
       ├─ Projects, terminals, git, previews, and attachments
       └─ Toolport MCP session bindings
```

## Main packages

- `apps/desktop` owns Electron lifecycle, local backend startup, updates, native
  dialogs, and desktop identity.
- `apps/server` owns provider sessions, orchestration, persistence, projects,
  terminals, previews, Toolport integration, and the local HTTP/WebSocket API.
- `apps/web` owns the conversation and workspace interface.
- `packages/contracts` contains shared Effect schemas and transport contracts.
- `packages/client-runtime` contains reusable client-side state and connection
  behavior.
- `packages/shared` contains runtime utilities shared by server and clients.

## Product boundary

The conversation is the durable unit. A project is optional context attached to
that conversation, not a prerequisite for starting one. Provider-specific events
are normalized into a common orchestration model while meaningful provider
capabilities remain visible to the user.

Toolport Studio discovers the Toolport gateway and builds per-session MCP
bindings. Toolport remains the source of truth for MCP configuration and policy.
Ceiling integration will provide usage and quota intelligence without moving
collector ownership into this repository.

## Compatibility boundary

Some internal package names, environment variables, protocol identifiers, and
database keys still use inherited T3 names. They are intentionally preserved
until migration logic exists; product-facing copy and application identity use
Toolport Studio.
