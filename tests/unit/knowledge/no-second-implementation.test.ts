import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

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
      expect(src).toMatch(/knowledge\/contract/);
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
