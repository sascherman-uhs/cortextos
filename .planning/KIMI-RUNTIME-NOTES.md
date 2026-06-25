# Kimi Runtime Notes

Status: partial pass. Runtime wiring, template scaffolding, typecheck, and build pass. End-to-end start/inject did not pass in this sandbox because Kimi is not configured with an LLM/auth profile and PM2 daemon startup hung under repo-local HOME.

## Branch and Commits

- Requested branch: `feat/kimi-runtime`
- Actual branch: `feature/kimi-runtime`
- Deviation: `git switch -c feat/kimi-runtime` failed with `fatal: cannot lock ref 'refs/heads/feat/kimi-runtime': unable to create directory for .git/refs/heads/feat/kimi-runtime`. A later `git branch -m feature/kimi-runtime feat/kimi-runtime` failed moving the reflog with `Operation not permitted`.
- Commits made on `feature/kimi-runtime`:
  - current HEAD: `feat(kimi): update runtime verification notes`
  - `3711607 feat(kimi): verify build and smoke scaffolding`
  - `6b898fc feat(kimi): document runtime verification notes`
  - `12f9b58 feat(kimi): add kimi to AgentConfig.runtime union`
  - `0168d6d feat(kimi): add KimiPTY print-mode adapter`
  - `602e28a feat(kimi): dispatch kimi runtime in agent-process`
  - `2e7402f feat(kimi): accept --runtime kimi in add-agent CLI`
  - `2c088a8 feat(kimi): add agent-kimi template`

## Exact Kimi Argv

Adapter argv in `src/pty/kimi-pty.ts`:

```text
kimi --print --output-format stream-json --work-dir <agent cwd> --prompt <prompt> --afk [--continue]
```

Notes:

- `--continue` is used by the adapter for follow-up injected turns after the first successful print invocation establishes a session.
- `--yolo` is not included because `--print` and `--afk` both auto-dismiss/auto-approve according to live `kimi --help`.
- No `run`, `exec`, `prompt`, `chat`, or `ask` subcommand is used.

Direct smoke commands run:

```text
kimi --version
kimi --help
kimi --print --output-format stream-json --work-dir /Users/sascherman/cortextos --prompt "Say hello in five words." --afk
HOME=/Users/sascherman/cortextos/.tmp/kimi-home kimi --print --output-format stream-json --work-dir /Users/sascherman/cortextos --prompt "Say hello in five words." --afk
HOME=/Users/sascherman/cortextos/.tmp/kimi-home MOONSHOT_API_KEY=dummy kimi --print --output-format stream-json --work-dir /Users/sascherman/cortextos --prompt "Say hello in five words." --afk
```

Observed:

- `kimi --version` passed: `kimi, version 1.47.0`.
- With normal HOME, print mode failed before auth because sandbox writes to `/Users/sascherman/.kimi/logs/kimi.log` are denied.
- With repo-local HOME, print mode failed with `LLM not set`.
- Setting `MOONSHOT_API_KEY=dummy` did not change the `LLM not set` failure.

## Open Questions

OQ-1: stdin vs `--prompt`

- Answer: `--prompt` is sufficient for the current adapter shape and was accepted by live `kimi --help` / invocation parsing.
- No prompt-truncation evidence was observed. The implementation keeps `--prompt` and does not use `--input-format`.

OQ-2: auth/key needed

- Answer: unresolved from live smoke. The CLI did not report a missing Moonshot key; it reported `LLM not set`.
- `MOONSHOT_API_KEY` alone was tested and did not satisfy the CLI.
- Practical requirement appears to be a configured Kimi LLM profile via `~/.kimi/config.toml` and/or `kimi login`. The template includes `MOONSHOT_API_KEY=` in `.env.example` as a likely API-key input for API-backed setups, but the CLI also needs its LLM configured.

OQ-3: `--continue` vs `--session`

- Answer: not fully proven because Kimi could not complete a first successful turn. The adapter defaults daemon boot to fresh, then uses `--continue` for later injected turns after a successful print invocation.
- `--session <id>` is not implemented; no session id is stored.

## Deviations From Plan

- Branch name is `feature/kimi-runtime`, not `feat/kimi-runtime`, due local ref/reflog failures described above.
- `KimiPTY` is standalone rather than extending `AgentPTY`. Reason: Kimi print mode exits after each prompt; treating successful child exit as daemon exit would create crash loops and would make later injections impossible. The adapter is logically persistent and launches one print-mode child per turn.
- End-to-end smoke used `HOME=/Users/sascherman/cortextos/.tmp/...` to avoid sandbox-denied writes under `/Users/sascherman/.cortextos` and `/Users/sascherman/.kimi`.
- The first `add-agent kimi-test` and `add-agent hermes-smoke` attempts created agent directories but failed when registering `~/.cortextos/default/config/enabled-agents.json` due sandbox EPERM. Repo-local HOME retries used `kimi-test-local` and `hermes-smoke-local` and passed scaffolding.
- `cortextos start kimi-test-local` with repo-local HOME started PM2 bootstrap and then hung without returning; the sandbox blocked process inspection/termination via `ps`/`pkill`.

## Verification

Passed:

```text
node -e "0"
npm run typecheck
npm run build
node -e "JSON.parse(require('fs').readFileSync('templates/agent-kimi/config.json','utf8'))"
HOME=/Users/sascherman/cortextos/.tmp/cortex-home node dist/cli.js add-agent kimi-test-local --runtime kimi --org uhs
HOME=/Users/sascherman/cortextos/.tmp/cortex-home node dist/cli.js add-agent hermes-smoke-local --runtime hermes --org uhs
```

Kimi scaffold check:

```text
runtime: kimi
model: kimi-k2
.claude/skills exists: false
```

Blocked/failed:

```text
kimi --print ... --afk
```

Result with repo-local HOME:

```text
LLM not set

To resume this session: kimi -r <session-id>
```

```text
HOME=/Users/sascherman/cortextos/.tmp/cortex-home node dist/cli.js start kimi-test-local
```

Result: PM2 bootstrap started with repo-local `pm2_home`, then the command hung and produced no daemon-ready result.

## Acceptance Criteria Check

1. `git grep "'kimi'"` wiring in `types/index.ts`, `agent-process.ts`, and `add-agent.ts`: pass.
2. `npm run typecheck && npm run build`: pass.
3. `templates/agent-kimi/config.json` exists, valid JSON, `"runtime":"kimi"`, has `model`, no `ecosystem`: pass.
4. `src/pty/kimi-pty.ts` implements `spawn`, `write`, `kill`, `isAlive`, `getPid`, `onExit`, `getOutputBuffer`: pass by typecheck/static inspection. Live output capture reached Kimi process startup but failed before response with `LLM not set`.
5. End-to-end `add-agent` -> `start` -> `bus inject` -> stdout reply: fail/block. Scaffolding passed under repo-local HOME; start/inject did not complete due PM2 hang and missing Kimi LLM config.
6. Other runtime smoke: partial pass. Hermes `add-agent` scaffolding passed under repo-local HOME; start smoke did not run because PM2 start was already hung.
7. Notes recording exact argv and deviations: pass.
