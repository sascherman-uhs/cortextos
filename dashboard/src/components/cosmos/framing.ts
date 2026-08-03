'use client';

// === JARVIS MOD #58 — Cosmos framing math (2026-08-03) ===
// Single source of truth for "how big is the scene at this viewport". Both the
// camera dolly (scene.tsx) and the orbit-radius fit (agent-orbits.tsx) derive
// from these pure functions, so they can never disagree — reading
// camera.position.z from a sibling component would have raced on resize.

/** Icosahedron radius of the centerpiece orb (orb.tsx geometry arg). */
export const ORB_RADIUS = 1.55;

/** Visible half-height at distance d for a perspective camera. */
export function halfHeightAt(fovDeg: number, d: number): number {
  return Math.tan((fovDeg * Math.PI) / 360) * d;
}

/**
 * Orb radius as a fraction of the visible half-width. Wide viewports keep the
 * long-standing desktop framing (0.31 ≈ the pre-MOD-58 look); as the viewport
 * narrows toward portrait the orb claims more of the width so it stays the
 * hero instead of being cropped by the frustum (critic defect #7).
 */
export function orbWidthFraction(aspect: number): number {
  if (aspect >= 0.8) return 0.31;
  return Math.min(0.55, 0.31 + (0.8 - aspect) * 0.6);
}

// === JARVIS MOD #71 — wordmark exclusion zone (2026-08-03) ===
// On a phone, two orbiting agents clipped straight through the "JARVIS"
// wordmark (the R and S were unreadable in the wave-2 shot). Fitting the orbit
// to the frustum was not enough — the frustum contains DOM chrome the 3D scene
// knows nothing about. The portrait orbit is now fitted to a vertical BAND
// bounded by the real screen positions of that chrome, and the band's centre
// becomes a y-offset for the whole orbit system.
//
// Fractions are of viewport height, measured from the top:
/** Below the header + stat strip + perf pill. */
export const PORTRAIT_BAND_TOP = 0.2;
/** Above the wordmark's top edge (rendered at 65%), with clearance. */
export const PORTRAIT_BAND_BOTTOM = 0.62;

/** World-space Y of a screen-height fraction at the z=0 plane. */
export function worldYAtScreenFrac(fovDeg: number, camZ: number, frac: number): number {
  return (0.5 - frac) * 2 * halfHeightAt(fovDeg, camZ);
}
// === END JARVIS MOD #71 ===

/** Camera distance that frames the orb at `orbWidthFraction` for this aspect. */
export function cameraZForAspect(fovDeg: number, aspect: number): number {
  const tanH = Math.tan((fovDeg * Math.PI) / 360);
  const safeAspect = Math.max(0.2, aspect);
  const halfW = ORB_RADIUS / orbWidthFraction(safeAspect);
  return Math.max(4.5, Math.min(24, halfW / (tanH * safeAspect)));
}
// === END JARVIS MOD #58 ===
