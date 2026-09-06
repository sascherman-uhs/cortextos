import { describe, it, expect } from 'vitest';
import {
  POLICY,
  resolvePermittedCollections,
  isRestrictedSource,
  retrieve,
  contentHash,
  type RetrievalCaller,
} from '../../../src/knowledge/contract';

/**
 * The live UHS store as observed on 2026-09-05. `uhs` is the collection that
 * holds every ingested vault document; the CLI could never reach it and the
 * dashboard reached everything including the three private persona collections.
 */
const LIVE_COLLECTIONS = ['agent-tron', 'shared-uhs', 'agent-trillion-coder', 'uhs', 'agent-kimi'];

const operator: RetrievalCaller = { surface: 'cli', role: 'operator', org: 'uhs' };
const tron: RetrievalCaller = { surface: 'agent', role: 'agent', org: 'uhs', agent: 'tron' };
const service: RetrievalCaller = { surface: 'skill', role: 'service', org: 'uhs' };
const anon: RetrievalCaller = { surface: 'dashboard', role: 'anonymous', org: 'uhs' };

describe('collection resolution — the CLI/dashboard divergence', () => {
  it('reaches the uhs business collection, which the old CLI list could never contain', () => {
    const { granted } = resolvePermittedCollections(operator, 'all', LIVE_COLLECTIONS);
    expect(granted.map((g) => g.name)).toContain('uhs');
  });

  it('gives the CLI surface and the dashboard surface the same collections', () => {
    const cli = resolvePermittedCollections(
      { surface: 'cli', role: 'operator', org: 'uhs' }, 'all', LIVE_COLLECTIONS,
    );
    const dashboard = resolvePermittedCollections(
      { surface: 'dashboard', role: 'operator', org: 'uhs' }, 'all', LIVE_COLLECTIONS,
    );
    expect(cli.granted.map((g) => g.name).sort()).toEqual(dashboard.granted.map((g) => g.name).sort());
  });

  it('federates uhs and shared-uhs for any org-granted role', () => {
    for (const caller of [operator, tron, service]) {
      const { granted } = resolvePermittedCollections(caller, 'all', LIVE_COLLECTIONS);
      expect(granted.map((g) => g.name)).toEqual(expect.arrayContaining(['uhs', 'shared-uhs']));
    }
  });
});

describe("scope 'all' means 'all I am permitted to see'", () => {
  it('never hands an agent another persona\'s private collection', () => {
    const { granted, denied } = resolvePermittedCollections(tron, 'all', LIVE_COLLECTIONS);
    const names = granted.map((g) => g.name);
    expect(names).toContain('agent-tron');
    expect(names).not.toContain('agent-kimi');
    expect(names).not.toContain('agent-trillion-coder');
    expect(denied.find((d) => d.name === 'agent-kimi')?.reason)
      .toMatch(/may not read another persona/);
  });

  it('gives an unattended service no persona collection at all', () => {
    const { granted } = resolvePermittedCollections(service, 'all', LIVE_COLLECTIONS);
    expect(granted.every((g) => g.kind === 'org')).toBe(true);
  });

  it('gives an anonymous caller nothing', () => {
    const { granted } = resolvePermittedCollections(anon, 'all', LIVE_COLLECTIONS);
    expect(granted).toEqual([]);
  });

  it('lets an operator see persona collections, because that is Scott', () => {
    const { granted } = resolvePermittedCollections(operator, 'all', LIVE_COLLECTIONS);
    expect(granted.map((g) => g.name).sort()).toEqual(LIVE_COLLECTIONS.slice().sort());
  });

  it('never searches an undeclared collection that merely exists on disk', () => {
    const { granted, denied } = resolvePermittedCollections(
      operator, 'all', [...LIVE_COLLECTIONS, 'stray-scratch-collection'],
    );
    expect(granted.map((g) => g.name)).not.toContain('stray-scratch-collection');
    expect(denied.find((d) => d.name === 'stray-scratch-collection')?.reason)
      .toMatch(/undeclared collection/);
  });

  it('reports a policy collection that is absent from the store rather than searching it', () => {
    const { denied } = resolvePermittedCollections(operator, 'all', ['uhs']);
    expect(denied.find((d) => d.name === 'shared-uhs')?.reason).toMatch(/not present in the store/);
  });
});

describe('scope narrows, never widens', () => {
  it("scope 'shared' drops persona collections even for the operator", () => {
    const { granted } = resolvePermittedCollections(operator, 'shared', LIVE_COLLECTIONS);
    expect(granted.every((g) => g.kind === 'org')).toBe(true);
  });

  it("scope 'private' cannot give a service role a persona collection", () => {
    const { granted } = resolvePermittedCollections(service, 'private', LIVE_COLLECTIONS);
    expect(granted).toEqual([]);
  });
});

