'use client';

import dynamic from 'next/dynamic';

// R3F Canvas must run client-only; ssr:false is allowed here (client component).
const Scene = dynamic(() => import('@/components/cosmos/scene'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-[#2D2928]">
      <span className="text-sm tracking-[0.4em] text-[#CFB383]/60">JARVIS</span>
    </div>
  ),
});

export function CosmosClient() {
  return <Scene />;
}
