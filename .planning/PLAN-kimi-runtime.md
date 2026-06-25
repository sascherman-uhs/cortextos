# PLAN — Kimi Runtime for CortexOS (KIMI-01)

> Task-by-task implementation plan. Companion to `REQUIREMENTS-kimi-runtime.md`.
> Execute in order; each task is small and independently verifiable. Commit per task
> (atomic commits, conventional messages, prefix `feat(kimi):`). Work entirely in `~/cortextos`.

## Pre-flight (do first, ~5 min)
- [ ] `cd ~/cortextos && git status` — note the current branch and that the tree is clean enough to work in. If on `main`, create a branch: `git checkout -b feat/kimi-runtime`.
- [ ] Re-read the §2 "Verified Facts" in REQUIREMENTS — especially the **real** kimi CLI flags (`--print`, `--prompt/-p`, `--work-dir/-w`, `--continue`, `--output-format`, `--afk`, `--yolo`). Do NOT trust any earlier `kimi run/exec` assumption — those subcommands do not exist.
- [ ] `node -e "0"` and `npm run typecheck` once to confirm a green baseline BEFORE any edit (so a later failure is attributable to your change).
- [ ] Confirm the kimi binary: `kimi --version`. If it crashes (pyexpat), STOP and surface — the adapter is untestable until the CLI launches.

## Task 1 — Add `kimi` to the runtime type union
**File:** `src/types/index.ts:203`
- [ ] Change `runtime?: 'claude-code' | 'hermes' | 'codex-app-server';` → add `| 'kimi'`.
- [ ] `npm run typecheck` — still green (additive).
- [ ] Commit: `feat(kimi): add kimi to AgentConfig.runtime union`.

## Task 2 — Create the `KimiPTY` adapter
**File:** `src/pty/kimi-pty.ts` (new). **Model on:** `src/pty/hermes-pty.ts`.
- [ ] Copy the structure of `HermesPTY`. Keep it minimal (~target ≤180 lines).
- [ ] `getBinaryName()` → `'kimi'` (resolve absolute path if hermes/agent-pty does; `/opt/homebrew/bin/kimi`).
- [ ] Build argv for non-interactive daemon use:
      `['--print', '--output-format', 'stream-json', '--work-dir', <agent cwd>, '--prompt', prompt]`
      plus `'--yolo'` (and/or `'--afk'`) so nothing blocks on approval. For `mode==='continue'` append `'--continue'`.
      (If long prompts truncate as a flag — OQ-1 — switch to `--input-format stream-json` + write the prompt to stdin via `write()`. Try the flag first.)
- [ ] In `spawn()`: launch via the inherited node-pty machinery; push all PTY data raw into `getOutputBuffer().push(data)`; wire `onExit` to the registered handler; set `_alive`.
- [ ] Override `isBootstrapped()` → return `true` immediately (print mode has no interactive prompt). Alternatively pass a bootstrap pattern that always matches; the override is cleaner.
- [ ] Ensure `write`, `kill`, `isAlive`, `getPid`, `onExit`, `getOutputBuffer` are satisfied (inherit from `AgentPTY` if you extend it, as Hermes does).
- [ ] `npm run typecheck` — green.
- [ ] Commit: `feat(kimi): add KimiPTY print-mode adapter`.

## Task 3 — Wire runtime dispatch in the daemon
**File:** `src/daemon/agent-process.ts`
- [ ] **PTY instantiation** (~L132-136 ternary): add a `this.config.runtime === 'kimi' ? new KimiPTY(this.env, this.config, logPath) :` arm before the final `new AgentPTY(...)` fallback. Add the `import { KimiPTY } from '../pty/kimi-pty';` at top.
- [ ] **Graceful stop** (~L227-253): add a `kimi` arm that does NOT do the Ctrl-C + `/exit` REPL dance — a no-op/`kill()` like the codex branch (one-shot process exits on its own).
- [ ] **`shouldContinue()`** (~L641): add a `kimi` arm. Default `return false` (stateless/fresh) unless you implement session continuity in Task 2 — if so, gate on the presence of a kimi session for the working dir.
- [ ] Leave the codex-only Telegram guards (L141, L392, L818) untouched — they correctly skip non-codex runtimes.
- [ ] `npm run typecheck` — green.
- [ ] Commit: `feat(kimi): dispatch kimi runtime in agent-process`.

