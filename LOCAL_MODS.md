# LOCAL_MODS.md — Cortextos Dashboard Local Modifications

Tracks modifications made to the cortextos dashboard outside the upstream framework,
so they can be reapplied after framework upgrades.

---

## MOD #53 — Provable Telegram delivery (A1–A7 + V5, 2026-09-30)

Delivery is now proven from Claude Code's own session record, not the terminal. At 05:38 a long paste
rendered collapsed (`[Pasted text #1 +9 lines]`), the header needle never showed, Scott got a false "I may
have missed your message", and the paste sat unsubmitted in the composer. Now:
- Every Telegram block's header carries `⟦u:<update_id>⟧` (placed before `(chat_id:…)` so A0's stripper
  still matches). Proof = a JSONL entry carrying the token that is a genuine human prompt (origin/turnOrigin
  human, promptSource present, no tool result, not compaction/sidechain/meta) or a `queued_command`
  attachment (a mid-turn submission — 23 of 49 Telegram pastes in the previous session exist ONLY in that
  form); an `enqueue` row proves submission only, and only when its text IS our block (enqueue rows carry
  no provenance; task notifications are enqueued too). Submitted-but-unread stays its own state: never
  unverified, never resolved by a reply, scanned until read. Any file in the agent's `~/.claude/projects/<slug>/`
  (shared cwd), full rescans ≤ every 5 s, entries older than the attempt never count. Other runtimes: the
  token in normalized PTY output.
- Persist-before-write: token, attempt start, deadline, PTY instance are written and verified BEFORE the
  first byte; a pasted record is `in_flight` and never pasted again. No proof in 60 s ⇒ `submit_phase:
  'stuck'`: later messages queue behind it in that PTY, ONE truthful receipt to Scott, the watchdog alerts;
  ONLY submission proof or a new PTY clears the gate (not a reply to the chat, not the 24 h window). Admissions only on positive non-delivery (nothing written, twice).
- Boot hold: no Telegram paste until THIS PTY bootstrapped and its boot prompt's turn ended in the JSONL.
  Past `TELEGRAM_BOOT_HOLD_MAX_MS` (default 10 min) it ESCALATES (loud log + `hold_escalated_at` on held
  records, reported by the watchdog as HELD) and keeps holding — elapsed time is not readiness. The deferred Enter is cancelled if the PTY is
  replaced. The PTY "at prompt" heuristic matched 0 of 125 injections 9/24–9/30 and is not used for this.
- Answered records are archived to `pending-telegram-resolved/` (resolved_at + resolution), pruned after 7 d;
  `insert()` is create-if-absent (redelivery is a no-op); `patch()` carries a `rev` guard.
- Sender notices are recorded only after they were sent (max 3 tries, then `notify_failed`).
- Receipt acks come from the records (45 s, then 10 min), independent of agent activity; persisted per record.
- Media (A3): gen-fenced downloads to `telegram-images/<update_id>-<name>.part.<gen>`, one retry, then one
  block (caption + note) or a notice; resume + reconciliation on restart. A media job stays counted until
  its completion patch lands or is discarded. Voice transcription writes a distinct temp WAV
  (src/telegram/transcribe.ts — the `.ogg$`-derived path equalled the part file and deleted it).
- Inbound rows now carry `update_id`. The transcript send-attempt rail no longer counts as a reply.
Scan cost (R4-5, real uhsJARVIS dir, 5 s cadence): no-cache p95 319 ms (1 h window) / 538 ms (24 h), so the
(dev, ino, size, mtime_ns) parse cache is ON (p95 21–22 ms); `TELEGRAM_PROOF_SCAN_CACHE=0` disables it.

Modified: src/telegram/{pending-queue,media,logging}.ts, src/daemon/{fast-checker,agent-manager,agent-process}.ts,
src/pty/inject.ts. New: src/telegram/submission-proof.ts, scripts/measure-proof-scan.ts. Tests:
tests/unit/telegram/{submission-proof,provable-delivery,delivery-store-acks,media-a3,rollback-compat}.test.ts
(fixtures recorded: tests/fixtures/telegram/claude-session-entries…, stdout-collapsed-paste…).

