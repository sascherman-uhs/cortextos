import type { NextConfig } from "next";
import { execSync } from "node:child_process";

function buildSha() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown"; }
}

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Pin the workspace root to this directory. Without it, Turbopack infers the
  // root from the nearest lockfile and picks the parent monorepo
  // (~/cortextos/package-lock.json) instead of the dashboard, emitting a
  // "multiple lockfiles" warning on every dev start.
  turbopack: { root: __dirname },
  // === JARVIS MOD #107 ROUND 4 — Turbopack dev crash-loop (2026-08-09) ========
  // dash-cortexos was crash-looping (PM2 restart #29) on a Rust panic from
  // turbo-tasks-backend/src/backend/operation/mod.rs:966 — "Every task must have
  // a task type". The panic payload names the cause: `meta_restored: true,
  // data_restored: true` with `persistent_task_type: None`, i.e. it is dying
  // while RESTORING tasks from Turbopack's persistent dev cache, not while
  // compiling. A task graph serialized by one Turbopack version, deserialized by
  // another, holds TaskIds that no longer exist — a known Next 16 issue with
  // `turbopackFileSystemCacheForDev` (default true). See
  // github.com/vercel/next.js/discussions/87283 and /90691.
  //
  // Because the cache lives in .next and SURVIVES a restart, PM2 restarting the
  // process just re-read the same corrupt graph and panicked again — that is the
  // loop. Wiping .next fixes the current instance; turning the dev filesystem
  // cache OFF is what stops it recurring on the next Next.js upgrade.
  //
  // Trade accepted deliberately: cold dev starts recompile from scratch (a few
  // extra seconds). This box runs ONE long-lived dev server that Scott uses
  // live; a slower start beats a server that dies mid-session. Revisit if/when
  // the restore path is fixed upstream. The alternative — pinning dev to
  // `next dev --webpack` — is a much larger behavioural change, and the build
  // logs already show serwist friction with that combination.
  experimental: { turbopackFileSystemCacheForDev: false },
  env: {
    NEXT_PUBLIC_BUILD_SHA: buildSha(),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  },
  serverExternalPackages: ['better-sqlite3'],
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
