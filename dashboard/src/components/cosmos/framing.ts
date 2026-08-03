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

/** Camera distance that frames the orb at `orbWidthFraction` for this aspect. */
export function cameraZForAspect(fovDeg: number, aspect: number): number {
  const tanH = Math.tan((fovDeg * Math.PI) / 360);
  const safeAspect = Math.max(0.2, aspect);
  const halfW = ORB_RADIUS / orbWidthFraction(safeAspect);
  return Math.max(4.5, Math.min(24, halfW / (tanH * safeAspect)));
}
// === END JARVIS MOD #58 ===
