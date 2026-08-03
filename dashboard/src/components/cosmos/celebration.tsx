'use client';

// === JARVIS MOD #96/#97/#98 — revenue celebration overlay (2026-08-03) ===
// New file. Trillion rubric item 14, "emotional moments": a contract landing
// should FEEL like something, scaled to what it's worth, and it must never be
// missed just because nobody was looking at the screen when it happened.
//
// #96 — the visual, three tiers off the real staging_price:
//        shimmer   (<$3k or price not entered yet) — one gold ring off the orb
//        burst     ($3k–$8k)                       — radial burst + orb flare
//        supernova (>$8k)                          — burst + expanding rings +
//                                                    a brief starfield surge
// #97 — a short synthesized WebAudio chime (no asset files, no packages),
//        gated behind the shared TTS mute preference AND the iOS audio-unlock
//        state, so it can never be the thing that makes a muted phone talk.
// #98 — replay-on-reconnect: the client remembers the last event seq it saw in
//        localStorage and plays anything newer on load, labelled "while you
//        were away". Cap and dedupe live in @/lib/uhs/celebration (tested).
//
// WARM ACCENT: MOD #56 reserves UHS gold for "listening" so the cool palette
// keeps one warm note. A celebration is allowed to spend gold because it is a
// transient EVENT, not chrome — and it leaves nothing behind: the whole tree
// unmounts when the ~4s sequence ends, so there is no residue to confuse the
// listening state a second later.
//
// REDUCED MOTION: not a dimmer switch. Under prefers-reduced-motion the entire
// animated layer is skipped and the news arrives as a static card — the event
// is never swallowed, it just stops moving (rubric item 11).
//
// This is a plain DOM overlay mounted from cosmos-client, deliberately outside
// the R3F tree: the orb/scene internals belong to another agent this wave, and
// a burst anchored at the viewport centre lands exactly on the orb anyway
// (the camera looks at the origin and the orb sits there — see framing.ts).

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAmount, planReplay, type CelebrationEvent } from '@/lib/uhs/celebration';
import { getSharedAudioContext, resumeSharedAudio } from './audio-unlock';
import { orbWidthFraction } from './framing';
import { DUR_BASE, EASE, prefersReducedMotion } from './motion';
import { COOL_DIM, COOL_LINE, COOL_TEXT, GOLD, GOLD_RGB } from './palette';

const SEEN_KEY = 'cosmos-celebration-seen';
const TTS_MUTE_KEY = 'cosmos-tts-muted';
const POLL_MS = 60_000;

/** How long each tier holds the screen before the next one in the queue. */
const TIER_MS: Record<CelebrationEvent['tier'], number> = {
  shimmer: 3200,
  burst: 4000,
  supernova: 4600,
};
const STATIC_MS = 6000;

interface QueuedCelebration {
  event: CelebrationEvent;
  /** True when this is news the viewer missed rather than something live. */
  replay: boolean;
  /** Unseen events beyond the replay cap, stated rather than silently dropped. */
  alsoMissed: number;
}

// --- #97 chime -------------------------------------------------------------

/** A5-rooted rising figure; more notes the bigger the deal. */
const CHIME_NOTES: Record<CelebrationEvent['tier'], number[]> = {
  shimmer: [880.0, 1108.73],
  burst: [880.0, 1108.73, 1318.51],
  supernova: [880.0, 1108.73, 1318.51, 1760.0, 2217.46],
};

