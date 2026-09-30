# LOCAL_MODS.md — Cortextos Dashboard Local Modifications

Tracks modifications made to the cortextos dashboard outside the upstream framework,
so they can be reapplied after framework upgrades.

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
