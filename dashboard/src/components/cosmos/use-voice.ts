// === JARVIS MOD #20 — Cosmos voice loop: STT + amplitude hook (2026-07-03) ===
// New file (isolated). Adapts the FIXED voice-mode.tsx logic — specifically the
// MOD #15 stale-closure fix (final transcript read from a ref inside onend) —
// into a reusable hook for the Cosmos orb. Adds: (a) a 0..1 normalized live
// amplitude from an AnalyserNode (drives orb breathing), and (b) a state
// machine. Sending goes through the SAME /api/messages/send path as the chat
// bar so the test synth-send hook and the mic share one code path.
//
// === JARVIS MOD #36 — always-listening open mic + wake word + VAD (2026-07-07) ===
// Trillion-parity interaction model (approved plan §Spec-2, techniques from the
// recovered smooth-voice prompt — see voice-turn.ts for the pure logic):
//
//  - OPEN MIC: one persistent getUserMedia stream + AnalyserNode does double
//    duty: orb amplitude AND voice-activity detection (energy threshold +
//    hangover). Desktop rides a continuous webkitSpeechRecognition session
//    (auto-restarted); iOS PWA standalone rides an always-running MediaRecorder
//    that is stopped/restarted at VAD utterance boundaries → /api/uhs/stt.
//  - WAKE GATE: spoken utterances must start with "jarvis"/"hey jarvis" to
//    become a turn — EXCEPT during the follow-up window (~8s) after JARVIS
//    finishes speaking, when a bare reply is accepted (Alexa-style follow-up).
//    Typed/synth sends (sendText) are NEVER gated — the gate lives in
//    handleUtterance, the mic-only path.
//  - BARGE-IN BY VOICE: while TTS is speaking, hearing the wake word in the
//    INTERIM transcript interrupts playback immediately (wake-word-gated on
//    purpose: pure energy-based barge-in false-triggers on the assistant's own
//    speaker echo).
//  - GOODBYE: a conservative sign-off detector (isSignoff, veto rules per
//    smooth-voice Tier 5) ends the conversation with a short LOCAL spoken
//    sign-off — no agent call, no last word grabbed.
//  - STATES: dormant (open mic off/unavailable) | wakeListening (hot mic,
//    waiting for wake word) | listening (capturing an utterance / follow-up
//    window) | processing | responding — plus 'speaking' which voice-panel
//    derives from useTts while audio is playing.
//
// Tap-to-talk is RETAINED as a fallback: with open mic OFF the pre-mod-36 flow
// is byte-for-byte intact; with open mic ON the mic button opens a follow-up
// window (same as saying "Jarvis"). Open-mic preference persists in
// localStorage 'cosmos-open-mic' (default ON where supported).
// === END MOD #36 header ===
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
// MOD #39: the open-mic engine MUST ride the shared gesture-unlocked context.
// A privately-constructed AudioContext is born `suspended` on iOS (no gesture
// at mount), the analyser then reads all-zeros forever, VAD never fires, and
// zero utterances reach STT — exactly Scott's 2026-07-08 silent phone test.
// Same lesson as MOD #25/#28; PwaBoot's first-gesture unlock now heals the mic.
import { getSharedAudioContext, resumeSharedAudio } from './audio-unlock';
import {
  SPEECH_THRESHOLD,
  FOLLOW_UP_MS,
  SIGNOFF_LINES,
  chooseHangoverMs,
  containsWakeWord,
  isSignoff,
  wakeMatch,
} from './voice-turn';

