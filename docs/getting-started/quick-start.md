# Quick start

## Use a release

Download the latest Windows alpha from
[GitHub Releases](https://github.com/tsouth89/toolport-studio/releases).

Install and authenticate at least one supported provider CLI before starting
Toolport Studio. The app probes the installed Claude, Codex, Cursor, Grok, and
OpenCode CLIs and reports anything that needs attention in Settings.

## Run from source

Requirements:

- Node.js 24
- pnpm 11
- Vite+
- At least one supported provider CLI

```bash
pnpm install
pnpm dev
```

That starts the **web + server** dev pair in the browser (not Electron).

### Desktop development (Electron)

With the production alpha already installed, you can still run a **separate**
dev desktop build. It uses different ports and (with an instance name) a
different userdata folder, so it will not fight the installed alpha.

From the repo root:

```bash
pnpm install
pnpm dev:desktop
```

Isolated instance (recommended while alpha is also installed):

```powershell
# Windows PowerShell
$env:T3CODE_DEV_INSTANCE = "dev-local"
pnpm dev:desktop
```

```bash
# macOS / Linux
T3CODE_DEV_INSTANCE=dev-local pnpm dev:desktop
```

- Installed alpha keeps its own app data and ports.
- Dev desktop opens Electron with hot-reloaded web UI + local server.
- Look for cold-start lines in the desktop log (`cold start main window shown`
  with `process_start=…ms`, `backend_ready=…ms`, `main_window_shown=…ms`).

Server-only or web-only:

```bash
pnpm dev:server
pnpm dev:web
```

`T3CODE_DEV_INSTANCE` is an inherited compatibility variable and will be migrated
only when existing development state can be preserved.
