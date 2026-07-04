'use client';

const STORAGE_KEY = 'cosmos-perf-mode';

export type PerfMode = 'high' | 'low';

/** Read persisted perf mode. Defaults to 'high'. SSR-safe. */
export function readPerfMode(): PerfMode {
  if (typeof window === 'undefined') return 'high';
  return window.localStorage.getItem(STORAGE_KEY) === 'low' ? 'low' : 'high';
}

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
      className="pointer-events-auto fixed bottom-6 right-6 z-10 rounded-full border border-white/15 bg-[#FDFEF9]/10 px-4 py-2 text-xs font-medium tracking-wide text-[#EDE8DF] shadow-lg backdrop-blur-md transition-colors hover:bg-[#FDFEF9]/20"
    >
      {mode === 'high' ? 'Performance: High' : 'Performance: Low'}
    </button>
  );
}
