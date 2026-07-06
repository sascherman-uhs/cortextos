'use client';

const STORAGE_KEY = 'cosmos-perf-mode';

export type PerfMode = 'high' | 'low';

/** Read persisted perf mode. Defaults to 'high'. SSR-safe. */
export function readPerfMode(): PerfMode {
  if (typeof window === 'undefined') return 'high';
  return window.localStorage.getItem(STORAGE_KEY) === 'low' ? 'low' : 'high';
}

// === JARVIS MOD #25 — distinguish "no stored preference" from an explicit choice.
// The scene needs this to default mobile viewports to 'low' WITHOUT overriding a
// user who explicitly toggled (on either mode). Returns null when unset. ===
export function readStoredPerfMode(): PerfMode | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'low' ? 'low' : v === 'high' ? 'high' : null;
}
// === END JARVIS MOD #25 ===

interface PerfToggleProps {
  mode: PerfMode;
  onChange: (mode: PerfMode) => void;
}

export function PerfToggle({ mode, onChange }: PerfToggleProps) {
  function toggle() {
    const next: PerfMode = mode === 'high' ? 'low' : 'high';
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
    onChange(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={`Performance mode: ${mode}. Click to switch.`}
      // === JARVIS MOD #25: offset past the notch's safe-area insets on mobile ===
      style={{
        bottom: 'calc(1.5rem + env(safe-area-inset-bottom))',
        right: 'calc(1.5rem + env(safe-area-inset-right))',
      }}
      className="pointer-events-auto fixed z-10 rounded-full border border-white/15 bg-[#FDFEF9]/10 px-4 py-2 text-xs font-medium tracking-wide text-[#EDE8DF] shadow-lg backdrop-blur-md transition-colors hover:bg-[#FDFEF9]/20"
    >
      {mode === 'high' ? 'Performance: High' : 'Performance: Low'}
    </button>
  );
}
