# Agentic OS — Slice 1 live acceptance

Independent live-acceptance suite for Slice 1 of the UHS agentic OS plan. It drives the
running CortexOS dashboard and the live model registry the way a demanding operator
would, rather than asserting the implementation back to itself.

## Files

| Path | What it is |
|---|---|
| `tests/playwright/agentic-os-slice1.spec.ts` | The suite (checks A–G). |
| `/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/output/2026-09-05/screenshots/slice1-ui/` | Screenshots and captured evidence (`A-routing-rows.txt`, `B-evidence.json`, `D-queue-facts.json`, `F-console-network.json`, `G-redaction.json`, `B-cli-before.txt`, `B-cli-after-revert.txt`, `B-daemon-evidence.txt`). |
| `/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/.planning/scratch/2026-09-05-agentic-os-plan-r02-consensus.md` | The plan under test (§3, §10 Slice 1, §11). |
| `/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/.planning/agentic-os/model-routing-contract.md` | The routing contract (§7 is the dashboard surface). |

## Running it

Credentials come from `~/cortextos/dashboard/.env.local` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`).
Source that file inside the command; never echo, print, or copy the values.

```bash
cd ~/agent-os-worktrees/verify-slice1/cortextos
set -a; . ~/cortextos/dashboard/.env.local; set +a
npx playwright test tests/playwright/agentic-os-slice1.spec.ts
```

Override `DASHBOARD_URL` for a server on another port and `SLICE1_SHOTS` for another
screenshot directory. The default target is the live dev server on
`http://localhost:3000`.

## What each check covers

- **A** — the Fleet "Model routing" table: one row per registry agent, role/tier,
  effective-source badge, desired vs running with a confidence badge, billing mode and
  cost class, activation mode, and trillion-coder's invalid legacy pair surfaced as a
  real validation error.
- **B** — an end-to-end role-tier switch on the LIVE registry: dialog preview (affected
  agents, cost class, billing, restart consequence, pinned-agent warning), receipt
  progress, the pin correctly holding the change back from jarvis-mls, then a revert
  that restores the starting state.
- **C** — the dialog opens from the keyboard, traps focus, closes on Escape and returns
  focus; `/agents` and `/queue` do not scroll horizontally at 390×844 or 1366×768.
- **D** — the Queue owner filter, the recovery lanes for blocked and failed work, the
  unassigned recovery lane, and the absence of the degraded banner.
- **E** — `/briefing` renders a snapshot or an honest empty state, and is linked in the
  sidebar.
- **F** — no console errors and no 4xx/5xx responses across `/agents`, `/queue`,
  `/briefing`.
- **G** — `GET /api/agents/vivienne/config` carries no `crons[].prompt`, no `env`, and no
  Telegram bot token.

## Rules this suite follows

- Every registry change carries a `ZZTEST` marker in its reason and is reverted before
  the test ends. Check B leaves the registry at its starting role tier and pin.
- It never clicks "Clear legacy pin". `cortextos model revert` refuses to revert a
  pin/unpin operation, so clearing a legacy pin is one-way through the supported verbs
  and a repeatable test must not leave the live registry somewhere it cannot return
  from. The gap is asserted and reported instead.
- It sends no Telegram or email and restarts nothing outside the switch flow itself.
