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

Desktop development:

```bash
pnpm dev:desktop
```

Use an isolated port and state set when running more than one development copy:

```bash
T3CODE_DEV_INSTANCE=feature-xyz pnpm dev:desktop
```

`T3CODE_DEV_INSTANCE` is an inherited compatibility variable and will be migrated
only when existing development state can be preserved.
