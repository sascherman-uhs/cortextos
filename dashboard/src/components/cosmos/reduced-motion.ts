'use client';

// === JARVIS MOD #70 — Cosmos reduced-motion: freeze the CLOCK, not the framerate.
// (2026-08-03)
//
// MOD #62 set `frameloop='demand'` and called it done. It was not: `frameloop`
// throttles how OFTEN react-three-fiber draws, but `state.clock` is a wall
// clock that keeps accumulating regardless. The scene re-renders whenever React
// does (the /api/agents poll alone fires every 3s), and each of those renders
// drew a frame with THREE SECONDS of accumulated clock time — so the orb, the
// starfields and the orbits all jumped forward exactly as far as they would
// have anyway. Measured with the critic's method (emulateMedia reduce + reload,
// frames 3s apart): 26.88% pixel delta vs a 24.65% motion-allowed control —
// statistically the same scene. Reducing frames is not reducing motion.
//
// The fix is to freeze the time SOURCE. Every useFrame in the scene reads
// `sceneTime(state.clock.elapsedTime)`, which returns a fixed instant while the
// preference is on, so any frame that does get drawn is pixel-identical to the
// last one. `frameloop='demand'` stays on top of this purely to save GPU.
//
// Module-level rather than React context on purpose: this is read inside
// useFrame callbacks (never during render), so it must not participate in
// reconciliation — a context change would re-render the whole scene graph.

let reduced = false;

/** Set from scene.tsx's media-query listener. */
export function setReducedMotion(value: boolean): void {
  reduced = value;
}

export function isReducedMotion(): boolean {
  return reduced;
}

/**
 * The instant the scene freezes at. Not 0 — at t=0 the noise field is
 * undisplaced and the orbits are all at angle0, which reads as a broken
 * render rather than a deliberate still.
 */
export const FROZEN_T = 12;

/** Elapsed scene time, frozen while the reduced-motion preference is on. */
export function sceneTime(elapsed: number): number {
  return reduced ? FROZEN_T : elapsed;
}

/** Frame delta, clamped against tab-resume spikes and zeroed when frozen. */
export function sceneDelta(delta: number): number {
  return reduced ? 0 : Math.min(delta, 0.1);
}

/**
 * Half-life for `approach()`. Returns 0 when frozen, which makes the easing
 * land on its target immediately — reduced motion means no travel, not slow
 * travel.
 */
export function sceneHalfLife(halfLife: number): number {
  return reduced ? 0 : halfLife;
}
// === END JARVIS MOD #70 ===
