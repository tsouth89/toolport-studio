# Turn engine (SOU-428)

Shared **turn policy and lifecycle semantics** for all providers.

Adapters still own protocol/transport. This package owns decisions that used to
be reimplemented five times (steer eligibility, interjection framing, phase
model, capability matrix).

## What lives here

| Module               | Role                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `TurnCapabilities`   | Per-provider turn capabilities as data                             |
| `TurnPhase`          | Authoritative phase machine (`idle` → `preparing` → `running` → …) |
| `InterjectionPolicy` | How mid-turn text is framed; product default is raw pass-through   |
| `SteerPolicy`        | Whether a send continues the live turn                             |

## Product defaults (dogfood lessons)

- **No abandon-work lead-in** on steer. Additive constraints must not kill
  long-running plans.
- **No synthetic “Following up”** `runtime.warning`. Silence beats invention.
- **No force-close open tools on steer.** Ghost tool rows are a projection
  problem; killing real tools is not the fix.

## Wiring status

- Grok: uses `formatInterjectionText`, `canSteerSendTurn`, force-close/chrome
  policy flags.
- Cursor: uses `canSteerSendTurn` for mid-turn id reuse.
- Claude / Codex / OpenCode: capability matrix only so far; next extraction.

## Tests

```bash
vp test run apps/server/src/provider/turnEngine
```
