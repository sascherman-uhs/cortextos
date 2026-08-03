'use client';

// === JARVIS MOD #55 — Cosmos motion tokens (2026-08-03) ===
// ONE easing curve for the whole Cosmos surface (Trillion rubric item 1:
// "nothing snaps — one shared easing, every property eases per frame").
// CSS transitions use EASE / the `cosmos-ease` utility in globals.css; frame
// loops use `approach()` so per-frame smoothing is frame-rate independent
// instead of the `x += (t - x) * k` pattern that speeds up on a 120Hz display.

export const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** Standard transition durations (ms). Longer than default so the curve reads. */
export const DUR_FAST = 180;
export const DUR_BASE = 320;
export const DUR_SLOW = 620;

/** Inline style for any CSS transition in the Cosmos scene. */
export function transition(props: string, ms: number = DUR_BASE): string {
  return props
    .split(',')
    .map((p) => `${p.trim()} ${ms}ms ${EASE}`)
    .join(', ');
}

/**
 * Frame-rate-independent exponential approach.
 * `halfLife` = seconds for the remaining distance to halve. Never snaps.
 */
export function approach(current: number, target: number, halfLife: number, delta: number): number {
  if (halfLife <= 0) return target;
  const k = 1 - Math.pow(0.5, delta / halfLife);
  return current + (target - current) * k;
}

/**
 * Asymmetric approach — the Trillion voice-brightness envelope: jumps on
 * syllables (fast attack), releases slowly so it never twitches.
 */
export function approachAsym(
  current: number,
  target: number,
  attackHalfLife: number,
  decayHalfLife: number,
  delta: number,
): number {
  return approach(current, target, target > current ? attackHalfLife : decayHalfLife, delta);
}

/** True when the OS asks for reduced motion (SSR-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
// === END JARVIS MOD #55 ===
