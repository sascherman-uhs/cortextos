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
  if (c) {
    c.resume().catch(() => {});
    if (!unlocked) {
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
  }
  // === JARVIS MOD #107: the gesture also unlocks every registered <audio>. ===
  gestureSeen = true;
  for (const el of registeredEls) primeMediaElement(el);
}

// === JARVIS MOD #107 — HTMLMediaElement gesture priming (2026-08-09) ===
// A resumed AudioContext is NOT enough for the WebRTC lane. The Realtime
// remote track arrives on an <audio> element, and iOS gates play() PER ELEMENT
// on a user gesture — the same lesson MOD #28 learned for per-segment
// `new Audio(blobUrl)`, which is why TTS moved to buffer sources. The remote
// track cannot be a buffer source (it is a live MediaStream), so the element
// itself has to be primed inside a gesture instead.
//
// Priming means: play() the element while it is muted and pointed at ten
// milliseconds of silence, then pause and unmute. iOS records that this element
// has played under a gesture and permits later programmatic play() calls on it
// for the life of the page. The silent source matters — play() on an element
// with no source rejects, and a rejected prime teaches iOS nothing.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let gestureSeen = false;
const registeredEls = new Set<HTMLMediaElement>();
const primedEls = new WeakSet<HTMLMediaElement>();

/** The 10ms silent clip a freshly-created element should hold so priming has
 *  something to play. Exported so the caller can set it at construction. */
export function silentMediaSource(): string {
  return SILENT_WAV_DATA_URI;
}

/**
 * Prime one element inside (or after) a user gesture. Idempotent; a failed
 * attempt is NOT remembered, so the next gesture retries. Safe to call before
 * any gesture has happened — it simply fails and gets retried by
 * unlockSharedAudio().
 */
export function primeMediaElement(el: HTMLMediaElement): void {
  if (primedEls.has(el)) return;
  const wasMuted = el.muted;
  el.muted = true;
  let p: Promise<void> | undefined;
  try {
    p = el.play();
  } catch {
    el.muted = wasMuted;
    return;
  }
  if (!p) {
    // Older WebKit returns undefined from play() — treat as primed.
    primedEls.add(el);
    el.pause();
    el.muted = wasMuted;
    return;
  }
  p.then(() => {
    primedEls.add(el);
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      /* not seekable yet — harmless */
    }
    el.muted = wasMuted;
  }).catch(() => {
    // No gesture yet (or the source failed). Leave it unprimed so the next
    // gesture through unlockSharedAudio() tries again.
    el.muted = wasMuted;
  });
}

/**
 * Register an element to be primed by the first (or next) user gesture. Call
 * once at element creation; the returned fn unregisters it at teardown.
 */
export function registerMediaElement(el: HTMLMediaElement): () => void {
  registeredEls.add(el);
  if (gestureSeen) primeMediaElement(el);
  return () => {
    registeredEls.delete(el);
  };
}

/** True once any user gesture has reached unlockSharedAudio(). */
export function audioGestureSeen(): boolean {
  return gestureSeen;
}
// === END JARVIS MOD #107 ===
// === END JARVIS MOD #25 ===
