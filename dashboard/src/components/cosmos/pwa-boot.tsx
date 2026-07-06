// === JARVIS MOD #25 — PWA boot: service worker + iOS audio unlock (2026-07-05) ===
// New file (isolated). Renders nothing; wires three mobile/PWA concerns for the
// /jarvis route only (mounted from cosmos-client):
//   1. iOS audio unlock — the first user gesture (touchend/click) resumes the
//      shared AudioContext so JARVIS' TTS is audible on a phone. The mic handler
//      also unlocks directly, but this catches the case where the user taps some
//      other control (mute, the text box) before ever pressing the mic.
//   2. Resume on visibilitychange — iOS suspends WebAudio when a standalone PWA is
//      backgrounded; bringing it back to the foreground must resume audio.
//   3. Service worker registration — ONLY over HTTPS or in a production build, so
//      the cache-first worker never fights `next dev` hot reload on http://localhost.
'use client';

import { useEffect } from 'react';
import { unlockSharedAudio, resumeSharedAudio } from './audio-unlock';

export function PwaBoot() {
  useEffect(() => {
    // 1. First-gesture audio unlock (once: self-removing after the first fire).
    const unlock = () => unlockSharedAudio();
    window.addEventListener('touchend', unlock, { once: true, passive: true });
    window.addEventListener('click', unlock, { once: true });

    // 2. Resume audio when the PWA returns to the foreground.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resumeSharedAudio();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 3. Register the service worker only when it is safe to cache: HTTPS (the
    //    Tailscale serve origin, where the mic + PWA install actually run) or a
    //    production build. On plain http://localhost dev we skip it so a stale
    //    cache never masks hot reload.
    const httpsOrProd =
      window.location.protocol === 'https:' || process.env.NODE_ENV === 'production';
    if ('serviceWorker' in navigator && httpsOrProd) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    return () => {
      window.removeEventListener('touchend', unlock);
      window.removeEventListener('click', unlock);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return null;
}
// === END JARVIS MOD #25 ===
