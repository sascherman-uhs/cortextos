'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { IconMicrophone, IconMicrophoneOff } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Web Speech API — not yet in TS's lib.dom.d.ts as stable types
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

type ListenState = 'idle' | 'listening' | 'processing';

const AGENT = 'jarvis-telegram';
const CANVAS_W = 80;
const CANVAS_H = 28;

export function VoiceMode() {
  const [state, setState] = useState<ListenState>('idle');
  const [transcript, setTranscript] = useState('');
  const [supported, setSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // === JARVIS MOD #15: fix stale-closure transcript drop ===
  // recognition.onend is bound once at start time and captured `transcript`
  // from a stale closure (empty at click time), silently dropping the final
  // transcript. Mirror the latest transcript into a ref so onend reads live.
  const transcriptRef = useRef('');
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  // === END JARVIS MOD #15 ===
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setSupported(
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window,
    );
  }, []);

  const stopWaveform = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    }
  }, []);

  const startWaveform = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const draw = () => {
        const canvas = canvasRef.current;
        if (!canvas || !analyserRef.current) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);

        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        const barW = CANVAS_W / data.length;
        data.forEach((v, i) => {
          const h = (v / 255) * CANVAS_H;
          ctx.fillStyle = `hsl(var(--primary) / ${0.4 + (v / 255) * 0.6})`;
          ctx.fillRect(i * barW, CANVAS_H - h, barW - 1, h);
        });

        animFrameRef.current = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      // Mic permission denied — voice mode degrades gracefully (no waveform)
    }
  }, []);

  const sendToAgent = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setState('processing');
    try {
      await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: AGENT, text: `[Voice] ${text}` }),
      });
    } catch {
      // Network failure — message dropped, user can retry
    }
    setState('idle');
    setTranscript('');
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
      const interim = Array.from({ length: e.results.length }, (_, i) => e.results[i])
        .map((r) => r[0].transcript)
        .join('');
      setTranscript(interim);
    };

    recognition.onend = () => {
      stopWaveform();
      // === JARVIS MOD #15: fix stale-closure transcript drop ===
      const final = transcriptRef.current;
      // === END JARVIS MOD #15 ===
      if (final.trim()) {
        sendToAgent(final);
      } else {
        setState('idle');
      }
    };

    recognition.onerror = () => {
      stopWaveform();
      setState('idle');
      setTranscript('');
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState('listening');
    startWaveform();
  }, [transcript, startWaveform, stopWaveform, sendToAgent]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopWaveform();
    setState('idle');
    setTranscript('');
  }, [stopWaveform]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      stopWaveform();
    };
  }, [stopWaveform]);

  if (!supported) return null;

  return (
    <div className="flex items-center gap-1">
      {/* Waveform canvas — visible only while listening */}
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className={cn(
          'rounded transition-opacity duration-200',
          state === 'listening' ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        style={{ width: CANVAS_W, height: CANVAS_H }}
      />

      {/* Transcript preview */}
      {transcript && (
        <span className="max-w-[160px] truncate text-xs text-muted-foreground">
          {transcript}
        </span>
      )}

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-8 w-8 transition-colors',
          state === 'listening' && 'text-destructive animate-pulse',
          state === 'processing' && 'opacity-50',
        )}
        onClick={state === 'listening' ? stopListening : startListening}
        disabled={state === 'processing'}
        aria-label={state === 'listening' ? 'Stop listening' : 'Start voice mode'}
      >
        {state === 'listening' ? (
          <IconMicrophoneOff size={16} />
        ) : (
          <IconMicrophone size={16} />
        )}
      </Button>
    </div>
  );
}
