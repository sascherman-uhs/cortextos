#!/usr/bin/env node
/**
 * sync.mjs — mirror the canonical knowledge contract into the dashboard tree.
 *
 * Why a mirror exists at all
 * -------------------------
 * The contract is authored ONCE, in `src/knowledge/`. The dashboard cannot
 * import it from there, and it is not for want of trying:
 *
 *   - `dashboard/next.config.ts` pins `turbopack.root` to the dashboard
 *     directory (to stop Turbopack inferring the parent monorepo from the
 *     lockfile). A relative import above that root fails the production build
 *     with "Module not found: Can't resolve '../../../../../../src/knowledge/
 *     contract'" — verified, not assumed.
 *   - The reverse direction fails too: the root tsconfig pins `rootDir` to
 *     `src`, so `src/bus/knowledge-base.ts` importing a file under
 *     `dashboard/` is TS6059, "not under rootDir".
 *
 * Both pins belong to files this package does not own, so the contract is
 * mirrored instead of moved. The mirror is GENERATED, never edited, and
 * `tests/unit/knowledge/no-second-implementation.test.ts` regenerates it and
 * fails on any difference — so it cannot quietly become a second contract, the
 * same guard the JARVIS vendored policy uses.
 *
 * When either pin is relaxed (set `turbopack.root` to the repo root), delete
 * this directory and import `src/knowledge/contract` directly.
 *
 *     node dashboard/src/app/api/kb/_contract/sync.mjs [--check]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');
const SOURCE_DIR = join(ROOT, 'src', 'knowledge');

export const MIRRORED_FILES = ['contract.ts', 'ingestion.ts', 'retrieval-policy.json'];

const BANNER = (name) => `// GENERATED FILE — DO NOT EDIT.
// Mirrored from src/knowledge/${name} by dashboard/src/app/api/kb/_contract/sync.mjs.
// Edit the canonical file and re-run the sync; the drift test regenerates this
// and fails on any difference.
`;

export function render(name) {
  const body = readFileSync(join(SOURCE_DIR, name), 'utf-8');
  return name.endsWith('.json') ? body : BANNER(name) + body;
}

export function targetPath(name) {
  return join(HERE, name);
}

function main() {
  const check = process.argv.includes('--check');
  let drifted = [];
  for (const name of MIRRORED_FILES) {
    const expected = render(name);
    const target = targetPath(name);
    const actual = existsSync(target) ? readFileSync(target, 'utf-8') : null;
    if (actual === expected) continue;
    drifted.push(name);
    if (!check) writeFileSync(target, expected);
  }
  if (check && drifted.length > 0) {
    console.error(`knowledge contract mirror is stale: ${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log(check ? 'mirror is current' : `synced ${MIRRORED_FILES.length} file(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
