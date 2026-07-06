import type { Metadata, Viewport } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { CosmosClient } from './cosmos-client';

// === JARVIS MOD #25 — PWA metadata for the standalone voice route (2026-07-05) ===
// Route-level overrides merged over the root layout: apple standalone chrome,
// black-translucent status bar (the orb fills behind the notch), charcoal theme
// color, and viewport-fit=cover so env(safe-area-inset-*) has real values on a
// notched iPhone. Desktop is unaffected — these only change mobile/standalone chrome.
export const metadata: Metadata = {
  title: 'JARVIS',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'JARVIS',
  },
  icons: { apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#2D2928',
};
// === END JARVIS MOD #25 ===

// Full-screen immersive Cosmos route. Lives OUTSIDE the (dashboard) route
// group so it does not inherit DashboardShell — but replicates the same
// session guard the DashboardLayout enforces.
export default async function JarvisCosmosPage() {
  const session = await auth();
  // === JARVIS MOD #25: carry callbackUrl so a PWA cold-start that hits /login
  // returns to /jarvis after sign-in (instead of dropping onto the dashboard home).
  if (!session) redirect('/login?callbackUrl=/jarvis');
  // === END JARVIS MOD #25 ===

  return (
    <main className="h-screen w-screen overflow-hidden">
      <CosmosClient />
    </main>
  );
}
