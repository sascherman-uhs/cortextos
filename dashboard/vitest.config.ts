// === JARVIS MOD #107 — dashboard-local vitest config (2026-08-09) ===
// NEW FILE. Without it, `npx vitest run` from dashboard/ found ZERO tests and
// exited successfully — the worst possible failure mode for a test runner,
// because a green "no tests" is indistinguishable at a glance from a green
// "everything passed". The suite only ran through the package script
// (`npm test` → `vitest run --root .. dashboard/src`), so anyone reaching for
// the obvious command got a false all-clear.
//
// It extends the ROOT config rather than restating it, so the path aliases stay
// in exactly one place: '@' → dashboard/src and the next/server redirect into
// dashboard/node_modules (the root package has no Next dependency of its own).
// Only `include` is overridden, because include globs resolve against the
// config's own directory and the root's are written relative to the repo root.
//
// `npm test` remains the canonical command — it covers the root suite too.
import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../vitest.config';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['src/**/__tests__/**/*.test.ts'],
    },
  }),
);
