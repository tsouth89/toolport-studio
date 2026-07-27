# Turn engine (SOU-428)

Shared **turn policy and lifecycle semantics** for all providers.

Adapters still own protocol/transport. This package owns decisions that used to
be reimplemented five times (steer eligibility, interjection framing, phase
model, capability matrix, stop settle rules).

## What lives here

| Module               | Role                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `TurnCapabilities`   | Per-provider turn capabilities as data                             |
| `TurnPhase`          | Authoritative phase machine (`idle` → `preparing` → `running` → …) |
| `InterjectionPolicy` | How mid-turn text is framed; product default is raw pass-through   |
| `SteerPolicy`        | Whether a send continues the live turn                             |
| `StopPolicy`         | Stop settle order + terminal/settled event classification          |
| `TurnQueue`          | In-memory disposition for send-while-running (`steer` \| `queue`)  |

## Product defaults (dogfood lessons)

- **No abandon-work lead-in** on steer. Additive constraints must not kill
  long-running plans.
- **No synthetic “Following up”** `runtime.warning`. Silence beats invention.
- **No force-close open tools on steer.** Ghost tool rows are a projection
  problem; killing real tools is not the fix.
- **Force-close open tools on Stop.** Settlement must not wait on wedged tools.

## Wiring status

- **Grok:** interjection + steer + force-close/chrome policy flags + `resolveGrokSendDisposition` (TurnQueue)
- **Cursor / Claude / OpenCode:** `canSteerSendTurn`
- **Codex:** `canSteerCodexSendTurn` → shared `canSteerSendTurn`
- Conformance (all five providers): first-progress, assistant-text, interrupt, stop-mid-tool,
  send-while-running, post-stop-follow-up, pending-approval, process-death, resume-preserves-history
- Queue drain (hold + auto-start next after settle) is not transport-wired yet; capability matrix
  still declares `sendWhileRunning: "steer"` for every provider. `queued` disposition is refused.

## Tests

```bash
vp test run apps/server/src/provider/turnEngine
vp test run apps/server/src/provider/conformance/coreLoop.conformance.test.ts
```
