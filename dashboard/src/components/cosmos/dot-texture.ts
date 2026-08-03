'use client';

// === JARVIS MOD #78 — soft round points (2026-08-03) ===
// THE reason the scene read "HUD, not cinematic". Every star, every node-web
// node and every dust mote was drawn by a bare THREE.PointsMaterial, which
// rasterises each point as a hard-edged SQUARE. Zoomed into empty background
// the sky was visibly made of little aliased squares — and MOD #74's dust motes,
// being the largest points, showed up as unmistakable grey BOXES. Nothing else
// in the scene said "debug overlay" half as loudly.
//
// One shared radial-gradient alpha map fixes all of them: points become soft
// round dots, the big near-field motes read as defocused bokeh instead of
// artifacts, and twinkle finally looks like twinkle. Module-cached, generated
// on an offscreen canvas — no asset, no request, no npm dependency.

import * as THREE from 'three';

let softDot: THREE.CanvasTexture | null = null;

export function getSoftDotTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null; // SSR
  if (softDot) return softDot;

  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // A tight bright core with a long soft tail: a hard stop at the edge would
  // just trade square aliasing for circular aliasing.
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  softDot = new THREE.CanvasTexture(cv);
  softDot.colorSpace = THREE.SRGBColorSpace;
  return softDot;
}

// === JARVIS MOD #79 — atmospheric bloom profile (2026-08-03) ===
// The orb's widest glow layer was a BackSide fresnel shell, and a fresnel shell
// is brightest at its own silhouette — so the "wide atmospheric bloom" actually
// rendered as a faint disc with a defined circular EDGE around the orb. It read
// as a sticker, not as atmosphere, and no amount of dimming fixes the shape.
// Atmosphere has to be brightest AT the body and fade outward, which a
// camera-facing sprite with a long gradient tail does and a shell cannot.
let softGlow: THREE.CanvasTexture | null = null;

export function getSoftGlowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (softGlow) return softGlow;

  const s = 256; // larger: this one is stretched across the whole orb
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // Deliberately gentle all the way out — any steep stop reintroduces an edge.
  g.addColorStop(0.0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.42)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);

  softGlow = new THREE.CanvasTexture(cv);
  softGlow.colorSpace = THREE.SRGBColorSpace;
  return softGlow;
}
// === END JARVIS MOD #79 ===
// === END JARVIS MOD #78 ===
