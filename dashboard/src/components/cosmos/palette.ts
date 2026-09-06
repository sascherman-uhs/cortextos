'use client';

// === JARVIS MOD #29 — Trillion "cosmic orb" palette (2026-07-06) ===
// Scott-approved teal/cyan/purple cosmic scheme replacing the prior UHS gold in
// the Cosmos /jarvis scene ONLY. Do not use these outside src/components/cosmos.

export const TEAL = '#2dd4bf'; // primary orb base
export const CYAN = '#22d3ee'; // listening / bright accents
export const AQUA = '#5eead4'; // mid tone
export const MINT = '#99f6e4'; // rim highlight
export const PURPLE = '#a78bfa'; // processing accent
export const BLUE = '#38bdf8'; // node-web variety
export const INDIGO = '#6366f1'; // node-web variety
export const RED = '#f87171'; // error / down status
export const GREEN = '#34d399'; // online status pulse

// === JARVIS MOD #56 — the ONE warm accent (2026-08-03) ===
// Trillion rubric item 3: a cool palette with a single warm accent RESERVED for
// "listening". UHS gold is that accent — it may appear ONLY while the mic is
// actually hot. Every other piece of idle chrome in this scene stays cool
// (see COOL_* below); per-agent identity accents in AGENT_ACCENTS are exempt.
export const GOLD = '#CFB383';
export const GOLD_DEEP = '#9E7331';
/** rgba() form for glows/shadows where a hex + alpha is awkward. */
export const GOLD_RGB = '207, 179, 131';

// Cool chrome: what idle UI used to spend gold on.
export const COOL_TEXT = '#dbeff2'; // primary text on glass
export const COOL_DIM = '#8fb8bd'; // secondary/label text
export const COOL_SURFACE = '#101a22'; // glass fill (Trillion #16171D, cooled)
export const COOL_LINE = 'rgba(148, 214, 216, 0.22)'; // hairline borders
// === END JARVIS MOD #56 ===

// Deep-space backdrop. Very dark blue-teal so additive glow reads.
export const SPACE = '#050b14';
export const SPACE_2 = '#0a1420';

// Node-web node colors (cycled per cluster).
export const NODE_COLORS = [TEAL, CYAN, PURPLE, BLUE, INDIGO, MINT];

// Per-agent avatar accent colors (hash-assigned).
export const AGENT_ACCENTS = [
  TEAL,
  CYAN,
  PURPLE,
  BLUE,
  '#f0abfc', // fuchsia
  '#5eead4',
  '#818cf8',
  '#2dd4bf',
];

/** Stable small hash → index into a palette array. */
export function hashIndex(s: string, len: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % len;
}
// === END JARVIS MOD #29 ===
