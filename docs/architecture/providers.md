# Provider architecture

Toolport Studio exposes a common session contract over provider-specific
transports.

## Supported adapters

| Provider | Transport                                              | Authentication                    |
| -------- | ------------------------------------------------------ | --------------------------------- |
| Claude   | Claude Agent SDK using the installed Claude executable | Claude CLI login                  |
| Codex    | Codex app-server                                       | Codex or ChatGPT-backed CLI login |
| Cursor   | ACP agent                                              | Cursor Agent login                |
| Grok     | ACP agent                                              | Grok CLI login                    |
| OpenCode | ACP agent                                              | OpenCode configuration            |

Adapters translate provider-native events, approvals, tool calls, content blocks,
and usage signals into the shared orchestration contracts. The UI can therefore
render one conversation model without pretending all providers have identical
capabilities.

## Models

Provider discovery remains the source of truth for available models. The client
builds a small recommended list from that live catalog and keeps every remaining
model under **Other models**.

## Attachments

Attachments are stored locally and resolved by the provider adapter. Providers
with native image blocks receive them directly. Grok ACP sessions receive pasted
images as embedded resources so Grok Build can work with screenshots from the
desktop composer.

## Toolport MCP bindings

Each provider session receives:

- Toolport's local gateway when it is installed and enabled
- An explicitly configured Toolport Streamable HTTP endpoint when supplied
- Studio browser preview tools (see below)

Bindings are created per session so credentials and temporary endpoints do not
leak into global provider configuration.

### Browser preview: prefer via Toolport

Studio's collaborative browser tools (`preview_*`) live on an internal HTTP MCP
server (`toolport-studio-preview`). **When the Toolport gateway is available**,
Studio does **not** dual-inject that server as a second full MCP binding (that
would dump ~14 tool schemas into every turn). Instead:

1. Studio writes a session registry overlay (user Toolport registry + a managed
   `toolport-studio-preview` HTTP entry pointing at Studio's loopback MCP).
2. Studio-spawned gateway processes receive `TOOLPORT_REGISTRY` plus
   `TOOLPORT_SECRET_STUDIO_PREVIEW_BEARER` (per-session credential).
3. Agents discover and call `preview_*` through Toolport lazy meta-tools
   (~900 tokens of definitions, not full preview schemas).

**Fallback:** if Toolport inject is off, the gateway binary is missing, or the
session overlay/secret setup fails, Studio injects `toolport-studio-preview`
directly (full schemas). Direct mode is also used when the panel is opened
without a working gateway. Force `TOOLPORT_STUDIO_PREVIEW_MCP=off` disables both
paths.

Adapter rebind fingerprints include a `preview:via|direct|none` lane so
switching delivery mid-session recycles/rebinds MCP correctly.

### Single gateway, no doubles

Studio injects the gateway under the name `toolport` with client id
`toolport-studio` (and the legacy `CONDUIT_CLIENT_ID` dual-write for older
gateways). That name matches the entry Toolport writes into Claude/Cursor/Grok
client configs for **terminal** use.

**Studio is the source of truth inside Studio sessions.** For Grok Build, if
`~/.grok/config.toml` already has `[mcp_servers.toolport]` (or legacy
`conduit`) from a Toolport desktop connect, Studio launches the Grok ACP child
with a temporary `GROK_HOME` whose config has that gateway table stripped, and
passes the Studio-managed binding via ACP `session/new` `mcpServers` instead.
Terminal `grok` outside Studio continues to use the real `~/.grok` config.

Codex receives the same binding via `-c mcp_servers.toolport.*` overrides, which
replace the same key in Codex's config rather than adding a second server.

Gateway discovery looks under the post-rename data leaf (`…/Toolport`) first,
then the legacy `…/Conduit` leaf, plus `TOOLPORT_DATA_DIR` / `CONDUIT_DATA_DIR`
and `TOOLPORT_GATEWAY_PATH`.