// --- Web Speech API shims (not in TS lib.dom as stable types) ---------------
interface SpeechRecognitionResult {
  readonly 0: { transcript: string };
  readonly length: number;
  // === JARVIS MOD #36: continuous mode needs the recognizer's own endpoint signal ===
  readonly isFinal: boolean;
  // === END MOD #36 ===
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
  // === JARVIS MOD #36: typed error event so 'not-allowed' can disable open mic ===
  onerror: ((e?: { error?: string }) => void) | null;
  // === END MOD #36 ===
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

// === JARVIS MOD #36: extended state machine ===
export type VoiceState =
  | 'dormant'
  | 'wakeListening'
  | 'idle'
  | 'listening'
  | 'processing'
  | 'responding'
  | 'speaking';
// === END MOD #36 ===

const AGENT = 'jarvis-telegram';
// MOD #39c: key bumped (was 'cosmos-open-mic') to re-default open mic ON once —
// an accidental toggle-tap during 2026-07-08 debugging persisted OFF and read
// as "voice is broken". A deliberate off still sticks under the new key.
// (v3, 2026-07-08 evening: the v2 re-default worked, then an instructed toggle
// tap flipped it off again and persisted. One more re-default; the pill is now
// labeled unambiguously so an ON→OFF tap is a visibly deliberate act.)
const OPEN_MIC_KEY = 'cosmos-open-mic-v3';
/** Tap mode: ms of post-speech silence before the turn auto-sends. */
const TAP_AUTOSTOP_SILENCE_MS = 1100;
/** MOD #39h: ms of post-transcript quiet before an accepted turn ships to the
 *  agent. VAD chunks arriving inside this window MERGE into one turn, so a
 *  natural mid-sentence pause no longer splits (or truncates) the thought.
 *  Effective pause tolerance ≈ VAD hangover (950ms) + STT (~700ms) + this. */
const MERGE_WINDOW_MS = 1200;

// MOD #39e: whisper emits literal non-speech tokens for silent/ambient audio —
// "[BLANK_AUDIO]", "[MUSIC]", "(silence)", "♪♪" — which are NOT the user
// speaking. One reached the agent as a real turn on 2026-07-08 (screenshot:
// "[BLANK_AUDIO]" bubble, agent politely replied). Treat as empty.
function meaningfulTranscript(t: string | undefined): string {
  const trimmed = (t ?? '').trim();
  if (!trimmed) return '';
  if (/^[\[\(].*[\]\)]$/.test(trimmed)) return ''; // whole-string bracketed token
  if (/^[♪♫\s]+$/.test(trimmed)) return '';
  return trimmed;
}
// iOS: bound the always-running recorder's blob during long silence.
const IOS_IDLE_RESTART_MS = 20_000;
// Auto-restart delay after a recognition session ends/errors.
const RECOG_RESTART_MS = 300;

export interface ConversationEntry {
  id: string;
  // 'heard' = speech the wake gate discarded (shown dim so a silent JARVIS is
  // debuggable on-phone: "didn't hear you" vs "heard you, no wake word").
  role: 'user' | 'agent' | 'heard';
  text: string;
  ts: number;
}

// === JARVIS MOD #36: the TTS bridge — voice-panel wires useTts in so the
// engine can barge-in on wake word and speak LOCAL canned lines (wake ack,
// sign-off) without an agent round-trip. Refs, so no re-render coupling. ===
export interface TtsBridge {
  interrupt: () => void;
  isSpeaking: () => boolean;
  speakLocal: (text: string) => void;
}
// === END MOD #36 ===

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
  // === JARVIS MOD #33: turns sent this session, incremented inside sendText so
  // EVERY path (mic, Whisper, typed, synth) counts. The SSE/backfill reply gate
  // must read THIS, never a panel-local counter. ===
  sentTurnsRef: React.MutableRefObject<number>;
  // === END JARVIS MOD #33 ===
  // === JARVIS MOD #36: open-mic surface ===
  openMic: boolean;
  toggleOpenMic: () => void;
  bindTts: (bridge: TtsBridge) => void;
  /** voice-panel mirrors useTts.speaking here; falling edge opens follow-up window. */
  notifyTtsSpeaking: (speaking: boolean) => void;
  // === END MOD #36 ===
  // === JARVIS MOD #38: outbound ids already delivered synchronously by the
  // fast lane — the SSE/backfill consumers must mark-seen-and-skip these so
  // the same reply is never spoken twice. ===
  fastReplyIdsRef: React.MutableRefObject<Set<string>>;
  // === END MOD #38 ===
}

// === JARVIS MOD #27 addendum — iOS PWA standalone detection ===
// On iOS, webkitSpeechRecognition is present in window but silently fails in
// standalone (home-screen) PWA mode. Detect standalone to skip it entirely and
// go straight to the MediaRecorder → /api/uhs/stt Whisper path.
function isIosPwaStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// === JARVIS MOD #36: merge-only stats writer (MOD #21 rule: NEVER reassign) ===
function mergeStats(patch: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  window.__cosmosStats = { ...(window.__cosmosStats ?? {}), ...patch } as Window['__cosmosStats'];
}
// === END MOD #36 ===

// === JARVIS MOD #38: escalation acknowledgments — spoken LOCALLY the instant
// the send response says the turn went to the full agent (10-60s think time),
// so the wait never feels like dead air. Rotation avoids the same line twice
// in a row. speakLocal no-ops while muted (enforced inside useTts). ===
const ESCALATION_ACKS = [
  'On it — give me a minute.',
  'Working. This one needs the full engine.',
  'One moment, sir — pulling the real numbers.',
];
let ackCursor = 0;
function nextAck(): string {
  const line = ESCALATION_ACKS[ackCursor % ESCALATION_ACKS.length];
  ackCursor += 1;
  return line;
}
// === END MOD #38 ===

