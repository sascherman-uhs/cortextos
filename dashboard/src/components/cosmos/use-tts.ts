// === JARVIS MOD #28 — iOS PWA TTS 'say' bypass (2026-07-05) ===
// Server Tier 2 (say) speaks on the Mac's speakers — useless on Scott's phone.
// Detect iOS PWA standalone and reroute 'say' → browser speechSynthesis instead.
function isIosPwaStandaloneTts(): boolean {
  if (typeof window === 'undefined') return false;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}
// === END JARVIS MOD #28 (header) ===

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
//
// === JARVIS MOD #24 — per-sentence TTS queue (2026-07-05) ===
// Phase-2 "natural conversation latency". The ElevenLabs (audio/mpeg) path is now
// PIPELINED per sentence: instead of one blocking synth+play for the whole reply,
// we sentence-split the reply, fire the fetch for sentence 1 immediately, and
// begin playback the instant its bytes land while sentence 2 is already being
// synthesized ("hold-one-ahead"). Playback is chained on each segment's onended.
//
// The 'say' and 'browser' tiers KEEP their current single-shot behavior — they are
// probed with the FULL reply text (byte-for-byte the pre-mod flow) so nothing about
// server-side `say` or client speechSynthesis changes. We only pipeline once we
// KNOW we're on elevenlabs (knownPathRef), so the very first reply of a session is a
// single-shot probe that learns the path; every elevenlabs reply after pipelines.
//
// Barge-in: each reply owns a baseTurnId. A new reply OR a new user turn increments
// it, which clears the queue, stops current audio, and aborts ALL in-flight TTS
// fetches via AbortController. Any bytes that land for a stale turn are dropped.
// === END JARVIS MOD #24 (header) ===
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
// === JARVIS MOD #25 — reuse the ONE shared, gesture-unlocked AudioContext so TTS
// is audible on iOS (see audio-unlock.ts for the full rationale). ===
import { getSharedAudioContext, resumeSharedAudio } from './audio-unlock';
// === JARVIS MOD #54 — persist the number MOD #38 already measured. The
// p50/p95 ring buffer below dies with the page; the JSONL line survives it. ===
import { reportTurnLatency, type VoicePath } from '@/lib/voice/latency';
// === END JARVIS MOD #25 ===
// === JARVIS MOD #85 — barge-in bookkeeping moved into a pure, testable object.
// MOD #24 already had the right IDEA (baseTurnId + AbortController) but the
// state lived in three loose refs and the ordering leaked (see MOD #85/#86/#87
// notes in LOCAL_MODS.md). TurnGuard is the single owner: stale ids cannot
// start a fetch, cannot enqueue, and cannot dequeue. ===
import { TurnGuard } from './turn-guard';
// === END JARVIS MOD #85 ===

const MUTE_KEY = 'cosmos-tts-muted';
type TtsPath = 'elevenlabs' | 'say' | 'browser' | null;

// === JARVIS MOD #24 — sentence-split tuning ===
// Merge fragments shorter than this into the next segment so we never fire a TTS
// call for a bare "Yes." or "OK." — tiny calls add per-request latency for no gain.
const MIN_SEGMENT_CHARS = 25;
// Hard cap so a pathological wall of short sentences can't spawn dozens of fetches;
// overflow collapses into the final segment.
const MAX_SEGMENTS = 12;
// === END JARVIS MOD #24 ===

export interface UseTtsResult {
  muted: boolean;
  toggleMute: () => void;
  /** Speak a reply through the three-tier strategy (no-op while muted). */
  speak: (text: string) => Promise<void>;
  // === JARVIS MOD #24: barge-in — cut off current speech + abort in-flight synth ===
  /** Interrupt everything (new user turn / mic press). Increments baseTurnId. */
  interrupt: () => void;
  // === END JARVIS MOD #24 ===
  /** Live 0..1 amplitude while TTS is audible (drives the orb). */
  ttsAmplitude: number;
  /** True while any tier is producing output. */
  speaking: boolean;
  // === JARVIS MOD #31: surfaced diagnostics — silent failures were undebuggable
  // on the phone (no console). Set on any playback-path failure, cleared when a
  // segment actually starts. Mirrored to __cosmosStats.ttsLastError. ===
  lastError: string | null;
  // === END JARVIS MOD #31 ===
  // === JARVIS MOD #45 (Phase 3): streaming reply turn ===
  /**
   * Begin a reply whose sentences arrive incrementally (server fast-path
   * streaming). push() APPENDS a sentence to the current turn's queue — unlike
   * speak(), it never interrupts what's already playing for this turn. end()
   * closes the queue. On non-elevenlabs tiers the sentences buffer and speak
   * once at end() (byte-for-byte the classic single-shot flow).
   */
  beginStreamReply: () => { push: (sentence: string) => void; end: () => void };
  // === END MOD #45 ===
  // === JARVIS MOD #107: which engine's turns this hook is currently measuring.
  // recordFirstAudible below is THE first-audible clock for anything that speaks
  // through ElevenLabs — including, as of the Daniel lane, Realtime replies. It
  // hard-coded path:'fastpath', so those turns were filed under the wrong engine
  // in the very metrics file the two engines are compared in. ===
  setLatencyPath: (path: VoicePath) => void;
}

