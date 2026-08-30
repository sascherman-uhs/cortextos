# LOCAL_MODS.md — Cortextos Dashboard Local Modifications

Tracks modifications made to the cortextos dashboard outside the upstream framework,
so they can be reapplied after framework upgrades.

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
