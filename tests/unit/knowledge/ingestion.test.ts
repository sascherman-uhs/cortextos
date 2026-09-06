import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  emptyLedger, markDiscovered, markIndexed, markVerified, markFailed,
  retryInbox, unverified, lagging, classifyIngestionError, isAutoRetryable,
  buildProbe, verifyRetrievable, detectConflicts, loadLedger, saveLedger,
} from '../../../src/knowledge/ingestion';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'os06-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('ingestion state machine', () => {
  it('walks discovered → indexed → retrieval_verified', () => {
    const l = emptyLedger();
    const p = write('a.md', 'The Cabo trip blocks both principals December 18 to 28 2026.');
    expect(markDiscovered(l, p, 'uhs').state).toBe('discovered');
    expect(markIndexed(l, p, 3)!.state).toBe('indexed');
    expect(markVerified(l, p)!.state).toBe('retrieval_verified');
  });

  it('refuses to promote a document that was never indexed', () => {
    const l = emptyLedger();
    const p = write('a.md', 'content');
    markDiscovered(l, p, 'uhs');
    expect(markVerified(l, p)!.state).toBe('discovered');
  });

  it('is idempotent: re-discovering unchanged content does no work', () => {
    const l = emptyLedger();
    const p = write('a.md', 'stable content');
    markDiscovered(l, p, 'uhs');
    markIndexed(l, p, 1);
    markVerified(l, p);
    const again = markDiscovered(l, p, 'uhs');
    expect(again.state).toBe('retrieval_verified');
    expect(again.attempts).toBe(1);
  });

  it('demotes a verified document when its content hash changes', () => {
    const l = emptyLedger();
    const p = write('a.md', 'original');
    markDiscovered(l, p, 'uhs');
    markIndexed(l, p, 1);
    markVerified(l, p);
    writeFileSync(p, 'edited after indexing');
    const r = markDiscovered(l, p, 'uhs');
    expect(r.state).toBe('discovered');
    expect(r.supersededHash).toBeTruthy();
    expect(r.verifiedAt).toBeNull();
  });
});

describe('failed inputs stay retryable and are never archived as success', () => {
  it('keeps a failed record in the inbox with its classified error', () => {
    const l = emptyLedger();
    const p = write('a.pdf', 'x');
    markFailed(l, p, 'uhs', 'transient_api', '503 Service Unavailable from generate_content');
    expect(l.records[p].state).toBe('failed');
    expect(retryInbox(l).map((r) => r.sourceId)).toContain(p);
  });

  it('never reports a failed input as indexed or verified', () => {
    const l = emptyLedger();
    const p = write('a.pdf', 'x');
    markFailed(l, p, 'uhs', 'quota', '429 rate limit');
    expect(unverified(l)).toHaveLength(0);
    expect(Object.values(l.records).filter((r) => r.state === 'retrieval_verified')).toHaveLength(0);
  });

  it('classifies the error shapes the nightly sync actually produces', () => {
    expect(classifyIngestionError('429 RESOURCE_EXHAUSTED quota')).toBe('quota');
    expect(classifyIngestionError('503 UNAVAILABLE: model overloaded')).toBe('transient_api');
    expect(classifyIngestionError('ETIMEDOUT after 600000ms')).toBe('timeout');
    expect(classifyIngestionError('SKIP (too large: 120MB)')).toBe('too_large');
    expect(classifyIngestionError('failed to extract docx: corrupt zip')).toBe('extraction_failed');
    expect(classifyIngestionError('something nobody has seen')).toBe('unknown');
  });

  it('auto-retries transient classes and holds the rest for a decision', () => {
    expect(isAutoRetryable('transient_api')).toBe(true);
    expect(isAutoRetryable('quota')).toBe(true);
    expect(isAutoRetryable('unsupported_format')).toBe(false);
    expect(isAutoRetryable('too_large')).toBe(false);
  });
});

describe('lag', () => {
  it('surfaces a source that changed long after it was indexed', () => {
    const l = emptyLedger();
    const p = write('a.md', 'v1');
    markDiscovered(l, p, 'uhs');
    markIndexed(l, p, 1);
    l.records[p].indexedAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
    const future = new Date(Date.now() - 1000 * 60 * 60 * 2);
    utimesSync(p, future, future);
    const lags = lagging(l);
    expect(lags).toHaveLength(1);
    expect(lags[0].severity).toBe('fail');
  });
});

describe('retrieval verification — because "indexed" has been lying', () => {
  it('picks a distinctive probe rather than a heading', () => {
    const probe = buildProbe('# Title\n\n- item\n\nThe Utopia Circle loyalty program launches after three binding gates close.\n');
    expect(probe).toMatch(/Utopia Circle loyalty program/);
  });

  it('passes when the document retrieves itself', () => {
    const p = write('a.md', 'The Utopia Circle loyalty program launches after three binding gates close.');
    const out = verifyRetrievable(p, 'uhs', () => [{ source: p, content: 'x', similarity: 0.93 }]);
    expect(out.retrievable).toBe(true);
    expect(out.citationResolved).toBe(true);
  });

  it('fails an indexed document that its own text cannot retrieve', () => {
    const p = write('a.md', 'The Utopia Circle loyalty program launches after three binding gates close.');
    const out = verifyRetrievable(p, 'uhs', () => []);
    expect(out.retrievable).toBe(false);
    expect(out.reason).toMatch(/indexed but not retrievable/);
  });

  it('fails when the citation resolves to a different source', () => {
    const p = write('a.md', 'The Utopia Circle loyalty program launches after three binding gates close.');
    const out = verifyRetrievable(p, 'uhs', () => [
      { source: join(dir, 'other.md'), content: 'x', similarity: 0.9 },
    ]);
    expect(out.citationResolved).toBe(false);
    expect(out.reason).toMatch(/citation does not resolve/);
  });
});

describe('conflicts are surfaced, not resolved', () => {
  it('reports two sources disagreeing about the CRM of record', () => {
    const conflicts = detectConflicts([
      { sourceId: 'old-guide.md', content: 'Look the client up in GoHighLevel.' },
      { sourceId: 'claude.md', content: 'Client lookup uses Supabase uhs_projects and project_contacts.' },
    ]);
    const crm = conflicts.find((c) => c.claim === 'client CRM system of record');
    expect(crm).toBeDefined();
    expect(crm!.sources).toHaveLength(2);
  });

  it('does not invent a conflict when every source agrees', () => {
    const conflicts = detectConflicts([
      { sourceId: 'a.md', content: 'Client lookup uses Supabase uhs_projects.' },
      { sourceId: 'b.md', content: 'project_contacts holds the contacts.' },
    ]);
    expect(conflicts.find((c) => c.claim === 'client CRM system of record')).toBeUndefined();
  });
});

describe('ledger persistence', () => {
  it('round-trips and preserves a corrupt ledger instead of erasing it', () => {
    const path = join(dir, 'ledger.json');
    const l = emptyLedger();
    const p = write('a.md', 'x');
    markDiscovered(l, p, 'uhs');
    saveLedger(path, l);
    expect(Object.keys(loadLedger(path).records)).toContain(p);

    writeFileSync(path, '{ not json');
    const recovered = loadLedger(path);
    expect(recovered.records).toEqual({});
  });
});
