# Turn engine (SBS-428)

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
| `TurnSettlement`     | Claim-once ownership for exact completion and explicit recovery    |

## Product defaults (dogfood lessons)

- **No abandon-work lead-in** on steer. Additive constraints must not kill
  long-running plans.
- **No synthetic “Following up”** `runtime.warning`. Silence beats invention.
- **No force-close open tools on steer.** Ghost tool rows are a projection
  problem; killing real tools is not the fix.
- **Force-close open tools on Stop.** Settlement must not wait on wedged tools.

## Wiring status

- **Grok:** claim-first shared lifecycle ownership + mid-turn **steer** (ACP preempt) + force-close/chrome +
  provider-emitted failure classification. TurnQueue drain is fully wired for
  `sendWhileRunning: "queue"` (held + auto-start after settle; Stop abandons pending sends without
  erasing the live turn before terminalization). Product default remains steer so concurrent
  messages interject.
- **Cursor:** claim-first shared lifecycle ownership + `canSteerSendTurn` + open-tool force-close
  on Stop + post-Stop ACP recycle + silence warning (no open tools) + provider-emitted failure
  classification
- **Claude:** claim-first shared lifecycle ownership + `canSteerSendTurn` + open-tool force-close on settle +
  provider-emitted failure classification. Late or duplicate SDK results cannot claim settlement
  for a different live turn.
- **OpenCode:** claim-first shared lifecycle ownership + `canSteerSendTurn` + force-settle session on Stop + open-tool force-close on Stop/idle/error + provider-emitted failure classification on idle. Id-less idle events bind to the turn that observed the provider's busy transition.
- **Codex:** claim-first shared lifecycle ownership + `canSteerCodexSendTurn` → shared
  `canSteerSendTurn` + provider-emitted failure classification on completed turns + open-tool
  force-close on settle
- **Settle policy:** remaining open tools are force-closed on any settle (including
  successful end_turn), not only Stop — Claude/OpenCode match Grok/Cursor
- **Provider-emitted failures:** pure capacity/auth dumps as assistant text must
  settle as failed turns via `classifyProviderEmittedFailure` (all five adapters)
- Conformance (all five providers): first-progress, assistant-text, interrupt, stop-mid-tool,
  send-while-running, post-stop-follow-up, pending-approval, process-death, resume-preserves-history
- Queue drain is transport-wired on **Grok** only; other providers still declare `steer`.
- Every provider must claim terminal ownership before session mutation, tool force-close,
  `turn.completed`, or queue drain. Normal results match the exact live turn; only explicit
  Stop/death recovery may fall back to the currently tracked turn.
- Explicit Stop derives the candidate turn, marks the lifecycle stopping, then reserves or queues
  terminal ownership before transport cancellation. A transport that synchronously queues its own
  synthetic terminal event (Codex) marks stopping first and lets that event perform the claim.

## Tests

```bash
vp test run apps/server/src/provider/turnEngine
vp test run apps/server/src/provider/conformance/coreLoop.conformance.test.ts
```