## Task 4 — CLI `add-agent` support
**File:** `src/cli/add-agent.ts`
- [ ] Add `'kimi'` to the `VALID_RUNTIMES` const (~L8).
- [ ] Skip `.claude/skills` mkdir for kimi: extend the `!isCodexAppServer` guard (~L108) to also exclude kimi (`const isKimi = options.runtime === 'kimi'`).
- [ ] Template resolution (~L116): when `isKimi && options.template === 'agent'`, use `'agent-kimi'`.
- [ ] (Optional) Add a `NON_KIMI_TEMPLATES` guard mirroring the codex one if certain templates have no kimi variant.
- [ ] Runtime injection into config.json (~L172) is already generic (`runtime !== 'claude-code'`) — verify, no change expected.
- [ ] `npm run typecheck` — green.
- [ ] Commit: `feat(kimi): accept --runtime kimi in add-agent CLI`.

## Task 5 — Agent template
**File:** `templates/agent-kimi/config.json` (new; copy `templates/hermes/config.json` shape, drop hermes-only ctx fields if unused).
- [ ] Contents: `agent_name` placeholder, `enabled:true`, `"runtime":"kimi"`, a `model` field (kimi's model id — confirm the default in `~/.kimi/config.toml`; e.g. `"kimi-k2"` or whatever is set), a `crons` array with the standard heartbeat, NO `ecosystem` block.
- [ ] If the template dir needs sibling files (e.g. an `.env.example`, `HEARTBEAT.md`), mirror `templates/hermes/` contents. Document the required Moonshot API key env var (OQ-2) in the template's `.env.example`.
- [ ] Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('templates/agent-kimi/config.json','utf8'))"`.
- [ ] Commit: `feat(kimi): add agent-kimi template`.

## Task 6 — Build + end-to-end smoke test
- [ ] `npm run build` — exits 0; confirm `dist/daemon.js` and `dist/cli.js` regenerated.
- [ ] Pick a test org (`ls orgs/`). Add the agent:
      `node dist/cli.js add-agent kimi-test --runtime kimi --org <org>` (or the installed `cortextos` bin).
- [ ] Inspect the scaffold: `cat orgs/<org>/agents/kimi-test/config.json` → `"runtime":"kimi"`. Put the Moonshot key in `orgs/<org>/agents/kimi-test/.env` if required (OQ-2).
- [ ] Start it (daemon must be running): `cortextos start kimi-test`.
- [ ] Inject one turn: `cortextos bus inject kimi-test "Say hello in five words."`
- [ ] Observe: `tail -f ~/.cortextos/<org or default>/logs/kimi-test/stdout.log` — a kimi reply appears.
- [ ] Regression smoke: confirm an existing claude-code or hermes agent still `add-agent`s / starts.
- [ ] If start/inject hangs: check the argv actually includes `--print` (and `--yolo`/`--afk`); a hang almost always means an interactive prompt is waiting.

## Task 7 — Document + finish
- [ ] Write `~/cortextos/.planning/KIMI-RUNTIME-NOTES.md` recording: the exact kimi argv used, the resolved answers to OQ-1/2/3, any file/line deviations from this plan, and the test transcript (the injected prompt + the captured reply).
- [ ] `git log --oneline` should show ~6 atomic commits.
- [ ] Leave the branch `feat/kimi-runtime` for morning review (do NOT merge to main or push autonomously — that's an external action requiring Scott's approval). Summarize status at the top of KIMI-RUNTIME-NOTES.md, including which Acceptance Criteria (REQUIREMENTS §5) pass/fail.

## Risk register
- **R1 — kimi CLI flags differ at runtime from --help.** Mitigation: Task 6 smoke test catches it; adjust argv in Task 2.
- **R2 — pyexpat boot crash recurs.** Mitigation: Pre-flight `kimi --version` gate; adapter fails loud (NFR-3).
- **R3 — prompt truncation via flag.** Mitigation: OQ-1 fallback to stdin `--input-format`.
- **R4 — fleet edits shared files concurrently** (`reference_fleet_concurrent_file_edits`). Mitigation: edit by function/symbol, re-`git status` before each commit; these files (agent-process.ts, types/index.ts) are core — verify HEAD vs working tree.
- **R5 — auth/key missing** (OQ-2). Mitigation: smoke test surfaces an auth error in the log; document the env var.
