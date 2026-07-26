# SOU-386 Shell design contract (ground zero)

Directional mockup (Linear SOU-386 attachment) is the north star, not a pixel-perfect
spec. Implementation evolves the existing shell; it does not rewrite ChatView or Electron.

## Product principles

1. **Visibility, not theater.** Real tools, progress, errors, approvals only.
2. **No private chain-of-thought** in the main reply. Progress/thinking uses existing
   progress surfaces.
3. **One projection** for timeline + Activity panel (Activity surface is later PR).
4. **Toolport identity always on** in alpha/release, not only `dev`/`nightly`.
5. **Dark-first mockup; light/system remain supported.**

## Visual language (from mockup)

| Intent          | Direction                                                                  |
| --------------- | -------------------------------------------------------------------------- |
| Base canvas     | Deep graphite / navy, not pure `#000`                                      |
| Raised surfaces | Slightly lifted cards, clear elevation                                     |
| Structure       | Restrained blue blueprint grid (header/edge only)                          |
| Accent          | Primary blue for selection/progress; orange sparingly for Toolport/actions |
| Density         | Instrument panel: compact tools, clear current step                        |
| Composer        | Anchored glass dock; refine tokens later                                   |

## Token map (PR 1 foundation)

| Semantic token           | Role                                 |
| ------------------------ | ------------------------------------ |
| `--shell-canvas`         | App / conversation background        |
| `--shell-surface`        | Sidebar, panels, raised chrome       |
| `--shell-surface-raised` | Cards, selected rows, Activity tiles |
| `--shell-border`         | Dividers                             |
| `--shell-blueprint-*`    | Blueprint gradient stops             |
| `--shell-accent`         | Primary interactive blue             |
| `--shell-brand`          | Toolport orange (high-value only)    |

Existing shadcn tokens (`--background`, `--sidebar`, `--primary`, …) map onto these so
behavior classes keep working.

## Intentional deviations from mockup (v1)

- MCP server list in Activity only when Studio has authoritative live status.
- Fake % progress bars omitted unless the provider supplies a total.
- User avatar / “Pro plan” chrome is not required for foundation.
- Pop-out windows are SOU-395, not SOU-386.
- Activity right panel is PR 2+, not foundation.

## Delivery sequence

| Phase    | Scope                                                         |
| -------- | ------------------------------------------------------------- |
| PR 0 / 1 | Tokens + permanent brand atmosphere + kill pure-black islands |
| PR 2     | Shared Activity view-model + right-panel surface              |
| PR 3     | Timeline/tool hierarchy                                       |
| PR 4     | Shell refinement (sidebar hierarchy, composer proportions)    |
| PR 5     | Dogfood + hardening                                           |

## Ground-zero acceptance (this slice)

- [x] Design contract checked in
- [x] Semantic shell tokens exist for light/dark
- [x] Alpha/release builds show Toolport blueprint identity (not stage-gated only)
- [x] Dark sidebar/canvas no longer pure `#000`
- [x] No behavior changes to send/stop/queue/tools

## PR 2 slice (Activity surface)

- [x] Shared pure projection: `apps/web/src/threadActivityViewModel.ts`
- [x] Right-panel singleton surface `activity` (store v8)
- [x] `ActivityPanel` UI: current step, elapsed, recent steps, attention
- [x] MCP section omitted until authoritative status exists
- [ ] Timeline “View in Activity” deep-link (follow-up)
- [ ] Changed files / artifacts blocks (follow-up; reuse existing surfaces)
