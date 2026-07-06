// === JARVIS MOD #21 — Cosmos TTS playback hook (2026-07-03) ===
// New file (isolated). Owns the CLIENT side of the three-tier TTS strategy:
//   - speak(text): POST /api/uhs/tts, branch on the returned x-tts-path.
//       * audio/mpeg  → play <audio> through a WebAudio AnalyserNode and drive a
//                       live 0..1 orb amplitude while playing (state held
//                       'responding' for the duration).
//       * path:'say'  → server already spoke on the Mac; hold a synthetic gentle
//                       orb pulse for ~min(words*0.4s, 20s).
//       * path:'browser' → speak via window.speechSynthesis with an onend handler.
//   - Mute toggle persisted in localStorage 'cosmos-tts-muted' (default UNMUTED);
//     when muted, speak() is a no-op and NO /api/uhs/tts call fires.
//   - Exposes the last used path + muted flag on window.__cosmosStats for tests.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MUTE_KEY = 'cosmos-tts-muted';
type TtsPath = 'elevenlabs' | 'say' | 'browser' | null;

export interface UseTtsResult {
  muted: boolean;
  toggleMute: () => void;
  /** Speak a reply through the three-tier strategy (no-op while muted). */
  speak: (text: string) => Promise<void>;
  /** Live 0..1 amplitude while TTS is audible (drives the orb). */
  ttsAmplitude: number;
  /** True while any tier is producing output. */
  speaking: boolean;
}

// NOTE: the Window.__cosmosStats ambient type is declared once in scene.tsx
// (single source of truth). We only read/write its fields here.

function writeStats(patch: Partial<NonNullable<Window['__cosmosStats']>>) {
  if (typeof window === 'undefined') return;
  window.__cosmosStats = { ...(window.__cosmosStats ?? {}), ...patch };
}

export function useTts(): UseTtsResult {
  const [muted, setMuted] = useState(false);
  const [ttsAmplitude, setTtsAmplitude] = useState(0);
  const [speaking, setSpeaking] = useState(false);

  // Keep a ref of `muted` so speak() (stable identity) always sees the latest.
  const mutedRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate mute state from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(MUTE_KEY);
      const isMuted = stored === 'true';
      setMuted(isMuted);
      mutedRef.current = isMuted;
    } catch {
      /* localStorage unavailable — default unmuted */
    }
    writeStats({ ttsMuted: mutedRef.current, ttsPath: window.__cosmosStats?.ttsPath ?? null });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      try {
        window.localStorage.setItem(MUTE_KEY, String(next));
      } catch {
        /* ignore */
      }
      writeStats({ ttsMuted: next });
      // If we just muted mid-utterance, cut all output immediately.
      if (next) stopAllRef.current();
      return next;
    });
  }, []);

  const stopAmplitudeLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setTtsAmplitude(0);
  }, []);

  const stopAll = useCallback(() => {
    if (pulseTimerRef.current) {
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      const src = audioRef.current.src;
      audioRef.current.src = '';
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      audioRef.current = null;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    stopAmplitudeLoop();
    setSpeaking(false);
  }, [stopAmplitudeLoop]);

  // stopAll referenced from toggleMute (declared earlier) via a ref to dodge
  // the declaration-order / stable-identity dance.
  const stopAllRef = useRef(stopAll);
  useEffect(() => {
    stopAllRef.current = stopAll;
  }, [stopAll]);

  /** Play mp3 bytes through <audio> + AnalyserNode, driving ttsAmplitude. */
  const playAudioBuffer = useCallback(
    (buf: ArrayBuffer) =>
      new Promise<void>((resolve) => {
        const blob = new Blob([buf], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;

        let ctx: AudioContext | null = null;
        try {
          ctx = new AudioContext();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          analyserRef.current = analyser;

          const data = new Uint8Array(analyser.frequencyBinCount);
          const tick = () => {
            const a = analyserRef.current;
            if (!a) return;
            a.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            setTtsAmplitude(Math.min(1, sum / data.length / 255));
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
        } catch {
          // WebAudio unavailable — audio still plays, amplitude stays flat.
        }

        const finish = () => {
          stopAmplitudeLoop();
          if (audioRef.current === audio) {
            audio.src = '';
            audioRef.current = null;
          }
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onended = finish;
        audio.onerror = finish;
        audio.play().catch(finish);
      }),
    [stopAmplitudeLoop],
  );

  /** Synthetic gentle orb pulse for tier 2 ('say', server-side speech). */
  const holdPulse = useCallback(
    (words: number) =>
      new Promise<void>((resolve) => {
        const durationMs = Math.min(words * 400, 20_000);
        const start = performance.now();
        const tick = () => {
          const t = (performance.now() - start) / 1000;
          // Slow sine breathing between ~0.15 and ~0.55.
          setTtsAmplitude(0.35 + 0.2 * Math.sin(t * 2.2));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
        pulseTimerRef.current = setTimeout(() => {
          cancelAnimationFrame(rafRef.current);
          setTtsAmplitude(0);
          resolve();
        }, durationMs);
      }),
    [],
  );

  /** Tier 3: browser speechSynthesis with onend. */
  const speakBrowser = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        try {
          const synth = window.speechSynthesis;
          if (!synth) {
            resolve();
            return;
          }
          const utter = new SpeechSynthesisUtterance(text);
          const words = text.trim().split(/\s+/).length;
          const start = performance.now();
          const durationMs = Math.min(words * 400, 20_000);
          const tick = () => {
            const t = (performance.now() - start) / 1000;
            setTtsAmplitude(0.35 + 0.2 * Math.sin(t * 2.2));
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
          const finish = () => {
            cancelAnimationFrame(rafRef.current);
            setTtsAmplitude(0);
            resolve();
          };
          utter.onend = finish;
          utter.onerror = finish;
          synth.speak(utter);
          // Safety cap in case onend never fires (some browsers).
          pulseTimerRef.current = setTimeout(finish, durationMs + 1500);
        } catch {
          resolve();
        }
      }),
    [],
  );

  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (mutedRef.current) return; // no call fires while muted

      setSpeaking(true);
      try {
        const res = await fetch('/api/uhs/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        });

        const path = (res.headers.get('x-tts-path') as TtsPath) ?? null;
        const contentType = res.headers.get('Content-Type') ?? '';
        writeStats({ ttsPath: path });

        // Re-check mute: user may have muted during the round-trip.
        if (mutedRef.current) return;

        if (res.ok && contentType.includes('audio/mpeg')) {
          const buf = await res.arrayBuffer();
          await playAudioBuffer(buf);
        } else if (path === 'say') {
          await holdPulse(trimmed.split(/\s+/).length);
        } else if (path === 'browser') {
          await speakBrowser(trimmed);
        }
      } catch {
        // Network/decoding failure — fall back to browser speech client-side.
        writeStats({ ttsPath: 'browser' });
        if (!mutedRef.current) await speakBrowser(trimmed);
      } finally {
        setSpeaking(false);
      }
    },
    [playAudioBuffer, holdPulse, speakBrowser],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => stopAllRef.current();
  }, []);

  return { muted, toggleMute, speak, ttsAmplitude, speaking };
}
// === END JARVIS MOD #21 ===