Rollback = A0 (16fd942) via MOD #52's drain script, then revert/redeploy + /restart-cortexos. Safe because
pasted/stuck/submitted records are `in_flight` (A0 never re-injects or admits those), pending A3 media is
held by A0 and blocks the drain, and every other new field is ignored by A0 (tests/unit/telegram/
rollback-compat.test.ts runs a frozen copy of A0's queue against records this code wrote).

---

## MOD #52 — Telegram media race fix + intake pause / rollback drain (A0, 2026-09-30)

The durable queue persisted a raw media record (`formatted=''`) before the download; the checker saw it
within ~1s, treated it as "daemon died", and marked it `failed_notified` with no notice — 23 of 25 photos
to jarvis-telegram dropped 9/24–9/29 (incident: update 462809160, 04:41:31→33). Raw media is now held for
`TELEGRAM_MEDIA_GRACE_MS` (default 180s; measured persist→updated gap 1–3s over all 25 records), then:
captioned ⇒ caption injected with a still-downloading note; captionless ⇒ sender told to resend, marked only
after the send succeeds; a late download re-arms the record. Durable mode only (TELEGRAM_DURABLE_QUEUE).

Also: `state/<agent>/telegram-intake-paused` pauses the agent's poller between batches, and
`state/<agent>/telegram-intake-status.json` publishes the pause ack + outstanding media jobs (pid + start
time). `npx tsx scripts/telegram-media-rollback.ts --agent <name>` is the drain gate to run BEFORE rolling
this back (or rolling A1+ back to it): it aborts, leaving the daemon untouched, unless nothing is mid-download.

Modified files: src/telegram/pending-queue.ts, src/daemon/fast-checker.ts, src/daemon/agent-manager.ts,
src/telegram/poller.ts, src/telegram/media.ts. New: src/telegram/intake-control.ts,
scripts/telegram-media-rollback.ts. Tests: tests/unit/telegram/{media-race-a0,intake-control}.test.ts,
tests/unit/daemon/agent-manager-media-a0.test.ts (fixtures: tests/fixtures/telegram/, recorded).

Activates on next daemon restart. Rollback: run the drain script, then `git revert` + /restart-cortexos,
then `--release`.

---

## MOD #51 — Telegram command registration cap (2026-08-30)

`collectTelegramCommands()` scans `[agentDir, frameworkRoot]`; the framework tree has ~210 `SKILL.md`, so any
agent with its own `.claude/skills` exceeded Telegram's 100-command limit → `BOT_COMMANDS_TOO_MUCH` → registered
nothing (jarvis-telegram 43×, vera 25×, vivienne 26× in the daemon log). Cap at 100, agent-dir skills first.

Modified files:
- src/bus/metrics.ts — cap + warn (source of truth)
- dist/daemon.js — same edit applied by hand (no rebuild: src/daemon/agent-manager.ts had another session's WIP)

Activates on next daemon restart (`pm2 restart cortextos-daemon`). Reapply after upstream `cortextos update`.

---

## MOD #50 — OpenAI Realtime Voice Integration (2026-07-27)

Feature-flagged addition of OpenAI gpt-4o-realtime-preview as the /jarvis PWA voice backend.
Replaces Deepgram STT + ElevenLabs TTS on the PWA when NEXT_PUBLIC_CTX_REALTIME_VOICE=1.
Telegram voice path (Deepgram) is unchanged.

New files:
- dashboard/src/app/api/uhs/realtime/session/route.ts — ephemeral token endpoint
- dashboard/src/components/cosmos/use-realtime-voice.ts — WebRTC voice hook
- dashboard/src/lib/realtime/jarvis-prompt.ts — condensed JARVIS system prompt

Modified files:
- dashboard/src/components/cosmos/voice-panel.tsx — conditional hook swap
- dashboard/.env.local — OPENAI_REALTIME_MODEL, OPENAI_REALTIME_VOICE, NEXT_PUBLIC_CTX_REALTIME_VOICE

To activate: set NEXT_PUBLIC_CTX_REALTIME_VOICE=1 in .env.local, restart dash-cortextos.
Kill-switch: set back to 0, restart.

Rollback: zero code changes — all new files can be deleted; voice-panel edit is one line.
