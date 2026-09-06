import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error - plain ESM helper, no types
import { MIRRORED_FILES, render, targetPath } from '../../../dashboard/src/app/api/kb/_contract/sync.mjs';

/**
 * The OS-06 regression guard.
 *
 * The CLI/dashboard divergence was not a bug in either file — it was the fact
 * that BOTH files independently answered "which collections do I search?".
 * Fixing the answers would not stop it recurring; removing the second
 * implementation does.
 *
 * These tests fail if either caller starts deciding for itself again.
 */

const ROOT = join(__dirname, '..', '..', '..');
const CLI = join(ROOT, 'src', 'bus', 'knowledge-base.ts');
const DASHBOARD = join(ROOT, 'dashboard', 'src', 'app', 'api', 'kb', 'search', 'route.ts');

function read(p: string): string {
  return readFileSync(p, 'utf-8');
}

/** Comments may discuss the old behaviour; only code counts. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('there is exactly one implementation of collection selection', () => {
  for (const [label, path] of [['fleet CLI', CLI], ['dashboard API', DASHBOARD]] as const) {
    it(`${label} does not enumerate collections itself`, () => {
      const src = code(read(path));
      expect(src).not.toMatch(/['"`]collections['"`]\s*\]/);
      expect(src).not.toMatch(/mmrag.*collections/i);
    });

    it(`${label} does not build an agent collection name`, () => {
      const src = code(read(path));
      expect(src).not.toMatch(/agent-\$\{/);
      expect(src).not.toMatch(/`agent-/);
    });

    it(`${label} delegates to the shared contract`, () => {
      const src = code(read(path));
      expect(src).toMatch(/knowledge\/contract|_contract\/contract/);
      expect(src).toMatch(/\bretrieve\(/);
    });
  }

  it('the CLI no longer switches on scope to build a collection list', () => {
    const src = code(read(CLI));
    expect(src).not.toMatch(/switch\s*\(\s*scope\s*\)/);
  });

  it('the dashboard no longer treats scope=all as "every collection on disk"', () => {
    const src = code(read(DASHBOARD));
    expect(src).not.toMatch(/listCollections/);
    expect(src).not.toMatch(/knownCollections/);
  });
});

describe('authorization is decided on the server, from the session', () => {
  it('the dashboard route establishes a role ceiling from the session', () => {
    const src = read(DASHBOARD);
    expect(src).toMatch(/const session = await auth\(\)/);
    expect(src).toMatch(/ceiling/);
    // A query-string role may only narrow.
    expect(src).toMatch(/narrowing/);
  });

  it('the CLI defaults a process running as an agent to the agent role', () => {
    const src = read(CLI);
    expect(src).toMatch(/process\.env\.CTX_AGENT_NAME \? 'agent' : 'operator'/);
  });
});


/**
 * The dashboard cannot import `src/knowledge/contract.ts` directly: Turbopack's
 * project root is pinned to `dashboard/`, and the production build fails on any
 * relative import above it. The contract is therefore MIRRORED into
 * `dashboard/src/app/api/kb/_contract/` by a generator.
 *
 * A mirror is only safe if it cannot drift. These tests regenerate it from the
 * canonical source and fail on any difference, so editing the copy — or editing
 * the original and forgetting the copy — breaks the build rather than quietly
 * producing two contracts, which is the failure this whole package exists to
 * remove.
 */
describe('the dashboard mirror is generated, never authored', () => {
  for (const name of MIRRORED_FILES as string[]) {
    it(`${name} matches the canonical src/knowledge copy`, () => {
      const expected = render(name) as string;
      const actual = readFileSync(targetPath(name) as string, 'utf-8');
      expect(actual).toBe(expected);
    });
  }

  it('marks every mirrored TypeScript file as generated', () => {
    for (const name of MIRRORED_FILES as string[]) {
      if (!name.endsWith('.ts')) continue;
      expect(readFileSync(targetPath(name) as string, 'utf-8'))
        .toMatch(/^\/\/ GENERATED FILE — DO NOT EDIT\./);
    }
  });

  it('mirrors the policy byte-for-byte, so both copies resolve the same collections', () => {
    const canonical = readFileSync(
      join(ROOT, 'src', 'knowledge', 'retrieval-policy.json'), 'utf-8');
    const mirrored = readFileSync(targetPath('retrieval-policy.json') as string, 'utf-8');
    expect(mirrored).toBe(canonical);
  });
});
