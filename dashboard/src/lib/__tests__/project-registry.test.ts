/**
 * OS-05 — project registry reader tests.
 *
 * The Projects surface is only as honest as these rules: a registry that cannot
 * be read must not look like an empty portfolio, a coverage claim must come
 * from the registry rather than from the absence of visible exceptions, and an
 * unknown owner must never render as a blank.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readRegistry,
  coverageSummary,
  groupByClassification,
  ownerLabel,
  isSoftwareProject,
  type ProjectRegistry,
  type RegistryProject,
} from '@/lib/project-registry';

function project(over: Partial<RegistryProject> = {}): RegistryProject {
  return {
    id: 'p',
    aliases: [],
    classification: 'active',
    classification_reason: 'because',
    reviewer: 'test',
    review_date: '2026-09-05',
    purpose: 'does a thing',
    business_outcome: 'an outcome',
    lifecycle: 'production',
    owner_human: 'Scott Ascherman',
    owner_agent_role: 'Delivery Ops',
    stack: ['Next.js'],
    repo: null,
    workspace: '/tmp/p',
    deployment: {},
    datastores: [],
    depends_on: [],
    commands: {},
    docs_roots: [],
    active_plan: null,
    backlog_links: [],
    permissions: null,
    operational_risks: [],
    plan_row: null,
    health: { status: 'ok', notes: [] },
    observed: {
      path: '/tmp/p',
      is_git: true,
      branch: 'main',
      last_verified_change: {},
      runtime: [],
      supabase_project_refs: [],
      package_scripts: {},
      discovery_root: 'Collective/',
    },
    ...over,
  };
}

function registry(over: Partial<ProjectRegistry> = {}): ProjectRegistry {
  return {
    inventory_release: 'portfolio-v1',
    built_at: '2026-09-05 00:00:00',
    complete: true,
    completeness_blockers: [],
    counts_by_classification: { active: 1 },
    project_count: 1,
    projects: [project()],
    coverage_exceptions: [],
    remediation_items: [],
    non_candidate_directories: [],
    ...over,
  };
}

describe('readRegistry', () => {
  it('reports a missing registry as an error, not as an empty portfolio', () => {
    const result = readRegistry(path.join(os.tmpdir(), 'definitely-not-here-os05.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/has not been built/);
      expect(result.error).toMatch(/project_registry\.py/);
    }
  });

  it('reports unparseable content as an error rather than swallowing it', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'os05-')), 'bad.json');
    fs.writeFileSync(f, '{ this is not json');
    const result = readRegistry(f);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be read/);
  });

  it('reads a real registry payload', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'os05-')), 'projects-v1.json');
    fs.writeFileSync(f, JSON.stringify(registry()));
    const result = readRegistry(f);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry.inventory_release).toBe('portfolio-v1');
      expect(result.registry.projects).toHaveLength(1);
    }
  });
});

describe('coverageSummary', () => {
  it('takes the completeness claim from the registry, never from an empty exception list', () => {
    const reg = registry({ complete: false, completeness_blockers: ['1 coverage exception'] });
    const summary = coverageSummary(reg);
    expect(summary.claimsComplete).toBe(false);
    expect(summary.blockers).toEqual(['1 coverage exception']);
    expect(summary.exceptionCount).toBe(0);
  });

  it('surfaces exceptions when the registry carries them', () => {
    const reg = registry({
      complete: false,
      completeness_blockers: ['1 coverage exception(s) unresolved'],
      coverage_exceptions: [
        { kind: 'unclassified_candidate', id: 'projB', path: '/tmp/projB', detail: 'nobody classified it' },
      ],
    });
    expect(coverageSummary(reg).exceptionCount).toBe(1);
  });
});

describe('project presentation rules', () => {
  it('never renders an unknown owner as a blank', () => {
    const label = ownerLabel(project({ owner_human: null }));
    expect(label.unknown).toBe(true);
    expect(label.text.length).toBeGreaterThan(0);
  });

  it('distinguishes a document workspace from a software project', () => {
    expect(isSoftwareProject(project())).toBe(true);
    expect(
      isSoftwareProject(project({ stack: ['Markdown workspace — NOT a web application'] })),
    ).toBe(false);
  });

  it('groups projects by classification for the filter chips', () => {
    const grouped = groupByClassification([
      project({ id: 'a', classification: 'active' }),
      project({ id: 'b', classification: 'archived' }),
      project({ id: 'c', classification: 'active' }),
    ]);
    expect(grouped.active.map((p) => p.id)).toEqual(['a', 'c']);
    expect(grouped.archived.map((p) => p.id)).toEqual(['b']);
  });
});