export function useVoice(): UseVoiceResult {
  const [state, setState] = useState<VoiceState>('idle');
  const [supported, setSupported] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [interim, setInterim] = useState('');
  const [log, setLog] = useState<ConversationEntry[]>([]);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // === JARVIS MOD #33: authoritative sent-turn counter (see interface note) ===
  const sentTurnsRef = useRef(0);
  // === END JARVIS MOD #33 ===
  // MOD #15 fix: onend binds once and captures a stale (empty) transcript.
  // Mirror the latest interim into a ref so onend reads the live value.
  const interimRef = useRef('');
  // === JARVIS MOD #27: MediaRecorder refs for iOS PWA fallback ===
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // === END MOD #27 ===
  useEffect(() => {
    interimRef.current = interim;
  }, [interim]);

  const animFrameRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // === JARVIS MOD #36: open-mic engine state =================================
  const [openMic, setOpenMic] = useState(false); // hydrated from localStorage below
  const openMicRef = useRef(false);
  const engineRunningRef = useRef(false);
  const engineStreamRef = useRef<MediaStream | null>(null);
  const engineCtxRef = useRef<AudioContext | null>(null);
  const engineSourceRef = useRef<MediaStreamAudioSourceNode | null>(null); // MOD #39
  const ampSourceRef = useRef<MediaStreamAudioSourceNode | null>(null); // MOD #39b
  // MOD #39c: tap-mode VAD auto-send state + late-bound stopListening.
  const tapSpeechSeenRef = useRef(false);
  const tapLastVoiceMsRef = useRef(0);
  const stopListeningRef = useRef<() => void>(() => {});
  const engineAnalyserRef = useRef<AnalyserNode | null>(null);
  const engineFrameRef = useRef<number>(0);
  const engineRecogRef = useRef<SpeechRecognitionInstance | null>(null);
  const engineRecogRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineRecorderRef = useRef<MediaRecorder | null>(null);
  const engineChunksRef = useRef<Blob[]>([]);
  const engineDiscardStopRef = useRef(false);
  const engineRecorderStartedMsRef = useRef(0);
  // Per-utterance tracking
  const utterStartIdxRef = useRef(0);
  const utterTextRef = useRef('');
  const utterHasFinalTailRef = useRef(false);
  const utterSpeechSeenRef = useRef(false);
  const utterInterruptedRef = useRef(false);
  const lastVoiceActivityMsRef = useRef(0);
  const sttBusyRef = useRef(false);
  // MOD #39g: engine STT is SERIALIZED through this chain, never dropped — a
  // chunk that landed while the previous Whisper call was in flight used to be
  // discarded wholesale (heard live 2026-07-12 as "missing transcript").
  const sttChainRef = useRef<Promise<void>>(Promise.resolve());
  // Turn-taking
  const followUpUntilMsRef = useRef(0);
  const hadAgentTurnRef = useRef(false);
  const ttsBridgeRef = useRef<TtsBridge | null>(null);
  // === JARVIS MOD #38: reply ids delivered synchronously by the fast lane ===
  const fastReplyIdsRef = useRef<Set<string>>(new Set());
  const escalationsRef = useRef(0);
  // === END MOD #38 ===
  const signoffIdxRef = useRef(0);
  const wakeStatsRef = useRef({ accepted: 0, discarded: 0 });
  // ===========================================================================

  useEffect(() => {
    // iOS PWA standalone: SpeechRecognition is in window but silently fails.
    // Use MediaRecorder → Whisper instead — supported as long as getUserMedia exists.
    if (isIosPwaStandalone()) {
      setSupported(typeof navigator.mediaDevices?.getUserMedia === 'function');
    } else {
      setSupported('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
    }
  }, []);

  // === JARVIS MOD #36: rest state depends on the open-mic mode ===
  const restState = useCallback((): VoiceState => {
    if (!openMicRef.current) return 'idle';
    return performance.now() < followUpUntilMsRef.current ? 'listening' : 'wakeListening';
  }, []);
  // === END MOD #36 ===

  const stopAmplitude = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    // MOD #39b: the context is the SHARED session singleton — disconnect our
    // source node, never close the context (TTS + open-mic engine ride it too).
    ampSourceRef.current?.disconnect();
    ampSourceRef.current = null;
    audioCtxRef.current = null;
    setAmplitude(0);
  }, []);

  // MOD #39b: `existing` lets the tap-recorder path REUSE its stream. Two
  // concurrent getUserMedia captures made iOS silently mute one — the recorder
  // then shipped silence and whisper returned an empty transcript (Scott's
  // 2026-07-08 tap test: STT 200 in 1331ms, no text, no send, no reply).
  const startAmplitude = useCallback(async (existing?: MediaStream) => {
    try {
      const stream =
        existing ?? (await navigator.mediaDevices.getUserMedia({ audio: true }));
      streamRef.current = stream;
      // MOD #39b: shared gesture-unlocked context, never a private one (a
      // private ctx is born suspended on iOS → analyser reads zeros → orb dead).
      const audioCtx = getSharedAudioContext();
      if (!audioCtx) return;
      resumeSharedAudio();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      ampSourceRef.current = source;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      // MOD #39c: tap-mode auto-send. The tap path used to record until a SECOND
      // tap — Scott tapped once, spoke, and waited on "Listening…" forever
      // (2026-07-08). Now the same VAD that runs the open-mic engine ends the
      // tap turn: speak, pause ~1.1s, it sends. Tap again still works (barge-out).
      tapSpeechSeenRef.current = false;
      tapLastVoiceMsRef.current = performance.now();
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
        // MOD #39c: VAD end-of-turn for tap mode (engine off, actively listening).
        if (!engineRunningRef.current && stateRef.current === 'listening') {
          const now = performance.now();
          if (avg > SPEECH_THRESHOLD) {
            tapSpeechSeenRef.current = true;
            tapLastVoiceMsRef.current = now;
          } else if (
            tapSpeechSeenRef.current &&
            now - tapLastVoiceMsRef.current > TAP_AUTOSTOP_SILENCE_MS
          ) {
            tapSpeechSeenRef.current = false;
            setState('processing');
            stopListeningRef.current(); // recorder.onstop / recognition.onend → send
            return; // stopAmplitude cancels this loop
          }
        }
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
    setLog((prev) => {
      if (prev.some((e) => e.id === id)) return prev;
      return [...prev, { id, role: 'agent', text, ts: Date.now() }];
    });
    // === JARVIS MOD #36: a reply arrived — the conversation is two-sided now
    // (arms the sign-off detector) and the machine returns to its rest state. ===
    hadAgentTurnRef.current = true;
    setState(restState());
    // === END MOD #36 ===
  }, [restState]);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // === JARVIS MOD #33 (2026-07-06): the sent-turn counter lives HERE, the one
    // choke point every send path crosses. It previously lived in voice-panel's
    // doSend(), which only the typed/synth path used — MIC sends (Web Speech
    // onend and the iOS MediaRecorder→Whisper path) call sendText directly, so
    // voice-only sessions (Scott's phone, always) kept the counter at 0 and the
    // SSE/backfill gate discarded EVERY reply as "pre-existing history": never
    // spoken, never shown. Typed messages worked — which is why every automated
    // test passed while real phone usage stayed silent. ===
    sentTurnsRef.current += 1;
    // === END JARVIS MOD #33 ===
    // === JARVIS MOD #24: stamp when the user's turn ended (mic onend → sendText, or
    // synth/typed submit) so use-tts can measure user-stopped-talking → first-audible.
    // MERGE into __cosmosStats — never reassign (would clobber ttsPath/particles). ===
    mergeStats({ lastUserStopMs: performance.now() });
    // === END JARVIS MOD #24 ===
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setLog((prev) => [...prev, { id, role: 'user', text: trimmed, ts: Date.now() }]);
    setInterim('');
    setState('processing');
    fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, text: `[Cosmos] ${trimmed}` }),
    })
      // === JARVIS MOD #38: consume the synchronous fast-lane reply. The POST
      // response now carries replyText/replyId on a fast-path hit — speak it
      // immediately (pushAgentReply → voice-panel's log effect speaks it)
      // instead of waiting up to ~1s for the SSE tail to notice the file.
      // On escalation, speak a local ack so the full-agent wait isn't silent.
      .then(async (r) => {
        if (!r.ok) {
          setState(restState());
          return;
        }
        let payload: {
          fastpath?: boolean;
          replyText?: string;
          replyId?: string;
          escalated?: boolean;
        } = {};
        try {
          payload = await r.json();
        } catch { /* body optional — fall through to SSE behavior */ }

        if (payload.fastpath && payload.replyText && payload.replyId) {
          fastReplyIdsRef.current.add(payload.replyId);
          mergeStats({ fastReplies: fastReplyIdsRef.current.size });
          pushAgentReply(payload.replyText, payload.replyId);
          return; // pushAgentReply already restored the rest state
        }
        if (payload.escalated) {
          escalationsRef.current += 1;
          mergeStats({ escalations: escalationsRef.current });
          ttsBridgeRef.current?.speakLocal(nextAck());
        }
        // Full lane: the SSE consumer flips back to rest on reply.
        setState('responding');
      })
      // === END MOD #38 ===
      .catch(() => setState(restState()));
  }, [restState, pushAgentReply]);

  // === JARVIS MOD #39h: turn aggregation ======================================
  // VAD chunk boundaries are STT boundaries, NOT message boundaries. The engine
  // cuts audio after ~950ms of silence (good: fast transcription, fast wake
  // detection), but shipping each chunk to the agent made every natural pause
  // split the thought — "definitely not a normal dialogue" (Scott, 2026-07-12).
  // Accepted content buffers here and only ships after MERGE_WINDOW_MS of
  // post-transcript quiet; anything said in the meantime merges into one turn.
  const pendingTurnRef = useRef('');
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shipPendingTurn = useCallback(() => {
    pendingTimerRef.current = null;
    if (utterSpeechSeenRef.current) {
      // Mid-speech again — hold the buffer until the next quiet window.
      pendingTimerRef.current = setTimeout(shipPendingTurn, MERGE_WINDOW_MS);
      return;
    }
    const text = pendingTurnRef.current.trim();
    pendingTurnRef.current = '';
    if (text) sendText(text);
  }, [sendText]);

  const queueTurn = useCallback(
    (content: string) => {
      pendingTurnRef.current = pendingTurnRef.current
        ? `${pendingTurnRef.current} ${content}`
        : content;
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = setTimeout(shipPendingTurn, MERGE_WINDOW_MS);
    },
    [shipPendingTurn],
  );
  // ===========================================================================

  // === JARVIS MOD #36: the wake gate — every SPOKEN utterance lands here ======
  const handleUtterance = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) {
        setState(restState());
        return;
      }
      const now = performance.now();
      const inFollowUp = now < followUpUntilMsRef.current;
      const { woke, remainder } = wakeMatch(text);
      let decision: string;

      if (woke && !remainder) {
        // Bare "hey jarvis" — attention ping. Open the follow-up window and
        // acknowledge locally (no agent round-trip).
        followUpUntilMsRef.current = now + FOLLOW_UP_MS;
        decision = 'wake-only';
        setState('listening');
        ttsBridgeRef.current?.speakLocal('Sir?');
      } else if (woke || inFollowUp) {
        const content = woke ? remainder : text;
        if (isSignoff(content, hadAgentTurnRef.current)) {
          // Natural goodbye: close the window, speak a short LOCAL sign-off,
          // return to wake-gated rest. No agent call — no grabbing the last word.
          decision = 'signoff';
          followUpUntilMsRef.current = 0;
          const line = SIGNOFF_LINES[signoffIdxRef.current % SIGNOFF_LINES.length];
          signoffIdxRef.current += 1;
          ttsBridgeRef.current?.speakLocal(line);
          setState('wakeListening');
        } else {
          decision = 'accepted';
          wakeStatsRef.current.accepted += 1;
          // MOD #39g: an accepted turn OPENS the follow-up window — the VAD
          // splits long sentences at natural pauses (~950ms), and the tail
          // chunk arrives with no wake word. Before this, that tail was
          // discarded as ambient speech (heard live 2026-07-12 as "it's
          // removing some of the transcript"). Now it rides through as a
          // follow-up, same as speech within 8s after a TTS reply.
          followUpUntilMsRef.current = now + FOLLOW_UP_MS;
          // MOD #39h: buffer + merge instead of send-per-chunk — the agent
          // gets ONE coherent turn after you actually stop talking.
          queueTurn(content);
          setState('listening');
        }
      } else {
        // Not for us — ambient speech without the wake word. No send, but show
        // a dim "heard" line so the discard is visible on-phone (2026-07-08:
        // silent discards made a broken pipeline and a working wake gate
        // indistinguishable during Scott's first real-mic test).
        decision = 'discarded';
        wakeStatsRef.current.discarded += 1;
        setLog((prev) => [
          ...prev.slice(-49),
          { id: `heard-${Date.now()}`, role: 'heard', text, ts: Date.now() },
        ]);
        setState(restState());
      }
      mergeStats({
        wakeGate: {
          ...wakeStatsRef.current,
          lastDecision: decision,
          lastUtterance: text,
        },
        followUpUntilMs: followUpUntilMsRef.current,
      });
    },
    [restState, queueTurn],
  );
  // ===========================================================================

  // === JARVIS MOD #36: open-mic engine ========================================
  const stopOpenMicEngine = useCallback(() => {
    engineRunningRef.current = false;
    cancelAnimationFrame(engineFrameRef.current);
    if (engineRecogRestartRef.current) {
      clearTimeout(engineRecogRestartRef.current);
      engineRecogRestartRef.current = null;
    }
    const recog = engineRecogRef.current;
    engineRecogRef.current = null;
    recog?.abort();
    const rec = engineRecorderRef.current;
    engineRecorderRef.current = null;
    if (rec && rec.state === 'recording') {
      engineDiscardStopRef.current = true;
      try { rec.stop(); } catch { /* already stopped */ }
    }
    engineStreamRef.current?.getTracks().forEach((t) => t.stop());
    engineStreamRef.current = null;
    engineAnalyserRef.current = null;
    // MOD #39: the context is the SHARED session singleton (TTS rides it too) —
    // disconnect our source node but NEVER close the context.
    engineSourceRef.current?.disconnect();
    engineSourceRef.current = null;
    engineCtxRef.current = null;
    setAmplitude(0);
    setInterim('');
  }, []);

  /** Desktop leg: one continuous recognition session, auto-restarted. */
  const startEngineRecognition = useCallback(() => {
    const w = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR || !engineRunningRef.current) return;

    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = true;

    utterStartIdxRef.current = 0;
    utterTextRef.current = '';
    utterHasFinalTailRef.current = false;
    utterInterruptedRef.current = false;

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const results = e.results;
      let text = '';
      for (let i = utterStartIdxRef.current; i < results.length; i++) {
        text += results[i][0].transcript;
      }
      utterTextRef.current = text;
      utterHasFinalTailRef.current =
        results.length > 0 ? results[results.length - 1].isFinal === true : false;
      lastVoiceActivityMsRef.current = performance.now();
      setInterim(text);
      if (text.trim() && !utterSpeechSeenRef.current) {
        utterSpeechSeenRef.current = true;
        if (stateRef.current === 'wakeListening') setState('listening');
      }
      // Barge-in: wake word heard while JARVIS is speaking → cut him off NOW
      // (wake-word-gated: energy-only barge-in false-triggers on speaker echo).
      if (
        !utterInterruptedRef.current &&
        ttsBridgeRef.current?.isSpeaking() &&
        containsWakeWord(text)
      ) {
        utterInterruptedRef.current = true;
        ttsBridgeRef.current.interrupt();
      }
    };

    recognition.onend = () => {
      engineRecogRef.current = null;
      // Flush anything still buffered (the recognizer's own endpointing beat
      // our VAD to it), then auto-restart the session while the engine runs.
      const pending = utterTextRef.current.trim();
      if (pending) {
        utterTextRef.current = '';
        utterStartIdxRef.current = 0;
        utterSpeechSeenRef.current = false;
        utterInterruptedRef.current = false;
        setInterim('');
        handleUtterance(pending);
      }
      if (engineRunningRef.current) {
        engineRecogRestartRef.current = setTimeout(
          () => startEngineRecognition(),
          RECOG_RESTART_MS,
        );
      }
    };

    recognition.onerror = (e?: { error?: string }) => {
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        // MOD #39d: capability failure must NOT overwrite the PREFERENCE — the
        // old setOpenMic(false) persisted '0', so one transient permission
        // hiccup silently disabled wake mode forever (Scott's "mic off keeps
        // coming back", 2026-07-08). Stop the engine for this session, surface
        // the error on the debug line, and retry next launch.
        mergeStats({ openMicError: e.error });
        engineRunningRef.current = false;
        setState('dormant');
        return;
      }
      // Transient (no-speech / network / aborted): onend fires next and restarts.
    };

    engineRecogRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // start() throws if a session is already active — restart shortly.
      engineRecogRestartRef.current = setTimeout(
        () => startEngineRecognition(),
        1000,
      );
    }
  }, [handleUtterance]);

  /** iOS PWA leg: always-running MediaRecorder, stopped at VAD boundaries. */
  const startEngineRecorder = useCallback((stream: MediaStream) => {
    if (!engineRunningRef.current) return;
    const mimeType = MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    engineChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) engineChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      const discarded = engineDiscardStopRef.current;
      engineDiscardStopRef.current = false;
      const chunks = engineChunksRef.current;
      engineChunksRef.current = [];
      // Restart immediately so the next utterance is never missed…
      if (engineRunningRef.current && engineStreamRef.current) {
        startEngineRecorder(engineStreamRef.current);
      }
      // …then transcribe what we captured (unless it was an idle-bound restart).
      if (discarded) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) return;
      // MOD #39g: queue behind any in-flight Whisper call instead of dropping —
      // the old `if (sttBusyRef.current) return` silently threw the audio away.
      sttChainRef.current = sttChainRef.current.then(async () => {
        sttBusyRef.current = true;
        setInterim('Transcribing…');
        try {
          const form = new FormData();
          form.append(
            'audio',
            blob,
            'audio.' + ((recorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm'),
          );
          const res = await fetch('/api/uhs/stt', { method: 'POST', body: form });
          const data = (await res.json()) as { transcript?: string };
          setInterim('');
          const engineText = meaningfulTranscript(data.transcript); // MOD #39e
          if (engineText) {
            // Whisper path has no interim — barge-in check happens here instead.
            if (ttsBridgeRef.current?.isSpeaking() && containsWakeWord(engineText)) {
              ttsBridgeRef.current.interrupt();
            }
            handleUtterance(engineText);
          } else {
            setState(restState());
          }
        } catch {
          setInterim('');
          setState(restState());
        } finally {
          sttBusyRef.current = false;
        }
      });
    };
    engineRecorderRef.current = recorder;
    engineRecorderStartedMsRef.current = performance.now();
    recorder.start(1000); // 1s timeslices keep chunks flowing (bounded memory)
  }, [handleUtterance, restState]);

  const startOpenMicEngine = useCallback(async () => {
    if (engineRunningRef.current) return;
    engineRunningRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Explicit AEC/NS: the mic must not hear JARVIS' own voice as speech.
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!engineRunningRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      engineStreamRef.current = stream;
      // MOD #39: shared unlocked context, never a private one (iOS suspension).
      const ctx = getSharedAudioContext();
      if (!ctx) throw new Error('no-webaudio');
      resumeSharedAudio(); // no-op if already running; real resume post-gesture
      engineCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      engineSourceRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      engineAnalyserRef.current = analyser;

      const ios = isIosPwaStandalone();
      if (ios) startEngineRecorder(stream);
      else startEngineRecognition();

      utterSpeechSeenRef.current = false;
      lastVoiceActivityMsRef.current = performance.now();
      setState(restState());
      mergeStats({ openMic: true, openMicError: null });

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const a = engineAnalyserRef.current;
        if (!a || !engineRunningRef.current) return;
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = Math.min(1, sum / data.length / 255);
        setAmplitude(avg);
        const now = performance.now();

        // --- VAD ---
        const speech = avg > SPEECH_THRESHOLD;
        if (speech) {
          lastVoiceActivityMsRef.current = now;
          if (!utterSpeechSeenRef.current) {
            utterSpeechSeenRef.current = true;
            if (stateRef.current === 'wakeListening') setState('listening');
          }
        }
        // MOD #39: live VAD + audio-context state on the seam so a dead mic is
        // visible on-phone (suspended ctx = all-zero analyser = silent failure).
        mergeStats2Throttled(now, {
          vadSpeechActive: speech,
          vadEnergy: Math.round(avg * 1000) / 1000,
          micCtxState: a.context.state,
        });
        if (a.context.state === 'suspended') resumeSharedAudio();

        // --- Layered end-of-turn detection (smooth-voice Tier 2) ---
        if (utterSpeechSeenRef.current) {
          const silence = now - lastVoiceActivityMsRef.current;
          const hangover = chooseHangoverMs({
            hasFinalTail: utterHasFinalTailRef.current,
            transcript: utterTextRef.current,
          });
          if (silence > hangover) {
            utterSpeechSeenRef.current = false;
            if (ios) {
              // Utterance boundary: stop → transcribe → auto-restart (onstop).
              // MOD #39g: no sttBusy guard — the boundary must ALWAYS cut. The
              // old skip-while-busy left the utterance in the standing blob,
              // where the 20s idle restart could silently discard it.
              const rec = engineRecorderRef.current;
              if (rec?.state === 'recording') {
                setState('processing');
                rec.stop();
              }
            } else {
              // Desktop: take the turn from the live transcript buffer.
              const text = utterTextRef.current.trim();
              utterTextRef.current = '';
              const recog = engineRecogRef.current;
              // Reset the utterance window to "everything after what we've read".
              // Simplest reliable reset: bounce the session (results are
              // per-session); onend flush is suppressed because the buffer is
              // already cleared.
              utterStartIdxRef.current = 0;
              utterHasFinalTailRef.current = false;
              utterInterruptedRef.current = false;
              setInterim('');
              recog?.stop(); // triggers onend → auto-restart with a fresh session
              if (text) handleUtterance(text);
            }
          }
        } else if (ios) {
          // Long silence: restart the recorder so the standing blob stays small.
          const rec = engineRecorderRef.current;
          if (
            rec?.state === 'recording' &&
            now - engineRecorderStartedMsRef.current > IOS_IDLE_RESTART_MS
          ) {
            engineDiscardStopRef.current = true;
            rec.stop(); // onstop discards + restarts
          }
        }

        // Follow-up window expiry moves listening → wakeListening.
        if (
          stateRef.current === 'listening' &&
          !utterSpeechSeenRef.current &&
          now >= followUpUntilMsRef.current
        ) {
          setState('wakeListening');
        }

        engineFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      engineRunningRef.current = false;
      mergeStats({ openMic: false, openMicError: 'mic-unavailable' });
      setState('dormant');
    }
  }, [handleUtterance, restState, startEngineRecognition, startEngineRecorder]);

  // Throttled merge for high-frequency VAD stats (max ~4Hz).
  const lastStatsMsRef = useRef(0);
  const mergeStats2Throttled = (now: number, patch: Record<string, unknown>) => {
    if (now - lastStatsMsRef.current < 250) return;
    lastStatsMsRef.current = now;
    mergeStats(patch);
  };

  // state mirror for use inside the rAF tick (avoid stale closures)
  const stateRef = useRef<VoiceState>('idle');
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Hydrate + persist the open-mic preference; run the engine to match.
  useEffect(() => {
    if (!supported) return;
    const stored = localStorage.getItem(OPEN_MIC_KEY);
    const on = stored === null ? true : stored === '1'; // default ON where supported
    setOpenMic(on);
  }, [supported]);

  useEffect(() => {
    openMicRef.current = openMic;
    localStorage.setItem(OPEN_MIC_KEY, openMic ? '1' : '0');
    mergeStats({ openMic });
    if (openMic && supported) {
      void startOpenMicEngine();
      setState((s) => (s === 'idle' || s === 'dormant' ? 'wakeListening' : s));
    } else {
      stopOpenMicEngine();
      setState((s) =>
        s === 'wakeListening' || s === 'listening' || s === 'dormant' ? 'idle' : s,
      );
    }
  }, [openMic, supported, startOpenMicEngine, stopOpenMicEngine]);

  // iOS suspends the PWA (and kills the stream) on background — restart the
  // engine when the app returns. Mirrors the MOD #30 SSE resume pattern.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (openMicRef.current && !engineRunningRef.current) {
        void startOpenMicEngine();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [startOpenMicEngine]);

  const toggleOpenMic = useCallback(() => setOpenMic((v) => !v), []);

  const bindTts = useCallback((bridge: TtsBridge) => {
    ttsBridgeRef.current = bridge;
  }, []);

  const notifyTtsSpeaking = useCallback(
    (speaking: boolean) => {
      if (!speaking) {
        // JARVIS just finished talking — open the follow-up window (Alexa-style:
        // the next utterance needs no wake word).
        if (openMicRef.current) {
          followUpUntilMsRef.current = performance.now() + FOLLOW_UP_MS;
          mergeStats({ followUpUntilMs: followUpUntilMsRef.current });
          setState((s) => (s === 'responding' || s === 'wakeListening' ? 'listening' : s));
        }
      }
    },
    [],
  );
  // === END MOD #36 (engine) ===================================================

  // === JARVIS MOD #27: MediaRecorder → Whisper path for iOS PWA standalone ===
  // (tap-to-talk fallback — unchanged behavior when open mic is OFF)
  const startListeningMediaRecorder = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      audioChunksRef.current = [];

      // Pick the best supported MIME type — iOS prefers audio/mp4.
      const mimeType = MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopAmplitude();
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size < 1000) {
          // Too short — nothing meaningful recorded.
          setState(restState());
          return;
        }
        setState('processing');
        setInterim('Transcribing…');
        try {
          const form = new FormData();
          form.append('audio', blob, 'audio.' + (mimeType.includes('mp4') ? 'm4a' : 'webm'));
          const res = await fetch('/api/uhs/stt', { method: 'POST', body: form });
          const data = (await res.json()) as { transcript?: string; error?: string };
          setInterim('');
          const tapText = meaningfulTranscript(data.transcript); // MOD #39e
          if (tapText) {
            sendText(tapText);
          } else {
            setState(restState());
          }
        } catch {
          setInterim('');
          setState(restState());
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setState('listening');
      // MOD #39b: REUSE the recorder's stream — a second getUserMedia here made
      // iOS mute one capture and the recorder shipped silence to whisper.
      void startAmplitude(stream);
    } catch {
      setState(restState());
    }
  }, [startAmplitude, stopAmplitude, sendText, restState]);

  const startListening = useCallback(() => {
    // === JARVIS MOD #36: with open mic ON, the mic button is an attention tap —
    // equivalent to saying "Jarvis": opens the follow-up window, no second
    // stream, no second recognizer (the engine already owns the mic). ===
    if (openMicRef.current && engineRunningRef.current) {
      followUpUntilMsRef.current = performance.now() + FOLLOW_UP_MS;
      mergeStats({ followUpUntilMs: followUpUntilMsRef.current });
      setState('listening');
      return;
    }
    // === END MOD #36 ===

    if (isIosPwaStandalone()) {
      startListeningMediaRecorder();
      return;
    }

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
        setState(restState());
      }
    };

    recognition.onerror = () => {
      stopAmplitude();
      setInterim('');
      setState(restState());
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState('listening');
    startAmplitude();
  }, [startAmplitude, stopAmplitude, sendText, startListeningMediaRecorder, restState]);

  const stopListening = useCallback(() => {
    // === JARVIS MOD #36: attention-tap mode has nothing to stop — close the window. ===
    if (openMicRef.current && engineRunningRef.current) {
      followUpUntilMsRef.current = 0;
      setState('wakeListening');
      return;
    }
    // === END MOD #36 ===
    // Triggers onend (SpeechRecognition) or onstop (MediaRecorder) → sendText.
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAmplitude();
  }, [stopAmplitude]);
  // MOD #39c: late-bind for the amplitude tick (defined above stopListening).
  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  // === JARVIS MOD #36: micless test seam — drives the WAKE-GATE path directly
  // (Playwright can't speak into a real mic; MOD #21 lore). Merge-safe: its own
  // window key, assigned once. ===
  useEffect(() => {
    window.__cosmosVoiceTest = {
      utterance: (text: string) => handleUtterance(text),
      agentReply: (text: string) =>
        pushAgentReply(text, `test-agent-${Date.now()}`),
    };
    return () => {
      delete window.__cosmosVoiceTest;
    };
  }, [handleUtterance, pushAgentReply]);
  // === END MOD #36 ===

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopAmplitude();
      // === JARVIS MOD #36: tear the open-mic engine down with the component ===
      stopOpenMicEngine();
      // === END MOD #36 ===
    };
  }, [stopAmplitude, stopOpenMicEngine]);

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
    // === JARVIS MOD #33: authoritative sent-turn counter (all send paths) ===
    sentTurnsRef,
    // === END JARVIS MOD #33 ===
    // === JARVIS MOD #36: open-mic surface ===
    openMic,
    toggleOpenMic,
    bindTts,
    notifyTtsSpeaking,
    // === END MOD #36 ===
    // === JARVIS MOD #38: sync fast-reply dedupe set ===
    fastReplyIdsRef,
    // === END MOD #38 ===
  };
}
// === END JARVIS MOD #20 ===
