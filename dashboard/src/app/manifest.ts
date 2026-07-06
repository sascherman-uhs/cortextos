// === JARVIS MOD #25 — PWA web app manifest (2026-07-05) ===
// New file. Next 16 metadata route → served at /manifest.webmanifest, and Next
// auto-injects <link rel="manifest"> into every page's <head>. This makes the
// dashboard installable as the "JARVIS" standalone app that opens straight into
// the full-screen voice route. Palette: UHS charcoal #2D2928 / gold #CFB383.
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'JARVIS',
    short_name: 'JARVIS',
    description: 'Voice-first operations intelligence for Utopia Home Staging',
    start_url: '/jarvis',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#2D2928',
    theme_color: '#2D2928',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
    ],
  };
}
// === END JARVIS MOD #25 ===
