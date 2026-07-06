// === JARVIS MOD #25 — shared AudioContext singleton + iOS unlock (2026-07-05) ===
// New file (isolated). Owns the ONE AudioContext for the whole Cosmos session.
//
// Why this exists: iOS Safari starts every AudioContext in the `suspended` state
// and keeps HTMLAudioElement output routed through WebAudio silent until a user
// gesture resumes it. MOD #24 created a fresh AudioContext per reply *inside*
// use-tts and closed it after each reply — but that context was always born far
// from any user gesture (the mp3 bytes land async, long after the mic tap), so on
// iOS it could never leave `suspended` and JARVIS was mute on the phone. By
// hoisting the context to a module-level singleton, a single first-gesture resume
// (see PwaBoot / the mic handler) unlocks audio for the entire session, and
// use-tts reuses the SAME context + analyser for every segment's orb amplitude.
//
// This is deliberately framework-agnostic (plain module state, no React) so the
// gesture layer and the TTS hook can share one context without prop-drilling.
'use client';

type ACConstructor = typeof AudioContext;

let ctx: AudioContext | null = null;
let unlocked = false;

function getConstructor(): ACConstructor | null {
  if (typeof window === 'undefined') return null;
  // Safari still ships the prefixed constructor.
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: ACConstructor }).webkitAudioContext ??
    null
  );
}

/** Lazily create (or return) the one shared AudioContext. Returns null if the
 *  browser has no WebAudio at all. */
export function getSharedAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = getConstructor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Resume the shared context if it drifted to `suspended` (e.g. iOS backgrounded
 *  the PWA and suspended audio). Safe to call repeatedly / on visibilitychange. */
export function resumeSharedAudio(): void {
  const c = getSharedAudioContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

/**
 * Unlock audio from inside a user gesture (touchend / click). Creates the context
 * if needed, resumes it, and plays a 1-sample silent buffer — the canonical iOS
 * gesture-unlock handshake that flips WebAudio to `running` for the session. The
 * silent-buffer nudge runs at most once; the resume() is idempotent so this is
 * cheap to attach to the first gesture of any control.
 */
export function unlockSharedAudio(): void {
  const c = getSharedAudioContext();
  if (!c) return;
  c.resume().catch(() => {});
  if (unlocked) return;
  try {
    const buffer = c.createBuffer(1, 1, 22050);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    source.start(0);
    unlocked = true;
  } catch {
    /* ignore — resume() above still gives us the best-effort unlock */
  }
}
// === END JARVIS MOD #25 ===
