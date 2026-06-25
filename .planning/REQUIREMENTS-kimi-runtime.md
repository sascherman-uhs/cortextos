# REQUIREMENTS — Kimi Runtime for CortexOS (KIMI-01)

> **Goal:** Add `kimi` as a first-class agent runtime in CortexOS, alongside `claude-code`, `hermes`, and `codex-app-server`, so an operator can run `cortextos add-agent <name> --runtime kimi` and have a PM2-managed agent driven by the MoonshotAI Kimi CLI.
>
> **Status:** Draft for autonomous overnight implementation (2026-06-25).
> **Owner:** Scott Ascherman. **Repo:** `~/cortextos`.
> **Companion:** `PLAN-kimi-runtime.md` (task-by-task implementation).

---

## 1. Background & Motivation

CortexOS runs each agent as a PTY-backed CLI process managed by a daemon + PM2. The runtime is selected per-agent via `AgentConfig.runtime` and dispatched in `src/daemon/agent-process.ts`. Today three runtimes exist:

| Runtime | Adapter class | Model | Shape |
|---|---|---|---|
| `claude-code` | `AgentPTY` (`src/pty/agent-pty.ts`) | Claude (CLI default) | Interactive REPL, `/loop` |
| `hermes` | `HermesPTY` (`src/pty/hermes-pty.ts`) | configurable | One-shot CLI, `❯` bootstrap |
| `codex-app-server` | `CodexAppServerPTY` (`src/pty/codex-app-server-pty.ts`) | gpt-5-codex | JSON-RPC app-server, per-turn exec |

Adding Kimi gives the fleet a fourth, independent model provider (Moonshot Kimi) for redundancy and cost/capability diversity. It is the same class of work the Hermes adapter already models.

## 2. Verified Facts (ground truth — do NOT re-assume)

### 2.1 The PTY contract is structural (duck-typed)
There is **no formal interface file**. `agent-process.ts:25` declares `private pty: AgentPTY | CodexAppServerPTY | null`. Any adapter must implement this public surface (the only methods the daemon calls):

| Method | Signature | Responsibility |
|---|---|---|
| `spawn` | `async spawn(mode:'fresh'\|'continue', prompt:string): Promise<void>` | Launch process; wire `onData`→outputBuffer, `onExit`→registered handler |
| `write` | `write(data:string): void` | Raw stdin (stop sequences, cron injection) |
| `kill` | `kill(): void` | Terminate; set `_alive=false` |
| `isAlive` | `isAlive(): boolean` | Liveness |
| `getPid` | `getPid(): number\|null` | PID |
| `onExit` | `onExit(handler:(code:number, signal?:number)=>void): void` | Register exit callback (called once, before `spawn`) |
| `getOutputBuffer` | `getOutputBuffer(): OutputBuffer` | Return buffer (used by `isBootstrapped`, logging) |

`setTelegramHandle(api, chatId)` exists **only** on `CodexAppServerPTY` and is called conditionally (`agent-process.ts:141,395`) — **not required** for kimi.

### 2.2 Bootstrap detection
`OutputBuffer` (`src/pty/output-buffer.ts:101`) does a substring check of stripped output against `bootstrapPattern` (constructor arg 3). Existing patterns: claude=`'permissions'`, hermes=`'❯'`, codex=`'[codex-app-server] ready'`. For a one-shot `--print` runtime there is no interactive prompt, so the adapter should **mark bootstrapped immediately after spawn** (override `isBootstrapped()` to return `true`, or pass an always-present sentinel).

### 2.3 Kimi CLI interface (VERIFIED against `/opt/homebrew/bin/kimi --help`, 2026-06-25)
The earlier scoping research **guessed wrong** on the CLI; these are the real flags. Kimi is a Click CLI; the **default top-level command runs the agent** (there is NO `run`/`exec`/`prompt`/`chat`/`ask` subcommand — those error). Relevant options:

| Flag | Meaning |
|---|---|
| `--prompt / -p / -c TEXT` | User prompt to the agent (else interactive) |
| `--print` | Non-interactive print mode — **auto-dismisses AskUserQuestion, auto-approves tool calls** |
| `--input-format [text\|stream-json]` | With `--print`, input piped via stdin |
| `--output-format [text\|stream-json]` | With `--print`, output format |
| `--final-message-only` | Print only the final assistant message |
| `--quiet` | Alias for `--print --output-format text --final-message-only` |
| `--yolo / -y / --yes` | Auto-approve all actions |
| `--afk` | Away-from-keyboard: no user present, auto-dismiss + auto-approve (ideal for a daemon) |
| `--work-dir / -w DIRECTORY` | Agent working directory |
| `--add-dir DIRECTORY` | Additional workspace dirs (repeatable) |
| `--continue / -C` | Continue the previous session for the working directory |
| `--session / -S / -r [ID]` | Resume a session (with ID, or interactive picker) |
| `--model / -m TEXT` | LLM model (default from `~/.kimi/config.toml`) |
| `--config / --config-file` | Inline or file TOML/JSON config |
| `--agent [default\|okabe] / --agent-file FILE` | Agent spec |
| `--mcp-config-file FILE` | MCP config (repeatable) |
| `kimi acp` | Agent Client Protocol **server** mode (codex-app-server analogue) |
| `--wire` | Wire server mode (experimental) |

**Known environment gotcha** (`memory/reference_kimi_cli.md`): the Homebrew kimi runs on python@3.14 and crashed on macOS 26.1 with a `pyexpat`/system-libexpat symbol mismatch; fixed by relinking pyexpat to `/opt/homebrew/opt/expat` + codesigning. The binary currently launches (verified `kimi --help` works), but the adapter must surface a clear error if the CLI dies on boot rather than hanging.