// NOTE: the Window.__cosmosStats ambient type is declared once in scene.tsx
// (single source of truth). We only read/write its fields here.

function writeStats(patch: Partial<NonNullable<Window['__cosmosStats']>>) {
  if (typeof window === 'undefined') return;
  // CRITICAL (MOD #21/#24): MERGE — never reassign the whole object, or we clobber
  // fields written by scene.tsx (particles/voiceState) and use-voice (lastUserStopMs).
  window.__cosmosStats = { ...(window.__cosmosStats ?? {}), ...patch };
}

// === JARVIS MOD #38 (B5): voice-latency ring buffer + percentiles ===========
// Last 50 user-stopped-talking → first-audible samples for this page session;
// p50/p95 merged into __cosmosStats for the metrics line + Playwright asserts.
const LATENCY_BUFFER_CAP = 50;
const latencySamples: number[] = [];

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function recordLatencySample(ms: number): void {
  latencySamples.push(ms);
  if (latencySamples.length > LATENCY_BUFFER_CAP) latencySamples.shift();
  const sorted = [...latencySamples].sort((a, b) => a - b);
  writeStats({
    voiceLatency: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      n: sorted.length,
    },
  });
}
// === END JARVIS MOD #38 ======================================================

// === JARVIS MOD #24 — sentence splitter ===
/**
 * Split a reply into speakable segments on sentence boundaries, merging fragments
 * shorter than MIN_SEGMENT_CHARS forward into the next segment and capping the total
 * at MAX_SEGMENTS (overflow folded into the last segment). Text with no sentence
 * punctuation returns a single segment.
 */
function splitIntoSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Split on whitespace that FOLLOWS sentence-ending punctuation (., !, ?, …).
  const raw = trimmed
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length <= 1) return [trimmed];

  const merged: string[] = [];
  let carry = '';
  for (const seg of raw) {
    const combined = carry ? `${carry} ${seg}` : seg;
    if (combined.length < MIN_SEGMENT_CHARS) {
      // Still too short — accumulate into the next segment.
      carry = combined;
    } else {
      merged.push(combined);
      carry = '';
    }
  }
  if (carry) {
    // Trailing short fragment — glue onto the previous segment (or stand alone).
    if (merged.length) merged[merged.length - 1] += ` ${carry}`;
    else merged.push(carry);
  }

  if (merged.length > MAX_SEGMENTS) {
    const head = merged.slice(0, MAX_SEGMENTS - 1);
    const tail = merged.slice(MAX_SEGMENTS - 1).join(' ');
    return [...head, tail];
  }
  return merged;
}
// === END JARVIS MOD #24 ===