function ttsMuted(): boolean {
  try {
    return window.localStorage.getItem(TTS_MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Play the chime, or don't — silently.
 *
 * Two gates, both deliberate: the shared TTS mute preference (one mute control
 * for everything JARVIS makes noise with, not a second hidden one), and the
 * AudioContext actually being `running`, which on iOS only happens after the
 * gesture unlock in MOD #25. Never calls ctx.resume() into existence — if the
 * user has not tapped anything yet, the celebration is simply silent.
 */
function playChime(tier: CelebrationEvent['tier']): void {
  if (ttsMuted()) return;
  resumeSharedAudio();
  const ctx = getSharedAudioContext();
  if (!ctx || ctx.state !== 'running') return;

  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    // Quiet on purpose: this lands under whatever else is happening, it does
    // not interrupt a reply mid-sentence.
    master.gain.value = 0.14;
    master.connect(ctx.destination);

    CHIME_NOTES[tier].forEach((freq, i) => {
      const t = now + i * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(1, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc.stop(t + 0.9);
    });

    if (tier === 'supernova') {
      // One low swell under the arpeggio so the biggest tier has weight and is
      // audibly a different event, not just a longer one.
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'triangle';
      sub.frequency.value = 110;
      subGain.gain.setValueAtTime(0.0001, now);
      subGain.gain.exponentialRampToValueAtTime(0.6, now + 0.25);
      subGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      sub.connect(subGain);
      subGain.connect(master);
      sub.start(now);
      sub.stop(now + 1.7);
    }
  } catch {
    /* WebAudio unavailable or blocked — a silent celebration is still a celebration */
  }
}

// --- #98 feed + replay -----------------------------------------------------

function readSeen(): number {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeSeen(seq: number): void {
  try {
    window.localStorage.setItem(SEEN_KEY, String(seq));
  } catch {
    /* private mode — replay degrades to "plays again next load", never crashes */
  }
}

/**
 * Poll the feed and turn it into a play queue.
 *
 * The FIRST response after mount is the reconnect check (anything unseen is
 * news the viewer missed → replay label). Every later poll is live, so a sale
 * landing while the tab is open is celebrated as it happens.
 */
function useCelebrationQueue(): [QueuedCelebration | null, () => void] {
  const [queue, setQueue] = useState<QueuedCelebration[]>([]);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/uhs/celebrations', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { events?: CelebrationEvent[] };
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) {
        firstLoad.current = false;
        return;
      }

      const replay = firstLoad.current;
      const plan = planReplay(events, readSeen());
      firstLoad.current = false;
      if (!plan.play.length) {
        writeSeen(plan.nextSeen);
        return;
      }

      setQueue((prev) => {
        const known = new Set(prev.map((q) => q.event.seq));
        const additions = plan.play
          .filter((e) => !known.has(e.seq))
          .map((event, i) => ({
            event,
            replay,
            // Only the first card in a batch carries the "and N more" line.
            alsoMissed: i === 0 ? plan.skipped : 0,
          }));
        return additions.length ? [...prev, ...additions] : prev;
      });
      // Marked seen at enqueue, not at play: a tab closed mid-sequence should
      // not replay the same win forever.
      writeSeen(plan.nextSeen);
    } catch {
      /* offline / dev-server restart — next poll picks it up */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    // A tab that was hidden for hours checks immediately on return rather than
    // waiting out the poll interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const advance = useCallback(() => setQueue((prev) => prev.slice(1)), []);
  return [queue[0] ?? null, advance];
}

// --- #96 visual ------------------------------------------------------------

const KEYFRAMES = `
@keyframes cel-flare {
  0%   { opacity: 0;    transform: scale(0.35); }
  18%  { opacity: 0.95; transform: scale(1.05); }
  100% { opacity: 0;    transform: scale(2.4); }
}
@keyframes cel-ring {
  0%   { opacity: 0;    transform: scale(0.4); }
  12%  { opacity: 0.85; }
  100% { opacity: 0;    transform: scale(var(--cel-ring-max, 3)); }
}
@keyframes cel-ray {
  0%   { opacity: 0;   transform: rotate(var(--cel-a)) translateY(var(--cel-r0)) scaleY(0.2); }
  16%  { opacity: 0.9; }
  100% { opacity: 0;   transform: rotate(var(--cel-a)) translateY(var(--cel-r1)) scaleY(1); }
}
@keyframes cel-spark {
  0%   { opacity: 0;   transform: rotate(var(--cel-a)) translateY(var(--cel-r0)) scale(0.4); }
  22%  { opacity: 1; }
  100% { opacity: 0;   transform: rotate(var(--cel-a)) translateY(var(--cel-r1)) scale(1); }
}
@keyframes cel-card {
  0%   { opacity: 0; transform: translateY(10px); }
  12%  { opacity: 1; transform: translateY(0); }
  88%  { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-6px); }
}
`;

/** Deterministic pseudo-random from the event seq — same event, same sparks. */
function jitter(seed: number, i: number): number {
  const x = Math.sin(seed * 97.13 + i * 41.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * On-screen radius of the orb, in px.
 *
 * The first cut hard-coded the burst radii in rem and the rays were invisible:
 * they spent their whole life INSIDE the orb, which is ~14rem across on a
 * 1440px desktop and proportionally far bigger on a phone. The orb's size is
 * already derived once in framing.ts (`orbWidthFraction` of the visible
 * half-width), so the burst reads it from there rather than guessing — the
 * rays now leave from the orb's edge at every viewport instead of a fixed
 * distance that only happened to look right at one.
 */
function useOrbRadiusPx(): { orb: number; maxR: number } {
  const [dims, setDims] = useState({ orb: 220, maxR: 430 });
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setDims({
        orb: orbWidthFraction(w / Math.max(1, h)) * (w / 2),
        // Everything thrown outward is clamped inside the frame. The orb radius
        // is derived from viewport WIDTH, so on a 1440x900 desktop a ray sent
        // to 2.7x the orb radius lands 600px from centre in a frame that is
        // only 450px tall — measured, it was leaving the bottom of the screen
        // entirely. A burst nobody can see is not a burst.
        maxR: 0.47 * Math.min(w, h),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return dims;
}

function Burst({ event }: { event: CelebrationEvent }) {
  const { tier, seq } = event;
  const { orb, maxR } = useOrbRadiusPx();
  const reach = (mult: number) => Math.round(Math.min(orb * mult, maxR));
  const rings = tier === 'supernova' ? 3 : tier === 'burst' ? 2 : 1;
  const rays = tier === 'shimmer' ? 0 : tier === 'supernova' ? 28 : 18;
  const sparks = tier === 'supernova' ? 60 : 0;
  const dur = TIER_MS[tier];

  return (
    // `screen` blending is what makes gold read on top of a bright teal orb.
    // The first cut composited normally and the rays vanished into the orb's
    // own glow — the scene itself uses additive blending for exactly this
    // reason, so the overlay matches it.
    <div
      className="pointer-events-none absolute left-1/2 top-1/2 h-0 w-0"
      style={{ mixBlendMode: 'screen' }}
    >
      {/* Orb flare — a warm disc blooming out of the orb's own position. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: orb * 2.2,
          height: orb * 2.2,
          background: `radial-gradient(circle, rgba(${GOLD_RGB},0.5) 0%, rgba(${GOLD_RGB},0.2) 40%, rgba(${GOLD_RGB},0) 70%)`,
          animation: `cel-flare ${Math.round(dur * 0.8)}ms ${EASE} forwards`,
        }}
      />

      {Array.from({ length: rings }, (_, i) => (
        <div
          key={`ring-${i}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={
            {
              width: orb * 2,
              height: orb * 2,
              borderColor: `rgba(${GOLD_RGB},0.75)`,
              borderWidth: i === 0 ? 2 : 1,
              boxShadow: `0 0 22px rgba(${GOLD_RGB},0.28)`,
              '--cel-ring-max': `${1.35 + i * 0.5}`,
              animation: `cel-ring ${Math.round(dur * 0.85)}ms ${EASE} ${i * 180}ms forwards`,
              opacity: 0,
            } as React.CSSProperties
          }
        />
      ))}

      {Array.from({ length: rays }, (_, i) => (
        <div
          key={`ray-${i}`}
          className="absolute origin-top"
          style={
            {
              width: 3,
              height: Math.round(orb * 0.5),
              left: -1.5,
              top: 0,
              background: `linear-gradient(to bottom, #fff8ec 0%, rgba(${GOLD_RGB},0.95) 30%, rgba(${GOLD_RGB},0) 100%)`,
              boxShadow: `0 0 10px rgba(${GOLD_RGB},0.8)`,
              '--cel-a': `${(360 / rays) * i + jitter(seq, i) * 6}deg`,
              // Leaves from the orb's own edge, not from its middle, and gets
              // clear of the orb's glow quickly — a ray only reads against the
              // dark, so it must not spend its bright phase inside the disc.
              '--cel-r0': `${Math.round(orb * 0.95)}px`,
              '--cel-r1': `${reach(tier === 'supernova' ? 2.7 : 2.1)}px`,
              animation: `cel-ray ${Math.round(dur * 0.45)}ms ${EASE} ${jitter(seq, i + 90) * 90}ms forwards`,
              opacity: 0,
            } as React.CSSProperties
          }
        />
      ))}

      {/* Supernova only: a brief surge of stars thrown outward, then gone. */}
      {Array.from({ length: sparks }, (_, i) => (
        <div
          key={`spark-${i}`}
          className="absolute rounded-full"
          style={
            {
              width: 3 + Math.round(jitter(seq, i + 300) * 3),
              height: 3 + Math.round(jitter(seq, i + 300) * 3),
              left: -1.5,
              top: 0,
              background: i % 3 === 0 ? '#ffffff' : GOLD,
              boxShadow: `0 0 9px rgba(${GOLD_RGB},0.9)`,
              '--cel-a': `${jitter(seq, i) * 360}deg`,
              '--cel-r0': `${Math.round(orb * 0.9)}px`,
              '--cel-r1': `${reach(1.5 + jitter(seq, i + 700) * 2)}px`,
              animation: `cel-spark ${Math.round(dur * 0.75)}ms ${EASE} ${jitter(seq, i + 500) * 220}ms forwards`,
              opacity: 0,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function Card({
  item,
  animated,
}: {
  item: QueuedCelebration;
  animated: boolean;
}) {
  const { event, replay, alsoMissed } = item;
  const dur = TIER_MS[event.tier];

  return (
    <div
      data-testid="celebration-card"
      data-tier={event.tier}
      data-seq={event.seq}
      data-replay={replay ? 'true' : 'false'}
      className="pointer-events-none absolute left-1/2 w-[min(21rem,86vw)] -translate-x-1/2 rounded-2xl border px-5 py-4 text-center backdrop-blur-xl top-[9.5rem] md:top-[17%]"
      style={{
        borderColor: `rgba(${GOLD_RGB},0.4)`,
        background: 'rgba(16,26,34,0.78)',
        boxShadow: `0 0 40px rgba(${GOLD_RGB},0.16)`,
        ...(animated
          ? { animation: `cel-card ${dur}ms ${EASE} forwards`, opacity: 0 }
          : { transition: `opacity ${DUR_BASE}ms ${EASE}` }),
      }}
    >
      <div className="flex items-center justify-center gap-2">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.22em]"
          style={{ color: GOLD }}
        >
          Contract won
        </span>
        {event.test ? (
          <span
            data-testid="celebration-test-badge"
            className="rounded-full border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.14em]"
            style={{ borderColor: COOL_LINE, color: COOL_DIM }}
          >
            Test
          </span>
        ) : null}
      </div>

      <div className="mt-2 text-2xl font-semibold tabular-nums" style={{ color: COOL_TEXT }}>
        {formatAmount(event.amount)}
      </div>
      <div className="mt-1 text-sm" style={{ color: COOL_TEXT, opacity: 0.85 }}>
        {event.label}
      </div>

      {replay ? (
        <div
          data-testid="celebration-replay-label"
          className="mt-2 text-[10px] uppercase tracking-[0.18em]"
          style={{ color: COOL_DIM }}
        >
          While you were away
          {alsoMissed > 0 ? ` · ${alsoMissed} more not shown` : ''}
        </div>
      ) : null}
    </div>
  );
}

export function Celebration() {
  const [current, advance] = useCelebrationQueue();
  const [reduced, setReduced] = useState(false);

  // Live, not read-once: flipping the OS preference mid-session must take
  // effect on the next celebration without a reload.
  useEffect(() => {
    setReduced(prefersReducedMotion());
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const seq = current?.event.seq ?? null;
  const tier = current?.event.tier ?? null;

  // One timer per celebration, then hand the screen to the next in the queue.
  useEffect(() => {
    if (seq == null || tier == null) return;
    playChime(tier);
    const hold = reduced ? STATIC_MS : TIER_MS[tier];
    const timer = window.setTimeout(advance, hold);
    return () => window.clearTimeout(timer);
  }, [seq, tier, reduced, advance]);

  // Test seam, same convention as the rest of the scene. Written through a
  // local cast rather than by extending the ambient __cosmosStats type, which
  // lives in scene.tsx — another agent owns that file this wave. MERGED, never
  // reassigned wholesale (MOD #36 rule).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __cosmosStats?: Record<string, unknown> };
    w.__cosmosStats = {
      ...(w.__cosmosStats ?? {}),
      celebrationSeq: seq ?? undefined,
      celebrationTier: tier ?? undefined,
    };
  }, [seq, tier]);

  if (!current) return null;

  return (
    <div
      data-testid="celebration"
      data-cosmos=""
      className="pointer-events-none fixed inset-0 z-40 overflow-hidden"
      aria-live="polite"
    >
      {!reduced ? (
        <>
          <style>{KEYFRAMES}</style>
          <Burst event={current.event} />
        </>
      ) : null}
      <Card item={current} animated={!reduced} />
    </div>
  );
}
// === END JARVIS MOD #96/#97/#98 ===
