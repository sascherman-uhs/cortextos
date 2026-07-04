// === JARVIS MOD #20 — Cosmos voice loop: STT + amplitude hook (2026-07-03) ===
// New file (isolated). Adapts the FIXED voice-mode.tsx logic — specifically the
// MOD #15 stale-closure fix (final transcript read from a ref inside onend) —
// into a reusable hook for the Cosmos orb. Adds: (a) a 0..1 normalized live
// amplitude from an AnalyserNode (drives orb breathing), and (b) a four-state
// machine idle → listening → processing → responding → idle. Sending goes
// through the SAME /api/messages/send path as the chat bar so the test
// synth-send hook and the mic share one code path.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// --- Web Speech API shims (not in TS lib.dom as stable types) ---------------
interface SpeechRecognitionResult {
  readonly 0: { transcript: string };
  readonly length: number;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

const AGENT = 'jarvis-telegram';

export interface ConversationEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
}

export interface UseVoiceResult {
  state: VoiceState;
  supported: boolean;
  /** Live 0..1 mic amplitude (0 when not listening). */
  amplitude: number;
  /** Interim (in-progress) transcript while listening. */
  interim: string;
  /** Ordered conversation log: sent user turns + streamed agent replies. */
  log: ConversationEntry[];
  startListening: () => void;
  stopListening: () => void;
  /** Send an exact text turn through the same path as voice (used by test hooks). */
  sendText: (text: string) => void;
  /** Called by the SSE consumer when an agent reply line arrives. */
  pushAgentReply: (text: string, id: string) => void;
}

export function useVoice(): UseVoiceResult {
  const [state, setState] = useState<VoiceState>('idle');
  const [supported, setSupported] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [interim, setInterim] = useState('');
  const [log, setLog] = useState<ConversationEntry[]>([]);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // MOD #15 fix: onend binds once and captures a stale (empty) transcript.
  // Mirror the latest interim into a ref so onend reads the live value.
  const interimRef = useRef('');
  useEffect(() => {
    interimRef.current = interim;
  }, [interim]);

  const animFrameRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setSupported(
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window,
    );
  }, []);

  const stopAmplitude = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setAmplitude(0);
  }, []);

  const startAmplitude = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteFrequencyData(data);
        // RMS-ish average over bins, normalized to 0..1.
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        setAmplitude(Math.min(1, avg));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Mic permission denied — STT may still work (browser-dependent);
      // amplitude just stays flat.
    }
  }, []);

  const pushAgentReply = useCallback((text: string, id: string) => {
    if (!text.trim()) return;
    setLog((prev) => [...prev, { id, role: 'agent', text, ts: Date.now() }]);
    setState('idle');
  }, []);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setLog((prev) => [...prev, { id, role: 'user', text: trimmed, ts: Date.now() }]);
    setInterim('');
    setState('processing');
    fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, text: `[Cosmos] ${trimmed}` }),
    })
      .then((r) => {
        if (r.ok) {
          // Move to responding; the SSE consumer flips back to idle on reply.
          setState('responding');
        } else {
          setState('idle');
        }
      })
      .catch(() => setState('idle'));
  }, []);

  const startListening = useCallback(() => {
    const w = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const text = Array.from({ length: e.results.length }, (_, i) => e.results[i])
        .map((r) => r[0].transcript)
        .join('');
      setInterim(text);
    };

    recognition.onend = () => {
      stopAmplitude();
      const final = interimRef.current;
      if (final.trim()) {
        sendText(final);
      } else {
        setState('idle');
      }
    };

    recognition.onerror = () => {
      stopAmplitude();
      setInterim('');
      setState('idle');
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState('listening');
    startAmplitude();
  }, [startAmplitude, stopAmplitude, sendText]);

  const stopListening = useCallback(() => {
    // Triggers onend, which sends the accumulated transcript if any.
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAmplitude();
  }, [stopAmplitude]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      stopAmplitude();
    };
  }, [stopAmplitude]);

  return {
    state,
    supported,
    amplitude,
    interim,
    log,
    startListening,
    stopListening,
    sendText,
    pushAgentReply,
  };
}
// === END JARVIS MOD #20 ===
