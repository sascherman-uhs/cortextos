'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
// === JARVIS MOD #25 — PWA boot (SW registration + iOS audio unlock) ===
import { PwaBoot } from '@/components/cosmos/pwa-boot';
// === END JARVIS MOD #25 ===
// === JARVIS MOD #84 — mount the latency + cost telemetry panel (2026-08-03) ===
// Mounted here rather than in scene.tsx (where DataPanels lives) to keep this
// wave's edits off a file another agent is actively changing. The panel is a
// plain DOM overlay — it does not need to be inside the R3F tree.
import { TelemetryPanel } from '@/components/cosmos/telemetry-panel';
// === END JARVIS MOD #84 ===
// === JARVIS MOD #99 — mount the revenue celebration overlay (2026-08-03) ===
// Same reasoning as #84: a plain DOM overlay, mounted outside the R3F tree so
// this wave's edits stay off scene.tsx. Renders nothing at all until a real
// contract-won event arrives from /api/uhs/celebrations.
import { Celebration } from '@/components/cosmos/celebration';
// === END JARVIS MOD #99 ===

// R3F Canvas must run client-only; ssr:false is allowed here (client component).
const Scene = dynamic(() => import('@/components/cosmos/scene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-[#050b14]">
      <span className="text-sm tracking-[0.4em] text-[#5eead4]/60">JARVIS</span>
    </div>
  ),
});

export function CosmosClient() {
  return (
    <>
      {/* === JARVIS MOD #25: mount PWA boot alongside the scene (renders nothing) === */}
      <PwaBoot />
      {/* === JARVIS MOD #40 — back button to CortexOS (immersive route has no chrome) === */}
      <Link
        href="/"
        aria-label="Back to CortexOS"
        data-cosmos=""
        className="fixed z-50 flex items-center gap-1.5 rounded-full border border-[#5eead4]/25 bg-[#0a141c]/60 px-3 py-1.5 text-xs font-medium tracking-wide text-[#9fdfd6]/85 backdrop-blur-md transition-colors duration-300 hover:border-[#5eead4]/55 hover:text-[#c9f5ee]"
        style={{
          top: 'max(0.75rem, env(safe-area-inset-top))',
          left: 'max(0.75rem, env(safe-area-inset-left))',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        CortexOS
      </Link>
      {/* === END JARVIS MOD #40 === */}
      <Scene />
      {/* === JARVIS MOD #84 === */}
      <TelemetryPanel />
      {/* === END JARVIS MOD #84 === */}
      {/* === JARVIS MOD #99 === */}
      <Celebration />
      {/* === END JARVIS MOD #99 === */}
    </>
  );
}
