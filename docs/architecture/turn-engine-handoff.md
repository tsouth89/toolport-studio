# Shared turn engine — handoff

Self-contained brief for picking up the turn-engine work (Linear **SOU-428**).
Written 2026-07-27 against `main` @ `2fe18cb3b` plus branch
`fix/core-loop-conformance-and-stop-reliability` (PR #2).

### Status (2026-07-27)

Landed under `apps/server/src/provider/turnEngine/`:

- Capability matrix, phase machine, interjection policy, steer policy, **stop policy**
- **Grok wired** to engine defaults: raw mid-turn framing, no force-close tools on
  steer, no synthetic “Following up” warning
- **All five adapters** use shared `canSteerSendTurn` (Codex via `canSteerCodexSendTurn`)
- Conformance: **45/45** green — only `resume-preserves-history` remains
  unimplemented. Cursor prompt failures now emit typed `runtime.error` + failed
  turn completion (process-death surface).

Next: resume history; engine-owned queue; thinner transports.

---

## 1. The question this answers

> Why do we keep making one-off fixes per provider, and can one engine serve
> all five?

**Yes — for everything that has actually been breaking.** The reason it hasn't
happened is that `ProviderAdapterShape` standardizes _calls_, not _semantics_.

```ts
// apps/server/src/provider/Services/ProviderAdapter.ts
readonly sendTurn: (input) => Effect<ProviderTurnStartResult, TError>
readonly interruptTurn: (threadId, turnId?) => Effect<void, TError>
readonly stopSession: (threadId) => Effect<void, TError>
```

That interface says nothing about what a turn _is_, when it is over, what Stop
guarantees, or what happens to a message sent mid-turn. So every adapter
re-derives those answers independently, differently, and incompletely.

### The distribution of that duplication _is_ the distribution of bugs

| Adapter         | Lines | `activeTurnId` refs | interrupt refs | mid-turn steer                                 |
| --------------- | ----- | ------------------- | -------------- | ---------------------------------------------- |
| ClaudeAdapter   | 4,388 | 5                   | 30             | `promptQueue`                                  |
| GrokAdapter     | 2,900 | 49                  | 60             | `canSteerGrokSendTurn` + `preemptActivePrompt` |
| CodexAdapter    | 2,014 | 0                   | 9              | none until PR #2                               |
| OpenCodeAdapter | 1,819 | 17                  | 10             | `activeTurnId` reuse                           |
| CursorAdapter   | 1,469 | 29                  | 4              | `promptsInFlight` + `preemptActivePrompt`      |

Grok has 49 active-turn references because it is the dogfood path and got
hardened by hand. Codex had 0, which is exactly why it had no steer path.

---

## 2. Worked example: the 2026-07-27 Grok steer failure

The clearest argument for the engine, because **none of it is protocol-specific**.

### What the user did

Sent a side-constraint mid-turn, ~9 minutes into a long Grok turn:

> "dont deploy this one directly by the way. open a PR for full review"

### What the logs show

`~/.toolport-studio/userdata/logs/provider/53853490-….log.1`

```
16:04:27.885  session/prompt  status:"failed"  errorTag:"Interrupt"
16:04:27.883  3 × item.completed status:"failed"
              detail:"Tool did not complete before the turn stopped."
16:04:27.912  session/prompt  status:"started"
16:04:27.910  runtime.warning "Following up: …"
16:04:46.396  turn.completed  stopReason:"end_turn"     ← 18.5s later
```

### What Studio actually sent the model

`GrokAdapter.ts:2126` prepends a hardcoded lead-in to **every** mid-turn send:

```
The user interjected while you were working. Stop the previous plan and
prioritize this instruction:

dont deploy this one directly by the way. open a PR for full review
```

Studio simultaneously force-closed three in-flight tool calls. From the model's
position: tools killed, told to stop the previous plan, given a constraint with
no remaining work attached. It acknowledged and ended the turn. Nine minutes of
work discarded because the user added a note.

### Three defects, zero of them protocol

1. **Destructive lead-in.** Every steer is framed as "abandon everything."
   Most real interjections are additive constraints. One hardcoded string
   applied to all mid-turn messages.
2. **Force-closing open tools on steer.** Exists so ghost `inProgress` rows do
   not linger in the work log — a _projection_ concern — but it destroys real
   in-flight work to fix a display problem.
3. **Fabricated status.** "Following up" is emitted as a `runtime.warning`
   (hence the red X in the UI), fired unconditionally right after preempt,
   _before_ anything is known about the outcome. It showed success for 9m33s
   against a turn that had already been torn down.

All three are policy about what Studio does to a running turn. All three would
be decided once in an engine. **This is the argument.**

### Log-reading caveat

Provider logs redact payloads:

```json
"request":{"valueType":"object","fieldCount":3}
```

Prompt text never appears. Do not conclude "the message was never sent" from
its absence — that mistake was made and corrected during this investigation.
Use `status` / `errorTag` / event ordering as evidence instead.

---

## 3. Target architecture

Today:

```
Orchestration → ProviderAdapterShape → adapter does transport + protocol
                                       + policy + lifecycle
```

Target:

```
Orchestration → TurnEngine (state machine + policy, one implementation)
                    └→ ProviderTransport (protocol translation + process facts
                                          + capability declarations)
```

### Engine owns (decided once)

- **Turn lifecycle** — guarantees every turn reaches a terminal state
- **Mid-turn send policy** — steer vs queue, and _how_ an interjection is framed
- **Stop semantics** — what is torn down, in what order, and what is preserved
- **Liveness interpretation** — confirmed-death only, never silence timers
- **Turn queue** — thread-scoped, engine-owned, survives restart and window close

### Transport owns (irreducibly per-provider)

- Provider protocol ↔ canonical `ProviderRuntimeEvent` translation
- Process/transport facts (alive, exited, transport open, tool subprocess running)
- Capability declarations (below)

The key move: **provider differences become data the engine reads, not code
paths each adapter reimplements.**

---

## 4. Capability matrix

Audited; currently implicit and discovered by reading source or by a test
failing. Encoding this is the first concrete deliverable.

| Capability                        | Claude           | Codex                     | Grok                  | Cursor                | OpenCode                   |
| --------------------------------- | ---------------- | ------------------------- | --------------------- | --------------------- | -------------------------- |
| Transport                         | in-process SDK   | app-server JSON-RPC       | ACP subprocess        | ACP subprocess        | HTTP/SDK                   |
| `sendTurn` returns immediately    | yes              | yes                       | **no (blocks)**       | **no (blocks)**       | yes                        |
| Native interject                  | `promptQueue`    | `turn/steer`              | `preemptActivePrompt` | `preemptActivePrompt` | turn reuse                 |
| Interrupt can hang                | —                | yes (force-settle exists) | yes                   | yes                   | —                          |
| Resume                            | session id       | resume cursor             | session id            | session id            | session id                 |
| Subprocess liveness observable    | no               | yes                       | yes                   | yes                   | partial                    |
| Requires `cwd` at session start   | no               | no                        | **yes**               | **yes**               | yes                        |
| Requires model selection per turn | no               | no                        | no                    | no                    | **yes (`provider/model`)** |
| Turn terminal signal              | `result` message | `turn/completed`          | ACP stop reason       | ACP stop reason       | `session.status` idle      |

### Test-seam styles (three, for five providers)

Standing a provider up in isolation currently requires a different technique
each time — itself evidence the boundary is wrong:

| Provider      | Fake injected via                                            |
| ------------- | ------------------------------------------------------------ |
| claude        | `createQuery` option                                         |
| codex         | `makeRuntime` option                                         |
| grok / cursor | spawn `scripts/acp-mock-agent.ts`, script via `T3_ACP_*` env |
| opencode      | `Layer.succeed(OpenCodeRuntime, …)` service replacement      |

---

## 5. What already exists to build on

### Core-loop conformance suite — the safety net

`apps/server/src/provider/conformance/` (PR #2). **25 passing, 0 failing**,
all five providers, ~17s.

- `contract.ts` — 9 stable case ids, provider-neutral script vocabulary,
  binding interface, tagged harness error, latency budgets
- `runner.ts` — one suite run against every binding
- `bindings/{claude,codex,grok,cursor,opencode}.ts`

Design rules worth preserving:

- **Assertions only on `ProviderRuntimeEvent`.** Never reach into provider
  internals. If a behaviour cannot be expressed in runtime events, it belongs
  in that adapter's own test file.
- **`it.live`, not `it.effect`.** `it.effect` supplies a TestClock under which
  "first progress within 5s" passes without any time elapsing. This is
  load-bearing — it is what surfaced the ACP Stop defect below.
- **Unimplemented cases are listed, not omitted.** `NOT_YET_IMPLEMENTED` in
  `runner.ts`; a meta-test requires every waiver to name a real case and give a
  reason. Absence-as-signal is the failure mode being prevented.

Five cases remain unimplemented: `stop-mid-tool-terminalizes`,
`stop-with-pending-approval-settles`, `post-stop-follow-up-runs`,
`process-death-is-typed-error`, `resume-preserves-history`.

### Two fixes on PR #2

- **SOU-429** — `AcpSessionRuntime.cancel` used `TestClock.withLive`, a
  test-only combinator that throws under the live runtime
  (`testClockWith` does `fiber.getRef(Clock.Clock) as TestClock`). Every caller
  pipes cancel through `Effect.ignore`, so the defect was swallowed and the
  force-cancel path never ran. Only fired when the agent was _not_ cooperating —
  i.e. exactly the hung-turn case Stop exists for. Invisible to 58 existing
  Grok + Cursor tests because they all run under a TestClock.
- **SOU-421** — Codex had no mid-turn steer. It turned out the app-server
  exposes `turn/steer` (`{threadId, expectedTurnId, input}` → `{turnId}`) and
  Studio simply never called it.

---

## 6. Migration plan

Strangler, not rewrite. The conformance suite is what makes it survivable.

**Standing constraint: do not extract anything the suite does not already
assert.**

1. **Finish the suite** — the five remaining cases, especially
   `stop-mid-tool-terminalizes` and `post-stop-follow-up-runs`, which cover the
   behaviour the engine will move first.
2. **Extract from Claude and Grok first.** Maximally different transports
   (in-process SDK vs ACP subprocess), and both are daily drivers so
   regressions surface immediately.
3. **One concern at a time**, each landing green:
   lifecycle → capabilities/steer → liveness → queue.
4. **Codex last, as the proof.** It has the least existing lifecycle logic. If
   the engine makes it first-class with zero Codex-specific code, the
   abstraction is real. If Codex still needs special cases, the design is wrong
   — better to learn that before Cursor and OpenCode.

---

## 7. What this resolves structurally

These stop being independent per-adapter work:

| Issue                              | Becomes                                           |
| ---------------------------------- | ------------------------------------------------- |
| SOU-421 Codex steer                | capability flag + one engine implementation       |
| SOU-379 / SOU-427 liveness         | one enforceable location for confirmed-death-only |
| SOU-422 queued turns               | engine-owned, thread-scoped, survives restart     |
| SOU-423 orphaned `running` threads | lifecycle guarantees a terminal state             |
| SOU-361 composer stuck Sending     | client renders authoritative state                |
| SOU-351 stuck provider turn        | lifecycle + liveness                              |
| 2026-07-27 Grok steer failure      | interjection framing decided once                 |

### The usability half

`ChatView.tsx` is 6,517 lines, much of it **inferring** turn state from an
event stream whose semantics vary per provider — a shadow state machine running
against five inconsistent inputs. That is why the UI lies: wrong Working
chrome, stuck Sending spinner, ghost tool calls, zombie sidebar Running.

An authoritative engine state means the client renders instead of deriving, and
most of that class becomes unreachable. Reliability and usability here are the
same fix.

---

## 8. Immediate fix, if taken before the engine

The Grok steer failure is user-facing now. Minimal changes, all in the
direction of doing _less_ to a running turn:

- **Drop the stop-work framing.** Send the interjection without
  `GrokAdapter.ts:2126`'s lead-in; let the model judge redirect vs constraint.
- **Stop force-closing open tools on steer.** Fix ghost rows in the projection
  layer, where the problem actually is.
- **Delete the "Following up" `runtime.warning`.** Replace with nothing until
  there is a real signal. Silence beats invention.

Doing this in `GrokAdapter` alone leaves Cursor, Claude, and OpenCode with
their own untested behaviours — which is the pattern the engine exists to end.
Treat it as a stopgap and record it as such.

---

## 9. Open questions

- **Interjection framing** — should it be provider-neutral text, no framing at
  all, or a user-visible choice (steer / queue / new turn)? Needs a product
  decision before the engine encodes one.
- **Ghost tool rows** — confirm they are fixable in the projector without
  force-closing at the adapter. If not, the engine needs an explicit
  "abandoned" item state.
- **Codex `turn/steer` on the wire** — implemented and unit-tested, but the
  conformance Codex binding fakes at `CodexSessionRuntimeShape`, _above_ the
  RPC. Verified by stashing the fix: the conformance case still passes. Moving
  that binding to the JSON-RPC client boundary is the same boundary the thin
  transport establishes anyway.
- **CI** — Test/Check/Release Smoke have never run on PR #2; jobs sat queued
  for hours with no runner. Local runs are currently the only verification.

---

## 10. Key file map

| Path                                                     | Role                                           |
| -------------------------------------------------------- | ---------------------------------------------- |
| `apps/server/src/provider/Services/ProviderAdapter.ts`   | the interface to replace the policy half of    |
| `apps/server/src/provider/Layers/*Adapter.ts`            | the five adapters                              |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`      | shared ACP runtime (Grok + Cursor)             |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts` | Codex app-server runtime                       |
| `apps/server/src/provider/conformance/`                  | the safety net                                 |
| `packages/contracts/src/providerRuntime.ts`              | `ProviderRuntimeEvent` — the canonical surface |
| `apps/web/src/components/ChatView.tsx`                   | client shadow state machine (6,517 lines)      |
| `scripts/acp-mock-agent.ts`                              | scriptable ACP fake, ~35 `T3_ACP_*` knobs      |
| `docs/product/provider-parity-scorecard.md`              | manual scorecard the suite should supersede    |
