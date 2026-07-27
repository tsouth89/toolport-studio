# Provider parity scorecard

Parent program: **SOU-354** (first-class providers: match or beat official apps on the core loop).  
Related: **SOU-401** (this scorecard), **SOU-400** (host tax), **SOU-402** (MCP opt-in).

## Purpose

Make “first-class” measurable. Run the same checks against Studio and the official client (CLI or desktop) on the **same machine**, same model tier, same prompt pack.

Not a pixel clone of Claude Desktop / Codex app / Cursor IDE / Grok TUI.  
Bar: **trust, speed, multi-session, tools, stop, recovery**.

## First-class set

| Tier      | Providers           | Commitment                               |
| --------- | ------------------- | ---------------------------------------- |
| A         | Grok, Claude, Codex | Daily dogfood; Phase 0–1 must stay green |
| B         | Cursor, Gemini      | Scorecard green after Tier A is boring   |
| Supported | OpenCode            | No Tier A promise until A is solid       |

## Scorecard rows (pass / fail)

Run once solo, once with **3 concurrent Studio sessions** (or 2 other providers busy).

| #   | Check                    | Pass criteria                                                           |
| --- | ------------------------ | ----------------------------------------------------------------------- |
| 1   | Auth / session start     | Pair or CLI auth works; clear error if not                              |
| 2   | Send → first progress    | Working / Starting visible within **2s**; no multi-minute blank         |
| 3   | Stream feel (1 session)  | Readable stream; Studio not word-drip vs CLI on same prompt             |
| 4   | Stream feel (3 sessions) | Same prompt still usable; host tax not dominant                         |
| 5   | Stop                     | Mid-tool Stop settles; sidebar not zombie Running; follow-up send works |
| 6   | Native tools             | Read/grep/shell (or provider equivalent) complete successfully          |
| 7   | Long tool (>60s)         | Stays visible; no false silence kill                                    |
| 8   | Multi-account            | Where supported: isolated config/home; correct account in status        |
| 9   | MCP optional             | Off: no Toolport gateway inject. On: Toolport tools available           |
| 10  | Restart recovery         | App restart mid-thread: reconnect/restore without silent history loss   |
| 11  | Error surfaces           | Failed Stop, not-connected, rate limit shown (no silent swallow)        |

## Fixed prompt pack (ground truth)

Use identical prompts in Studio and official CLI. Prefer short, deterministic tasks.

1. **Hello** — “Reply with exactly: pong” (stream / blank check)
2. **Read** — “Read README.md and quote the first heading” (tool path)
3. **Long shell** — “Run `sleep 90` then print done” or platform equivalent (long tool + Stop optional)
4. **Stop** — During long shell, press Stop; confirm settled within a few seconds
5. **Multi-session** — Run Hello in three threads overlapping

Record: wall times, pass/fail, notes (provider log path under `~/.toolport-studio/userdata/logs/provider/`).

## Separating model time vs Studio tax

| Source             | How to tell                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| Model / agent loop | Many `message_start`/`message_stop` or tool rounds; CLI is slow too    |
| Studio host tax    | CLI fast, Studio drip/lag; large native NDJSON; SQLite activity growth |
| MCP inject         | Gateway process present when “Toolport tools in sessions” is off → bug |

Do **not** compare a high-effort multi-hour Opus explore in Studio to a light CLI chat.

## Host tax budgets (dogfood)

Soft budgets after a week of multi-session use (adjust with evidence):

| Asset                    | Soft budget                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| Per-thread provider log  | Prefer lifecycle events; no per-token dumps (already policy for Grok/Claude) |
| `state.sqlite` growth    | Investigate if multi-GB from tool `rawOutput` / activities alone             |
| First Working after Send | < 2s local machine when provider is healthy                                  |

## How to file gaps

1. Run scorecard row → **fail**
2. File a focused Linear child of **SOU-354** (one red cell per issue when possible)
3. Attach provider log snippet + which official client passed

## Current product defaults that affect the scorecard

- **Toolport MCP injection**: default **on** (Settings → “Toolport tools in sessions”; toggle off for lean coding-only turns)
- **Assistant streaming**: default **off** (buffered); enable for token-by-token UI
- **Grok silence policy**: never auto-kill open tools; post-tool/think ceiling 15m only when no tool is open
- **Pending approvals / AskUserQuestion**: auto-cancel after **3 minutes** (approvals) / **5 minutes** (user input) on Grok, Claude, Cursor, Codex so multi-session dogfood cannot hang forever

## Changelog

- 2026-07-26: Initial scorecard for SOU-401 / SOU-354 program rewrite.
- 2026-07-26: Reliability batch on main — SQLite retention (SOU-400), Stop force-settle (Claude/Cursor/Codex), cold-start rehydration, Working first-token honesty (early turn.started for Claude/Cursor/Grok/Codex), pending approval + AskUserQuestion auto-cancel timeouts (3m/5m) for Grok/Claude/Cursor/Codex, Grok no longer silence-kills open tools by default.