### 2.4 Runtime type union — single location
`src/types/index.ts:203`: `runtime?: 'claude-code' | 'hermes' | 'codex-app-server';` — the **only** place the union is declared. `add-agent.ts` keeps its own parallel `VALID_RUNTIMES` constant.

### 2.5 Build/run
`npm run typecheck` (tsc --noEmit) → `npm run build` (tsup; entries `src/cli/index.ts`→`dist/cli.js`, `src/daemon/index.ts`→`dist/daemon.js`). A new `src/pty/kimi-pty.ts` is bundled into `dist/daemon.js` automatically — no tsup entry change. Templates live in `templates/` (`agent`, `agent-codex`, `hermes`, …).

## 3. Functional Requirements

- **FR-1** A `kimi` value is accepted everywhere a runtime is accepted: `AgentConfig.runtime` type, `add-agent` CLI `--runtime kimi`, config.json injection, import/export pass-through.
- **FR-2** `cortextos add-agent <name> --runtime kimi --org <org>` scaffolds an agent from a new `templates/agent-kimi/` template with `"runtime":"kimi"` and a `model` field, and (like codex/hermes) does **not** create a `.claude/skills` dir.
- **FR-3** A new `KimiPTY` adapter (`src/pty/kimi-pty.ts`) implements the §2.1 surface and spawns the kimi CLI in non-interactive print mode.
- **FR-4** `spawn('fresh', prompt)` starts a new session; `spawn('continue', prompt)` adds `--continue` to resume the working-dir session. `shouldContinue()` for kimi returns based on session-state presence (default: `false`/fresh until session continuity is proven).
- **FR-5** The daemon dispatches a `kimi` runtime to `KimiPTY` (PTY instantiation, graceful-stop, `shouldContinue`) without regressing the other three runtimes.
- **FR-6** Graceful stop for a one-shot print process is `kill()` (no REPL `/exit` dance — same treatment as codex).
- **FR-7** Output streams into `OutputBuffer`; the agent is considered bootstrapped immediately (no interactive prompt to wait for).
- **FR-8** A `kimi-test` agent can be added, started, injected with one turn, and its response observed in `~/.cortextos/<org>/logs/kimi-test/stdout.log`.

## 4. Non-Functional Requirements

- **NFR-1 No regressions.** `npm run typecheck` and `npm run build` pass; existing claude-code/hermes/codex agents unaffected. The only union/dispatch edits are additive arms.
- **NFR-2 Daemon-safe invocation.** Run with `--print` (and `--afk` and/or `--yolo`) so no invocation ever blocks waiting on a human. Never spawn interactive kimi from the daemon.
- **NFR-3 Fail loud, not hang.** If the kimi CLI exits non-zero on boot (e.g. the pyexpat crash), the adapter logs the stderr and fires `onExit` — it must not silently hang the agent.
- **NFR-4 Reversible.** All work is git-tracked in `~/cortextos`; no global installs, no edits outside the repo (except the agent scaffold under `orgs/<org>/` which `add-agent` already manages).
- **NFR-5 Minimal surface.** Model on `HermesPTY` (~143 lines). Do not introduce JSON-RPC/thread management unless the print-mode path proves insufficient (ACP is a documented future option, §6).

## 5. Acceptance Criteria (Definition of Done)

1. `git grep "'kimi'"` shows the runtime wired in `types/index.ts`, `agent-process.ts`, and `add-agent.ts`.
2. `npm run typecheck && npm run build` exit 0.
3. `templates/agent-kimi/config.json` exists, valid JSON, `"runtime":"kimi"`, has `model`, no `ecosystem` block.
4. `src/pty/kimi-pty.ts` implements the full §2.1 surface; a focused unit/integration check (or a scripted `spawn('fresh','say hello')`) shows kimi output captured in the OutputBuffer.
5. End-to-end: `cortextos add-agent kimi-test --runtime kimi --org <org>` → `cortextos start kimi-test` → `cortextos bus inject kimi-test "Say hello"` → a kimi reply appears in the agent stdout log.
6. The other three runtimes still add/start (smoke-check at least claude-code or hermes).
7. A short `KIMI-RUNTIME-NOTES.md` (or PR/commit body) records the exact kimi argv used and any deviations from this doc.

## 6. Out of Scope / Future

- **ACP server adapter** (`kimi acp`) — a persistent JSON-RPC adapter analogous to `CodexAppServerPTY` with real per-turn streaming. Only pursue if one-shot print mode is inadequate for the fleet's interaction model. Track as KIMI-02.
- **stream-json output parsing** into structured turn events — first implementation may push raw output; structured parsing is an enhancement.
- Fixing the Homebrew python@3.14 pyexpat issue permanently (already worked around; out of scope here).

## 7. Open Questions (resolve during implementation, record answers)

- **OQ-1** Does the daemon need to pipe the prompt via stdin (`--input-format`) or is `--prompt`/`-p` sufficient for the agent-process injection model? (Prefer `--prompt` flag; fall back to stdin if the flag truncates long prompts.)
- **OQ-2** Which auth/key does kimi need at runtime (Moonshot API key env var vs `~/.kimi/config.toml`)? Document the env var the template/agent `.env` must carry, mirroring how codex/hermes templates handle keys.
- **OQ-3** Does `--continue` reliably resume per-working-dir for the daemon's `continue` mode, or is `--session <id>` (with a stored id) more robust? Default to `--continue`; note findings.