describe('restricted document scope', () => {
  it('flags personal, HR, insurance and legal-template sources', () => {
    expect(isRestrictedSource('/x/uhsJARVIS/vault/personal/recipes/salmon.pdf')).toBeTruthy();
    expect(isRestrictedSource('/x/uhsJARVIS/vault/business/insurance/COI.pdf')).toBeTruthy();
    expect(isRestrictedSource('/x/uhsJARVIS/vault/team/angelic-ferguson.md')).toBeTruthy();
    expect(isRestrictedSource('/x/orgs/uhs/secrets.env')).toBeTruthy();
  });

  it('does not flag ordinary business knowledge', () => {
    expect(isRestrictedSource('/x/uhsJARVIS/vault/business/uhs-vehicle-fleet.md')).toBeNull();
    expect(isRestrictedSource('/x/uhsJARVIS/vault/learnings/lessons.md')).toBeNull();
  });

  it('withholds restricted documents from a non-operator and says how many', () => {
    const response = retrieve({
      question: 'insurance certificate',
      caller: tron,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [
          { source: '/v/uhsJARVIS/vault/business/insurance/COI.pdf', content: 'policy number', similarity: 0.9 },
          { source: '/v/uhsJARVIS/vault/business/pricing.md', content: 'service pricing', similarity: 0.8 },
        ],
      },
    });
    expect(response.restrictedWithheld).toBe(1);
    expect(response.results).toHaveLength(1);
    expect(response.results[0].citation.canonicalSource).toMatch(/pricing\.md$/);
  });
});

describe('dedupe by canonical source + content hash', () => {
  it('collapses the same document held in two collections into one citation', () => {
    const response = retrieve({
      question: 'staging service period',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs', 'shared-uhs'],
        query: (collection) => [{
          source: '/v/uhsJARVIS/vault/business/terms.md',
          content: 'The service period runs 30 days.',
          // Both above the policy's empirical semantic floor (0.72), so the
          // duplicate is a real duplicate rather than one hit and one reject.
          similarity: collection === 'uhs' ? 0.9 : 0.85,
        }],
      },
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0].citation.duplicateCollections.length).toBe(1);
  });

  it('hashes on normalized content so whitespace drift is not a new document', () => {
    expect(contentHash('The  service   period')).toBe(contentHash('the service period'));
  });
});

describe('layer order and uncertainty', () => {
  it('consults layers in policy order', () => {
    const response = retrieve({
      question: 'what is the listing agent for this property address',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      transport: { listCollections: () => [], query: () => [] },
    });
    expect(response.layersConsulted).toEqual(['registry', 'structured', 'documents', 'semantic']);
  });

  it('routes an agent-or-owner question to the authoritative record, not to prose', () => {
    const response = retrieve({
      question: 'who is the owner of this property',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['structured'],
      transport: { listCollections: () => [], query: () => [] },
    });
    const ids = response.results.map((r) => r.citation.canonicalSource);
    expect(ids).toContain('supabase:assessor.owner');
    expect(response.results.find((r) => r.citation.canonicalSource === 'supabase:assessor.owner')!.content)
      .toMatch(/Owner is NOT the listing agent/);
  });

  it('states uncertainty explicitly instead of returning a confident nothing', () => {
    const response = retrieve({
      question: 'zzz nonexistent subject zzz',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: { listCollections: () => ['uhs'], query: () => [] },
    });
    expect(response.total).toBe(0);
    expect(response.uncertainty).toMatch(/No source was found/);
    expect(response.uncertainty).toMatch(/Say the answer is unavailable/);
  });

  it('short-circuits an anonymous caller before touching the store', () => {
    let touched = false;
    const response = retrieve({
      question: 'anything',
      caller: anon,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      transport: { listCollections: () => { touched = true; return ['uhs']; }, query: () => [] },
    });
    expect(touched).toBe(false);
    expect(response.uncertainty).toMatch(/unauthenticated/);
  });
});

describe('retired guidance', () => {
  it('flags GoHighLevel material and names the successor', () => {
    const response = retrieve({
      question: 'how do I look up an existing client in the crm',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [{
          source: '/v/uhsJARVIS/vault/business/old-crm-guide.md',
          content: 'Look the client up in GoHighLevel under Contacts.',
          similarity: 0.88,
        }],
      },
    });
    expect(response.retiredGuidance).toHaveLength(1);
    expect(response.retiredGuidance[0].retired.successor).toBe('uhs_projects');
    expect(response.uncertainty).toMatch(/retired/i);
  });
});

