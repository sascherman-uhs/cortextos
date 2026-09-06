/**
 * Fix6 / D6 — a task with no organization is refused, not misfiled.
 *
 * Reproduced: `cortextos bus create-task "…"` with CTX_ORG unset printed a
 * task id and wrote the file to `~/.cortextos/<instance>/tasks/`. Dashboard
 * sync walks `<instance>/orgs/<org>/tasks/` and nothing else, so the task
 * reached no board, no projection and no agent. The caller had every reason to
 * believe it existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { requireOrgForOrgScopedWrite, listOrgNames } from '../../../src/utils/org';

describe('requireOrgForOrgScopedWrite', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-fix6-org-'));
    mkdirSync(join(root, 'orgs', 'uhs'), { recursive: true });
    mkdirSync(join(root, 'orgs', 'acme'), { recursive: true });
    // A stray file and a dotfile must not be mistaken for organizations.
    writeFileSync(join(root, 'orgs', 'README.md'), 'not an org');
    mkdirSync(join(root, 'orgs', '.hidden'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts an explicit org', () => {
    expect(requireOrgForOrgScopedWrite('uhs', root)).toEqual({ ok: true, org: 'uhs' });
  });

  it('trims an org that arrived with whitespace rather than treating it as absent', () => {
    expect(requireOrgForOrgScopedWrite('  uhs  ', root)).toEqual({ ok: true, org: 'uhs' });
  });

  it('reads as English for both kinds rather than "a approval"', () => {
    const task = requireOrgForOrgScopedWrite(undefined, root, 'task');
    const approval = requireOrgForOrgScopedWrite(undefined, root, 'approval');
    expect(task.ok === false && task.message).toContain('create a task');
    expect(approval.ok === false && approval.message).toContain('create an approval');
  });

  it('refuses an absent or blank org', () => {
    for (const value of [undefined, '', '   ']) {
      const out = requireOrgForOrgScopedWrite(value, root);
      expect(out.ok).toBe(false);
    }
  });

  it('says where the task would have gone and why that is useless', () => {
    const out = requireOrgForOrgScopedWrite(undefined, root);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/nothing reads it/);
    expect(out.message).toMatch(/--org/);
  });

  it('names the organizations that would have worked', () => {
    const out = requireOrgForOrgScopedWrite(undefined, root);
    expect(out.ok === false && out.message).toContain('acme, uhs');
  });

  it('names the right reader for an approval, which nothing else would catch', () => {
    const out = requireOrgForOrgScopedWrite(undefined, root, 'approval');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/Refusing to create an approval with no organization/);
    expect(out.message).toMatch(/not any human/);
  });

  it('does not claim there are no organizations when it simply cannot look', () => {
    const out = requireOrgForOrgScopedWrite(undefined, join(root, 'nowhere'));
    expect(out.ok === false && out.message).not.toMatch(/Organizations here/);
  });
});

describe('listOrgNames', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-fix6-list-'));
    mkdirSync(join(root, 'orgs', 'uhs'), { recursive: true });
    writeFileSync(join(root, 'orgs', 'notes.txt'), 'x');
    mkdirSync(join(root, 'orgs', '.git'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists directories only, skipping files and dotfiles', () => {
    expect(listOrgNames(root)).toEqual(['uhs']);
  });

  it('returns an empty list rather than throwing when there is no orgs dir', () => {
    expect(listOrgNames(join(root, 'missing'))).toEqual([]);
  });
});
