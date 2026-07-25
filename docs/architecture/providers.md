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
- Toolport Studio's internal preview automation server when available

Bindings are created per session so credentials and temporary endpoints do not
leak into global provider configuration.