describe('policy shape', () => {
  it('declares exactly four ordered layers', () => {
    expect(POLICY.layers.map((l) => l.id)).toEqual(['registry', 'structured', 'documents', 'semantic']);
  });

  it('never grants an anonymous role anything', () => {
    const anonGrants = POLICY.authorization.roles.anonymous;
    expect(Object.values(anonGrants).some((v) => v === true)).toBe(false);
  });
});


/**
 * Relevance floors and reserved authoritative slots.
 *
 * Every assertion below was written after the JARVIS acceptance corpus caught
 * the behaviour it pins. They are regressions waiting to happen, not
 * hypotheticals.
 */
describe('relevance floors', () => {
  it('returns nothing, and says so, for a question with no answer', () => {
    // Gemini Embedding 2 scores unrelated UHS content at ~0.70 against any
    // question, so at the old 0.5 threshold "the UHS policy on submarine
    // leasing in Antarctica" came back with six confident citations.
    const response = retrieve({
      question: 'What is the UHS policy on submarine leasing in Antarctica?',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [
          { source: '/j/vault/business/warehouse.md', content: '3100 Sirius Ave', similarity: 0.702 },
          { source: '/j/memory/MEMORY.md', content: 'index', similarity: 0.701 },
        ],
      },
    });
    expect(response.total).toBe(0);
    expect(response.uncertainty).toMatch(/No source was found/);
  });

  it('still admits a genuinely correct match', () => {
    const response = retrieve({
      question: 'GoHighLevel retirement',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [{
          source: '/j/memory/feedback_gohighlevel_retired.md',
          content: 'GoHighLevel CRM retired 2026-07-06.', similarity: 0.816,
        }],
      },
    });
    expect(response.total).toBe(1);
  });
});

describe('reserved slots for the authoritative layers', () => {
  it('keeps an authoritative pointer that prose about it would outrank', () => {
    // The Assessor pointer scores 0.50 as a keyword match; a memory note about
    // it scores 0.76 as a semantic match. Ranking alone dropped the source.
    const response = retrieve({
      question: 'Who is the owner of a listed property and who is the listing agent?',
      caller: operator, topK: 3,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['structured', 'semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [
          { source: '/j/memory/feedback_agent_vs_owner.md', content: 'Agent is not owner.', similarity: 0.764 },
          { source: '/j/memory/reference_uhsmls_query.md', content: 'Query notes.', similarity: 0.75 },
        ],
      },
    });
    const sources = response.results.map((r) => r.citation.canonicalSource);
    expect(sources).toContain('supabase:assessor.owner');
    expect(sources).toContain('supabase:uhsmls.agents');
  });

  it('does not let the reserved slots crowd out the semantic answer', () => {
    const response = retrieve({
      question: 'Who is the owner of a listed property and who is the listing agent?',
      caller: operator, topK: 6,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['structured', 'semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => Array.from({ length: 6 }, (_, i) => ({
          source: `/j/memory/note${i}.md`, content: `note ${i}`, similarity: 0.8 - i * 0.01,
        })),
      },
    });
    expect(response.results.some((r) => r.citation.layer === 'semantic')).toBe(true);
  });
});

describe('conflicts are surfaced on the answer, not reconciled', () => {
  it('reports two retrieved sources disagreeing about the CRM of record', () => {
    const response = retrieve({
      question: 'where do I look up an existing client',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [
          { source: '/j/vault/old-crm-guide.md', content: 'Look the client up in GoHighLevel.', similarity: 0.82 },
          { source: '/j/CLAUDE.md', content: 'Client lookup uses Supabase uhs_projects and project_contacts.', similarity: 0.81 },
        ],
      },
    });
    const crm = response.conflicts.find((c) => c.claim === 'client CRM system of record');
    expect(crm).toBeDefined();
    expect(crm!.sources).toHaveLength(2);
  });

  it('does not invent a conflict when every source agrees', () => {
    const response = retrieve({
      question: 'where do I look up an existing client',
      caller: operator,
      store: { frameworkRoot: '/nonexistent', instanceId: 'test', org: 'uhs' },
      layers: ['semantic'],
      transport: {
        listCollections: () => ['uhs'],
        query: () => [
          { source: '/j/a.md', content: 'Client lookup uses Supabase uhs_projects.', similarity: 0.82 },
          { source: '/j/b.md', content: 'project_contacts holds the contacts.', similarity: 0.81 },
        ],
      },
    });
    expect(response.conflicts.find((c) => c.claim === 'client CRM system of record')).toBeUndefined();
  });
});
