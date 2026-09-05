import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  loadContract,
  normaliseStatus,
  projectTask,
  resolveOwner,
  personDisplay,
} from '../task-projection';

// Must match CONTRACT_SHA256 in uhsJARVIS scripts/tests/test_task_projection.py.
// If either copy of the fixture is edited without the other, both suites fail.
const CONTRACT_SHA256 = '3120e314352e71a35a6b68480decfeb2526a0c795df64c04aeb5045acce870b6';
const FIXTURE_PATH = path.resolve(__dirname, '../../../../../tests/fixtures/task-status-contract.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

describe('shared contract fixture', () => {
  it('is the agreed bytes', () => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
    expect(digest).toBe(CONTRACT_SHA256);
  });

  it('the generated runtime contract matches the fixture rules', () => {
    // This is what makes "the Python and TypeScript projectors share a
    // contract" true even though the TS side embeds it at build time.
    const { cases, ...rules } = fixture;
    expect(cases.length).toBeGreaterThan(0);
    expect(loadContract()).toEqual(rules);
  });
});

describe('projectTask satisfies every contract case', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(projectTask(c.input)).toEqual(c.expect);
    });
  }
});

describe('status preservation', () => {
  it('never flattens blocked or failed to pending', () => {
    expect(normaliseStatus('blocked')).toBe('blocked');
    expect(normaliseStatus('failed')).toBe('failed');
  });

  it('passes an unrecognised status through instead of guessing', () => {
    expect(normaliseStatus('needs_triage')).toBe('needs_triage');
    expect(projectTask({ status: 'needs_triage' }).lane).toBe('waiting');
    expect(projectTask({ status: 'needs_triage' }).waiting_subtype).toBe('unclassified');
  });

  it('defaults only a genuinely absent status to pending', () => {
    expect(normaliseStatus(null)).toBe('pending');
    expect(normaliseStatus(undefined)).toBe('pending');
    expect(normaliseStatus('  ')).toBe('pending');
  });

  it('applies the recorded legacy map', () => {
    expect(normaliseStatus('duplicate')).toBe('cancelled');
    expect(normaliseStatus('archived')).toBe('cancelled');
  });
});

describe('identity resolution', () => {
  it('keeps the three people distinct', () => {
    expect(resolveOwner('scott').person).toBe('scott');
    expect(resolveOwner('ange').person).toBe('angelic');
    expect(resolveOwner('raquel lopez').person).toBe('raquel');
  });

  it('treats human and user as legacy aliases for Scott, flagged as such', () => {
    for (const alias of ['human', 'user', 'owner']) {
      const r = resolveOwner(alias);
      expect(r.person).toBe('scott');
      expect(r.legacy_alias).toBe(true);
    }
  });

  it('flags an ambiguous alias rather than assigning it to a person', () => {
    const r = resolveOwner('team');
    expect(r.person).toBeNull();
    expect(r.owner_kind).toBe('ambiguous');
  });

  it('calls an unrecognised name unknown, not an agent', () => {
    expect(resolveOwner('kimberly').owner_kind).toBe('unknown');
  });

  it('recognises agents by roster and by prefix', () => {
    expect(resolveOwner('jarvis').owner_kind).toBe('agent');
    expect(resolveOwner('jarvis-orchestrator').owner_kind).toBe('agent');
    expect(resolveOwner('vivienne').owner_kind).toBe('agent');
  });

  it('exposes display names', () => {
    expect(personDisplay('scott')).toBe('Scott Ascherman');
    expect(personDisplay(null)).toBeNull();
  });
});

describe('waiting subtypes', () => {
  it('routes a failed row to retry recovery', () => {
    expect(projectTask({ status: 'failed', assigned_to: 'jarvis' }).waiting_subtype).toBe('retry');
  });

  it('routes an approval-gated row to a human decision', () => {
    expect(
      projectTask({ status: 'blocked', assigned_to: 'jarvis', needs_approval: true }).waiting_subtype,
    ).toBe('human');
  });

  it('leaves an agent-owned block unclassified rather than inventing a reason', () => {
    expect(projectTask({ status: 'blocked', assigned_to: 'jarvis' }).waiting_subtype).toBe(
      'unclassified',
    );
  });
});