export function useTts(): UseTtsResult {
  const [muted, setMuted] = useState(false);
  const [ttsAmplitude, setTtsAmplitude] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  // === JARVIS MOD #31: visible diagnostics for the phone ===
  const [lastError, setLastError] = useState<string | null>(null);
  const reportTtsError = useCallback((msg: string) => {
    setLastError(msg);
    writeStats({ ttsLastError: msg });
  }, []);
  const clearTtsError = useCallback(() => {
    setLastError(null);
    writeStats({ ttsLastError: null });
  }, []);
  // === END JARVIS MOD #31 ===

  // Keep a ref of `muted` so speak() (stable identity) always sees the latest.
  const mutedRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // === JARVIS MOD #35 — per-loop rAF ownership + deduped amplitude (2026-07-06) ===
  // ROOT CAUSE of "Maximum update depth exceeded": the analyser tick, holdPulse,
  // and speakBrowser loops all shared ONE rafRef, so a barge-in (stopAll) cleared
  // pulseTimerRef and cancelled whichever rAF id was written LAST — the superseded
  // loop had no stop flag and ran forever, firing setTtsAmplitude with a moving
  // sine every frame. Leaked loops accumulated per interrupted reply (MOD #28/#30
  // made iOS speech + backfill interrupts frequent) until React's nested-update
  // guard tripped. Fix: every loop owns a `stopped` flag + its own rAF id and
  // registers a stop fn here; stopAmplitudeLoop drains the set. Amplitude writes
  // are quantized to 0.01 and skipped when unchanged so identical frames never
  // schedule a render.
  const loopStopsRef = useRef<Set<() => void>>(new Set());
  const lastAmpRef = useRef(0);
  const setAmp = useCallback((v: number) => {
    const q = Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
    if (q === lastAmpRef.current) return;
    lastAmpRef.current = q;
    setTtsAmplitude(q);
  }, []);
  // === END JARVIS MOD #35 ===
  // === JARVIS MOD #25 — shared-context bookkeeping ===
  // The analyser now lives on the shared context and is reused for the whole
  // session, so we track the amplitude rAF's running state and the current
  // segment's MediaElementSource to disconnect it (nodes would otherwise pile up
  // on the persistent analyser across a long conversation).
  const tickRunningRef = useRef(false);
  const currentSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // === END JARVIS MOD #25 ===
  // === JARVIS MOD #28 — current decoded-buffer source (iOS-proof playback) ===
  const bufferSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // === END JARVIS MOD #28 ===

  // === JARVIS MOD #24 — queue / turn / abort state ===
  // === JARVIS MOD #85 (2026-08-03): the three loose refs this block used to
  // hold (baseTurnIdRef / abortersRef / audioQueueRef) are now ONE TurnGuard.
  // Reason they had to merge: they were mutated from four different code paths
  // (beginTurn, stopAll, the pipeline loop, the stream loop) with no invariant
  // tying them together, which is how a barge-in could flush the queue while a
  // superseded pipeline was still holding a `pop()` for it. ===
  const guardRef = useRef<TurnGuard<ArrayBuffer> | null>(null);
  if (!guardRef.current) guardRef.current = new TurnGuard<ArrayBuffer>();
  const guard = guardRef.current;
  // === END JARVIS MOD #85 ===
  // Cached server path. Once known to be 'elevenlabs' we pipeline per sentence;
  // 'say'/'browser' stay single-shot. Reset when the path changes under us.
  const knownPathRef = useRef<TtsPath>(null);
  // First-audible metric fires at most once per reply.
  const firstAudibleRecordedRef = useRef(false);
  // === JARVIS MOD #107: the lane whose turns we are timing. Defaults to the
  // fast path (the only caller before the Daniel lane existed). ===
  const latencyPathRef = useRef<VoicePath>('fastpath');
  const setLatencyPath = useCallback((path: VoicePath) => {
    latencyPathRef.current = path;
  }, []);
  // === END JARVIS MOD #24 ===

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
    // === JARVIS MOD #25: publish the turn/queue seams EAGERLY at mount so the
    // regression suite (and any observer) sees `baseTurnId`/`ttsQueueDepth` on
    // __cosmosStats before any TTS ever fires. MERGE — never reassign. ===
    writeStats({
      ttsMuted: mutedRef.current,
      ttsPath: window.__cosmosStats?.ttsPath ?? null,
      baseTurnId: guard.current(),
      ttsQueueDepth: 0,
    });
    // === END JARVIS MOD #25 ===
  }, [guard]); // guard is a stable ref instance

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
    // === JARVIS MOD #35: stop EVERY registered loop (each cancels its own rAF
    // and resolves its own promise) — no shared id, no wrong-loop cancellation. ===
    for (const stop of loopStopsRef.current) stop();
    loopStopsRef.current.clear();
    // === END JARVIS MOD #35 ===
    // === JARVIS MOD #25 — do NOT close the shared context (it must survive for
    // the next reply and stay unlocked on iOS). Just stop the amplitude rAF and
    // disconnect the finished segment's source; keep the analyser wired to the
    // destination for reuse. ===
    tickRunningRef.current = false;
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.disconnect();
      } catch {
        /* already disconnected */
      }
      currentSourceRef.current = null;
    }
    // === END JARVIS MOD #25 ===
    setAmp(0);
  }, [setAmp]);

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
    // === JARVIS MOD #28: silence the in-flight decoded-buffer source ===
    if (bufferSourceRef.current) {
      try {
        bufferSourceRef.current.onended = null;
        bufferSourceRef.current.stop();
        bufferSourceRef.current.disconnect();
      } catch {
        /* already stopped */
      }
      bufferSourceRef.current = null;
    }
    // === END JARVIS MOD #28 ===
    // === JARVIS MOD #24: drop any queued buffers when we stop ===
    // === JARVIS MOD #85: ALSO abort in-flight synth. stopAll is reached by mute
    // mid-utterance and by unmount, neither of which went through beginTurn — so
    // before this, muting JARVIS left an ElevenLabs request running to
    // completion. Nothing played (mutedRef gates playback) but we paid for the
    // synthesis, which is exactly the kind of quiet spend the cost-cap rule says
    // to kill. Turn id deliberately does NOT advance here: nothing new is
    // starting, and advancing it would strand a turn that legitimately resumes. ===
    guard.abortInFlight();
    guard.flush();
    // === END JARVIS MOD #85 ===
    // === END JARVIS MOD #24 ===
    stopAmplitudeLoop();
    setSpeaking(false);
  }, [stopAmplitudeLoop, guard]);

  // stopAll referenced from toggleMute (declared earlier) via a ref to dodge
  // the declaration-order / stable-identity dance.
  const stopAllRef = useRef(stopAll);
  useEffect(() => {
    stopAllRef.current = stopAll;
  }, [stopAll]);

  // === JARVIS MOD #24 — shared WebAudio graph (drives the orb for EVERY segment) ===
  // One AudioContext + AnalyserNode for the whole reply. Each segment connects its
  // own MediaElementSource into the SAME analyser, so the amplitude rAF keeps
  // feeding the orb continuously across segment boundaries (req 3), with no
  // per-segment context spin-up gap. Returns the analyser, or null if WebAudio is
  // unavailable (audio still plays, orb just stays flat).
  // === JARVIS MOD #25 — start the amplitude rAF (guarded so we never double-run
  // it across segments that share the persistent context). stopAmplitudeLoop
  // clears tickRunningRef to end it at reply's end / on barge-in. ===
  const startTick = useCallback(() => {
    if (tickRunningRef.current) return;
    const analyser = analyserRef.current;
    if (!analyser) return;
    tickRunningRef.current = true;
    // === JARVIS MOD #35: own rAF id + stopped flag; registered so
    // stopAmplitudeLoop kills THIS loop deterministically. First sample is
    // deferred one frame so setState never fires synchronously from the caller's
    // stack. ===
    let raf = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      loopStopsRef.current.delete(stop);
    };
    loopStopsRef.current.add(stop);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (stopped) return;
      const a = analyserRef.current;
      if (!a) {
        stop();
        return;
      }
      a.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      setAmp(Math.min(1, sum / data.length / 255));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // === END JARVIS MOD #35 ===
  }, [setAmp]);

  const ensureAudioGraph = useCallback((): AnalyserNode | null => {
    // === JARVIS MOD #25 — reuse the shared, gesture-unlocked context. The
    // analyser is created once and stays connected to destination for the whole
    // session; each segment connects its own source into it. ===
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    audioCtxRef.current = ctx;
    resumeSharedAudio(); // iOS: nudge back to `running` if it drifted to suspended
    if (!analyserRef.current) {
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
      } catch {
        return null;
      }
    }
    startTick();
    return analyserRef.current;
    // === END JARVIS MOD #25 ===
  }, [startTick]);

  /** Record the user-stopped-talking → first-audible latency once per reply. */
  const recordFirstAudible = useCallback((turnId: number) => {
    if (!guard.isCurrent(turnId)) return;
    if (firstAudibleRecordedRef.current) return;
    firstAudibleRecordedRef.current = true;
    const stop = window.__cosmosStats?.lastUserStopMs;
    if (typeof stop === 'number') {
      const ms = Math.max(0, Math.round(performance.now() - stop));
      writeStats({ timeSinceUserStoppedTalkingMs: ms });
      // === JARVIS MOD #38 (B5): feed the session percentile buffer ===
      recordLatencySample(ms);
      // === END MOD #38 ===
      // === JARVIS MOD #54: same sample, durable — one JSONL line per turn in
      // the fast path's own metrics file so latency is answerable across
      // sessions, not just for the tab that happens to be open. ===
      reportTurnLatency({ path: latencyPathRef.current, firstAudioMs: ms });
      // === END MOD #54 ===
    }
  }, [guard]); // guard is a stable ref instance

  /**
   * Fetch one TTS segment. Returns { path, buf } — buf is the mp3 bytes on the
   * elevenlabs path, null otherwise (say already spoke server-side; browser is a
   * client-speak signal). Returns null if the fetch was aborted (barge-in).
   */
  // === JARVIS MOD #85: fetchTts now takes the turn it belongs to and REFUSES to
  // fire for a stale one. MOD #24 only checked staleness at the call sites, and
  // one of those checks came too late: runElevenLabsPipeline prefetched segment
  // i+1 immediately after awaiting segment i, BEFORE re-testing the turn. So a
  // barge-in that landed while segment i was in flight aborted everything and
  // then the dying pipeline promptly opened a BRAND NEW request for i+1 — an
  // ElevenLabs synthesis charged for audio the user had just interrupted, and
  // one that no longer belonged to any live turn. Guarding inside the fetch
  // means no call site can make that mistake again. ===
  const fetchTts = useCallback(
    async (
      segment: string,
      turnId: number,
    ): Promise<{ path: TtsPath; buf: ArrayBuffer | null } | null> => {
      const ac = new AbortController();
      if (!guard.track(turnId, ac)) return null; // stale turn — never hits the network
      try {
        const res = await fetch('/api/uhs/tts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // === JARVIS MOD #107: tell the server WHERE this request is going
            // to be heard. Tier 2 (`say`) speaks on the Mac's speakers and then
            // returns 200 — from the phone's point of view a successful,
            // completely silent reply. The server cannot detect a home-screen
            // PWA from the UA (standalone is a client-only fact), so the client
            // has to say so and the route skips the `say` tier. ===
            'x-tts-client': isIosPwaStandaloneTts() ? 'ios-pwa' : 'browser',
          },
          body: JSON.stringify({ text: segment }),
          signal: ac.signal,
        });
        // === JARVIS MOD #85: a barge-in that lands between response headers and
        // this line leaves an ALREADY-RESOLVED promise that abort cannot recall.
        // Report it as a miss rather than handing bytes to a dead pipeline. ===
        if (!guard.isCurrent(turnId)) return null;
        const path = (res.headers.get('x-tts-path') as TtsPath) ?? null;
        const contentType = res.headers.get('Content-Type') ?? '';
        if (res.ok && contentType.includes('audio/mpeg')) {
          const buf = await res.arrayBuffer();
          if (!guard.isCurrent(turnId)) return null;
          return { path: 'elevenlabs', buf };
        }
        return { path, buf: null };
      } catch (err) {
        if (ac.signal.aborted) return null; // barge-in — swallow
        throw err;
      } finally {
        guard.release(ac);
      }
    },
    [guard],
  );

  /** Play one mp3 buffer through the shared analyser; resolve on ended. */
  // === JARVIS MOD #28 (2026-07-06): decode + AudioBufferSourceNode, no <audio> ===
  // The previous implementation created a fresh `new Audio(blobUrl)` per segment
  // and called .play() — which iOS rejects outside a user gesture, PER ELEMENT,
  // no matter how unlocked the AudioContext is. Segments land seconds after the
  // mic tap, so every .play() failed silently (.catch(finish)) and the PWA was
  // mute while the same reply showed up in Telegram. Buffer sources have no such
  // gesture requirement: a `running` shared context (unlocked by the mic tap via
  // unlockSharedAudio) is sufficient. Decode the mp3 and play it through the
  // session analyser — same orb reactivity, iOS-proof.
  const playSegment = useCallback(
    async (buf: ArrayBuffer, turnId: number): Promise<void> => {
      // Drop bytes that landed for a superseded turn.
      if (!guard.isCurrent(turnId) || mutedRef.current) return;

      const analyser = ensureAudioGraph(); // also resumes the shared ctx on iOS
      const ctx = audioCtxRef.current;
      if (!ctx) {
        reportTtsError('WebAudio unavailable — no AudioContext');
        return;
      }
      if (ctx.state !== 'running') {
        // iOS: a suspended context means playback will be silent. Try one more
        // resume; if it stays suspended, say so LOUDLY in the diagnostics —
        // this is the "tap the mic once to unlock audio" case.
        await ctx.resume().catch(() => {});
        if ((ctx.state as string) !== 'running') {
          reportTtsError(`AudioContext ${ctx.state} — tap the mic once to unlock audio`);
          return;
        }
      }

      let audioBuf: AudioBuffer;
      try {
        // decodeAudioData detaches its input — hand it a copy so the caller's
        // buffer (and any retry) stays intact.
        audioBuf = await ctx.decodeAudioData(buf.slice(0));
      } catch {
        reportTtsError('audio decode failed (mp3 segment)');
        return; // undecodable segment — skip rather than stall the queue
      }
      // Re-check staleness after the async decode (barge-in may have landed).
      if (!guard.isCurrent(turnId) || mutedRef.current) return;

      await new Promise<void>((resolve) => {
        const source = ctx.createBufferSource();
        source.buffer = audioBuf;
        try {
          source.connect(analyser ?? ctx.destination);
        } catch {
          resolve();
          return;
        }
        bufferSourceRef.current = source;
        // === JARVIS MOD #86 (2026-08-03): this promise USED TO STRAND on every
        // barge-in during playback. stopAll's teardown sets `onended = null`
        // before calling source.stop() — deliberately, so the stop doesn't fire
        // a spurious "finished" — which meant the only thing that could ever
        // resolve this promise was deleted. The awaiting pipeline then hung at
        // `await playSegment(...)` forever: its `finally` never ran, so
        // setSpeaking(false) and the ttsQueueDepth reset never happened for that
        // turn, and its ArrayBuffers stayed reachable. That is the "half-spoken
        // limbo" the rubric is about — interrupt() papered over the visible
        // symptom by calling setSpeaking(false) itself.
        //
        // Fix: settle through ONE idempotent `finish` registered in
        // loopStopsRef, the same cancellation channel MOD #35 built for the rAF
        // loops. stopAmplitudeLoop drains that set, so a barge-in now resolves
        // this promise deterministically whether or not onended ever fires. ===
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          loopStopsRef.current.delete(finish);
          if (bufferSourceRef.current === source) bufferSourceRef.current = null;
          try {
            source.disconnect();
          } catch {
            /* already disconnected */
          }
          resolve();
        };
        loopStopsRef.current.add(finish);
        source.onended = finish;
        // === END JARVIS MOD #86 ===
        try {
          source.start(0);
          // First moment sound is actually audible → close the latency metric.
          recordFirstAudible(turnId);
          clearTtsError(); // === JARVIS MOD #31: a segment is genuinely playing ===
        } catch {
          reportTtsError('audio start failed');
          finish();
        }
      });
    },
    [ensureAudioGraph, recordFirstAudible, reportTtsError, clearTtsError, guard],
  );
  // === END JARVIS MOD #28 ===

  /** Synthetic gentle orb pulse for tier 2 ('say', server-side speech). */
  const holdPulse = useCallback(
    (words: number) =>
      new Promise<void>((resolve) => {
        const durationMs = Math.min(words * 400, 20_000);
        const start = performance.now();
        // === JARVIS MOD #35: own rAF id + stop registered in loopStopsRef, so a
        // barge-in (which clears pulseTimerRef) still kills this loop AND
        // resolves the promise — the old shared rafRef leaked it forever. ===
        let raf = 0;
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          cancelAnimationFrame(raf);
          loopStopsRef.current.delete(stop);
          setAmp(0);
          resolve();
        };
        loopStopsRef.current.add(stop);
        const tick = () => {
          if (stopped) return;
          const t = (performance.now() - start) / 1000;
          // Slow sine breathing between ~0.15 and ~0.55.
          setAmp(0.35 + 0.2 * Math.sin(t * 2.2));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        pulseTimerRef.current = setTimeout(stop, durationMs);
        // === END JARVIS MOD #35 ===
      }),
    [setAmp],
  );

  /** Tier 3: browser speechSynthesis with onend. */
  const speakBrowser = useCallback(
    (text: string, turnId?: number) =>
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
          // === JARVIS MOD #35: own rAF id + idempotent finish registered in
          // loopStopsRef — a barge-in kills this loop and resolves the promise
          // even if speechSynthesis.cancel() never fires onend/onerror. ===
          let raf = 0;
          let stopped = false;
          const finish = () => {
            if (stopped) return;
            stopped = true;
            cancelAnimationFrame(raf);
            loopStopsRef.current.delete(finish);
            setAmp(0);
            resolve();
          };
          loopStopsRef.current.add(finish);
          const tick = () => {
            if (stopped) return;
            const t = (performance.now() - start) / 1000;
            setAmp(0.35 + 0.2 * Math.sin(t * 2.2));
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
          // === END JARVIS MOD #35 ===
          // === JARVIS MOD #24: browser speech is client-audible → close the metric ===
          utter.onstart = () => {
            if (typeof turnId === 'number') recordFirstAudible(turnId);
          };
          // === END JARVIS MOD #24 ===
          utter.onend = finish;
          utter.onerror = finish;
          synth.speak(utter);
          // Safety cap in case onend never fires (some browsers).
          pulseTimerRef.current = setTimeout(finish, durationMs + 1500);
        } catch {
          resolve();
        }
      }),
    [recordFirstAudible, setAmp],
  );

  // === JARVIS MOD #24 — turn lifecycle + elevenlabs pipeline ===
  /**
   * Begin a new turn: abort in-flight synth, clear the queue, stop current output,
   * bump baseTurnId, and reset the per-reply metric latch. Returns the new turnId.
   */
  const beginTurn = useCallback((): number => {
    // === JARVIS MOD #85/#87: order matters. stopAll() first — it aborts the
    // in-flight fetches AND (via stopAmplitudeLoop) resolves any playSegment
    // promise parked on a source that is about to be silenced (MOD #86). Then
    // guard.begin() advances the turn id, which is what makes every late
    // arrival from the old turn a no-op, and wakes any stream loop parked
    // waiting for its next sentence so it can observe the new id and exit
    // (MOD #87) instead of suspending for the lifetime of the page. ===
    stopAll(); // stops audio + pulse + rAF, aborts fetches, clears queue, speaking=false
    firstAudibleRecordedRef.current = false;
    const next = guard.begin();
    // === JARVIS MOD #25: write BOTH the canonical `baseTurnId` (read by the
    // regression suite) and the legacy `cosmosBaseTurnId` (MOD #24 seam). A user
    // turn reaches here via doSend → interrupt() → beginTurn(), so the id visibly
    // increments on every synth/mic send. MERGE, never reassign. ===
    writeStats({ baseTurnId: next, cosmosBaseTurnId: next, ttsQueueDepth: 0 });
    // === END JARVIS MOD #25 ===
    return next;
  }, [stopAll, guard]);

  /**
   * ElevenLabs pipeline: fetch sentence 1 immediately, hold one fetch ahead of
   * playback, and chain playback in order. Bails on stale turn / mute. If the path
   * changes under us (EL key removed mid-session), falls back to say/browser for the
   * remaining text without double-speaking already-spoken segments.
   */
  const runElevenLabsPipeline = useCallback(
    async (segments: string[], turnId: number) => {
      const fetches: Array<Promise<{ path: TtsPath; buf: ArrayBuffer | null } | null> | undefined> = [];
      const startFetch = (i: number) => {
        // === JARVIS MOD #85: staleness is enforced inside fetchTts (via
        // guard.track), so a prefetch issued from a superseded pipeline
        // resolves to null without touching the network. The explicit check
        // here just avoids allocating the controller at all. ===
        if (!guard.isCurrent(turnId) || mutedRef.current) return;
        if (i >= 0 && i < segments.length && !fetches[i]) {
          fetches[i] = fetchTts(segments[i], turnId);
        }
      };
      startFetch(0);
      startFetch(1); // hold-one-ahead: sentence 2 synthesizes while sentence 1 plays

      for (let i = 0; i < segments.length; i++) {
        if (!guard.isCurrent(turnId) || mutedRef.current) return;
        writeStats({ ttsQueueDepth: segments.length - i });
        const res = await fetches[i];
        // === JARVIS MOD #85: re-test the turn BEFORE prefetching. The old order
        // (prefetch, then test) opened a fresh request for the next sentence on
        // the way out of an already-interrupted turn. ===
        if (!res || !guard.isCurrent(turnId) || mutedRef.current) return;
        startFetch(i + 1); // prefetch next, now that we know we're still live

        if (res.path !== 'elevenlabs' || !res.buf) {
          // Path flipped away from elevenlabs (rare: key removed). Reset and finish
          // the remaining text on the new tier without re-speaking segment i.
          knownPathRef.current = res.path;
          writeStats({ ttsPath: res.path });
          if (res.path === 'say') {
            // Server already spoke segment i on the Mac; speak the rest, then pulse.
            const rest = segments.slice(i + 1).join(' ');
            if (rest && guard.isCurrent(turnId)) await fetchTts(rest, turnId);
            // === JARVIS MOD #28: on iOS PWA, use browser speech instead of silent pulse ===
            if (guard.isCurrent(turnId)) {
              if (isIosPwaStandaloneTts()) {
                await speakBrowser(segments.slice(i).join(' '), turnId);
              } else {
                await holdPulse(1);
              }
            }
            // === END JARVIS MOD #28 ===
          } else if (res.path === 'browser') {
            // Browser tier spoke nothing server-side; speak from segment i on.
            const rest = segments.slice(i).join(' ');
            if (guard.isCurrent(turnId)) await speakBrowser(rest, turnId);
          }
          return;
        }

        guard.enqueue(turnId, res.buf);
        await playSegment(res.buf, turnId);
        guard.dequeue(turnId);
      }
    },
    [fetchTts, playSegment, holdPulse, speakBrowser, guard],
  );
  // === END JARVIS MOD #24 ===

  const speak = useCallback(
    async (text: string) => {
      let trimmed = text.trim();
      if (!trimmed) return;
      if (mutedRef.current) return; // no call fires while muted

      // === JARVIS MOD #44: 50-word client-side safety cap — voice replies must be speakable ===
      const _words = trimmed.split(/\s+/);
      if (_words.length > 50) trimmed = _words.slice(0, 50).join(' ') + '…';
      // === END JARVIS MOD #44 ===

      // === JARVIS MOD #24: a new reply is a new turn — interrupts anything playing ===
      const turnId = beginTurn();
      // === END JARVIS MOD #24 ===
      setSpeaking(true);
      try {
        // === JARVIS MOD #24: pipeline when we KNOW we're on elevenlabs ===
        if (knownPathRef.current === 'elevenlabs') {
          const segments = splitIntoSentences(trimmed);
          await runElevenLabsPipeline(segments, turnId);
          return;
        }
        // === END JARVIS MOD #24 ===

        // Path unknown / say / browser → single-shot probe on the WHOLE reply.
        // This is byte-for-byte the pre-mod flow, so say/browser never fragment.
        const probe = await fetchTts(trimmed, turnId);
        if (!probe || !guard.isCurrent(turnId)) return;
        knownPathRef.current = probe.path;
        writeStats({ ttsPath: probe.path });

        // Re-check mute: user may have muted during the round-trip.
        if (mutedRef.current) return;

        if (probe.path === 'elevenlabs' && probe.buf) {
          // First elevenlabs reply plays as a single segment; subsequent replies
          // will pipeline per sentence via knownPathRef.
          guard.enqueue(turnId, probe.buf);
          writeStats({ ttsQueueDepth: 1 });
          await playSegment(probe.buf, turnId);
          guard.dequeue(turnId);
        } else if (probe.path === 'say') {
          // === JARVIS MOD #28: on iOS PWA, Mac speakers don't reach Scott's phone.
          // Fall through to browser speechSynthesis so the device actually speaks. ===
          if (isIosPwaStandaloneTts()) {
            await speakBrowser(trimmed, turnId);
          } else {
            await holdPulse(trimmed.split(/\s+/).length);
          }
          // === END JARVIS MOD #28 ===
        } else if (probe.path === 'browser') {
          await speakBrowser(trimmed, turnId);
        }
      } catch {
        // Network/decoding failure — fall back to browser speech client-side.
        writeStats({ ttsPath: 'browser' });
        if (!mutedRef.current && guard.isCurrent(turnId)) {
          await speakBrowser(trimmed, turnId);
        }
      } finally {
        // Only tear down if we're still the active turn (a barge-in already reset us).
        if (guard.isCurrent(turnId)) {
          stopAmplitudeLoop();
          setSpeaking(false);
          writeStats({ ttsQueueDepth: 0 });
        }
      }
    },
    [beginTurn, runElevenLabsPipeline, fetchTts, playSegment, holdPulse, speakBrowser, stopAmplitudeLoop, guard],
  );

  // === JARVIS MOD #24: exposed barge-in — mic press / new user turn cuts JARVIS off ===
  const interrupt = useCallback(() => {
    beginTurn();
    setSpeaking(false);
  }, [beginTurn]);
  // === END JARVIS MOD #24 ===

  // === JARVIS MOD #45 (Phase 3): streaming reply turn ========================
  // Sentences from the server fast-path stream are APPENDED to one turn's
  // queue instead of each spawning a new speak() (which begins a new turn and
  // would cut the previous sentence off mid-word). Only the known-elevenlabs
  // path streams; on 'say'/'browser'/unknown the sentences buffer and go
  // through the untouched speak() flow at end(), so those tiers never fragment.
  const beginStreamReply = useCallback((): { push: (sentence: string) => void; end: () => void } => {
    if (knownPathRef.current !== 'elevenlabs') {
      const parts: string[] = [];
      return {
        push: (s: string) => { parts.push(s); },
        end: () => {
          const whole = parts.join(' ').trim();
          if (whole) void speak(whole);
        },
      };
    }

    const st = { queue: [] as string[], closed: false, notify: null as null | (() => void) };
    const wake = () => { const n = st.notify; st.notify = null; n?.(); };
    const turnId = beginTurn();
    setSpeaking(true);

    // === JARVIS MOD #87 (2026-08-03): cancellation for the parked stream loop.
    // This loop suspends on `st.notify` whenever it has consumed every sentence
    // pushed so far — normal, since the server is still generating. The ONLY
    // things that resolved it were push() and end(), both driven by the reply
    // stream in use-voice. So when a barge-in killed that stream mid-reply (the
    // reader is aborted, end() never runs), this loop stayed suspended for the
    // life of the page, holding its fetches, its buffers, and a setSpeaking
    // continuation. One leaked loop per interrupted streaming reply.
    //
    // Parking with the guard makes the next beginTurn() wake it: it observes a
    // closed stream and a stale turn id, and exits through its own `finally`.
    // The unpark on the way out keeps normal completions from leaking waiters. ===
    const unpark = guard.park(turnId, () => {
      st.closed = true;
      wake();
    });
    // === END JARVIS MOD #87 ===

    void (async () => {
      try {
        const fetches = new Map<number, ReturnType<typeof fetchTts>>();
        const startFetch = (i: number) => {
          if (i < st.queue.length && !fetches.has(i)) fetches.set(i, fetchTts(st.queue[i], turnId));
        };
        let i = 0;
        for (;;) {
          while (i >= st.queue.length && !st.closed) {
            await new Promise<void>((res) => { st.notify = res; });
          }
          if (i >= st.queue.length && st.closed) return;
          if (!guard.isCurrent(turnId) || mutedRef.current) return;
          if (i >= MAX_SEGMENTS) {
            // Pathological sentence count — wait for close, fold the overflow
            // into one final segment (mirrors splitIntoSentences's cap).
            while (!st.closed) await new Promise<void>((res) => { st.notify = res; });
            const rest = st.queue.slice(i).join(' ');
            if (rest && guard.isCurrent(turnId) && !mutedRef.current) {
              const res = await fetchTts(rest, turnId);
              if (res?.path === 'elevenlabs' && res.buf && guard.isCurrent(turnId)) {
                guard.enqueue(turnId, res.buf);
                await playSegment(res.buf, turnId);
                guard.dequeue(turnId);
              }
            }
            return;
          }
          startFetch(i);
          startFetch(i + 1); // hold-one-ahead, same as runElevenLabsPipeline
          writeStats({ ttsQueueDepth: st.queue.length - i });
          const res = await fetches.get(i)!;
          startFetch(i + 1);
          if (!res || !guard.isCurrent(turnId) || mutedRef.current) return;

          if (res.path !== 'elevenlabs' || !res.buf) {
            // Path flipped away mid-stream (rare: EL key removed). Wait for the
            // stream to close, then finish the remaining text on the new tier
            // without re-speaking already-spoken segments — mirrors
            // runElevenLabsPipeline's flip handling.
            knownPathRef.current = res.path;
            writeStats({ ttsPath: res.path });
            while (!st.closed) await new Promise<void>((r) => { st.notify = r; });
            if (!guard.isCurrent(turnId) || mutedRef.current) return;
            if (res.path === 'say') {
              // Server already spoke segment i on the Mac; speak the rest, then pulse.
              const rest = st.queue.slice(i + 1).join(' ');
              if (rest && guard.isCurrent(turnId)) await fetchTts(rest, turnId);
              if (guard.isCurrent(turnId)) {
                if (isIosPwaStandaloneTts()) {
                  await speakBrowser(st.queue.slice(i).join(' '), turnId);
                } else {
                  await holdPulse(1);
                }
              }
            } else if (res.path === 'browser') {
              const rest = st.queue.slice(i).join(' ');
              if (rest && guard.isCurrent(turnId)) await speakBrowser(rest, turnId);
            }
            return;
          }

          guard.enqueue(turnId, res.buf);
          await playSegment(res.buf, turnId);
          guard.dequeue(turnId);
          i += 1;
        }
      } finally {
        unpark(); // === MOD #87: never leave a waiter behind ===
        if (guard.isCurrent(turnId)) {
          stopAmplitudeLoop();
          setSpeaking(false);
          writeStats({ ttsQueueDepth: 0 });
        }
      }
    })();

    return {
      // === JARVIS MOD #87: both handles are inert once the turn is superseded.
      // The reply stream in use-voice can keep delivering sentences for a beat
      // after a barge-in (an aborted reader still drains what was already
      // buffered), and appending them here would grow a queue nobody consumes. ===
      push: (s: string) => {
        if (!guard.isCurrent(turnId)) return;
        const t = s.trim();
        if (t && !st.closed) { st.queue.push(t); wake(); }
      },
      end: () => { st.closed = true; wake(); },
    };
  }, [beginTurn, fetchTts, playSegment, holdPulse, speakBrowser, stopAmplitudeLoop, speak, guard]);
  // === END MOD #45 ===========================================================

  // Cleanup on unmount.
  useEffect(() => {
    return () => stopAllRef.current();
  }, []);

  return { muted, toggleMute, speak, interrupt, ttsAmplitude, speaking, lastError, beginStreamReply, setLatencyPath };
}
// === END JARVIS MOD #21 ===
