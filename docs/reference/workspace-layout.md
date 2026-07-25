# Workspace layout

- `apps/desktop` — Electron shell, native integration, local backend lifecycle,
  updates, and packaging resources.
- `apps/server` — Provider adapters, orchestration, persistence, projects,
  terminals, previews, attachments, and Toolport MCP bindings.
- `apps/web` — React conversation and workspace interface.
- `packages/contracts` — Shared Effect schemas and transport contracts.
- `packages/client-runtime` — Reusable client state and connection behavior.
- `packages/shared` — Shared runtime utilities with explicit subpath exports.
- `packages/effect-acp` — ACP transport support used by Cursor, Grok, and
  OpenCode.
- `packages/effect-codex-app-server` — Codex app-server transport support.
- `packages/ssh` and `packages/tailscale` — Optional remote environment support.
- `scripts` — Development, packaging, release, and brand tooling.
- `.repos/effect-smol` — Read-only Effect reference source used during
  development.

The fork intentionally does not contain the inherited T3 mobile app, marketing
site, hosted relay deployment, or their release workflows.
