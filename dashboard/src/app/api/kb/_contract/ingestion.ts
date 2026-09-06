// GENERATED FILE — DO NOT EDIT.
// Mirrored from src/knowledge/ingestion.ts by dashboard/src/app/api/kb/_contract/sync.mjs.
// Edit the canonical file and re-run the sync; the drift test regenerates this
// and fails on any difference.
/**
 * ingestion.ts — the ingestion state machine and retrieval verification.
 *
 * "Indexed" has been lying. On 2026-09-05 the JARVIS nightly sync printed
 * "Sync complete" with `Errors: 11` and moved on; the eleven per-file failures
 * were never written down, never retried, and nobody could name them the next
 * day. A document can also be present in ChromaDB and still be unreachable by
 * any realistic query, in which case an agent that "has" the knowledge answers
 * "I don't know".
 *
 * So ingestion here has three states and only the last one is evidence:
 *
 *   discovered  — the file exists and is in scope for a collection.
 *   indexed     — the store claims chunks were written for it. A CLAIM.
 *   retrieval_verified — the document was queried back by its own distinctive
 *                 content and the returned citation resolved to it. EVIDENCE.
 *
 * A failed input becomes `failed` with a classified error and STAYS in the
 * retryable inbox. It is never archived or moved as a success.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { IngestionErrorClass, IngestionState, RetrievalPolicy } from './contract';
import { POLICY } from './contract';

export interface IngestionRecord {
  /** Stable source id — the canonical absolute path. Idempotence key #1. */
  sourceId: string;
  /** sha256 of the file bytes. Idempotence key #2: same id + same hash = no work. */
  contentHash: string;
  collection: string;
  state: IngestionState;
  discoveredAt: string;
  indexedAt: string | null;
  verifiedAt: string | null;
  /** Chunks the store reported writing. */
  chunkCount: number | null;
  /** mtime of the source when the record was written. */
  sourceModifiedAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  error: { class: IngestionErrorClass; message: string; at: string } | null;
  /** Set when the file was seen after being indexed with a different hash. */
  supersededHash: string | null;
}

export interface IngestionLedger {
  version: 1;
  updatedAt: string;
  records: Record<string, IngestionRecord>;
}

export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function emptyLedger(): IngestionLedger {
  return { version: 1, updatedAt: new Date().toISOString(), records: {} };
}

export function loadLedger(path: string): IngestionLedger {
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as IngestionLedger;
    if (!parsed || typeof parsed !== 'object' || !parsed.records) return emptyLedger();
    return parsed;
  } catch {
    // A corrupt ledger must not erase history silently; keep the bad file.
    try {
      writeFileSync(`${path}.corrupt-${Date.now()}`, readFileSync(path));
    } catch { /* best effort */ }
    return emptyLedger();
  }
}

export function saveLedger(path: string, ledger: IngestionLedger): void {
  ledger.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** discovered — idempotent. Re-discovering unchanged content is a no-op. */
export function markDiscovered(
  ledger: IngestionLedger, sourceId: string, collection: string,
): IngestionRecord {
  const existing = ledger.records[sourceId];
  let hash = '';
  let modified: string | null = null;
  try {
    hash = fileHash(sourceId);
    modified = statSync(sourceId).mtime.toISOString();
  } catch {
    hash = '';
  }

  if (existing) {
    if (existing.contentHash === hash && existing.state !== 'failed') {
      return existing; // unchanged and healthy: nothing to do
    }
    if (existing.contentHash !== hash && existing.contentHash) {
      // The source changed after being indexed. That is LAG, not success.
      existing.supersededHash = existing.contentHash;
      existing.contentHash = hash;
      existing.state = 'discovered';
      existing.indexedAt = null;
      existing.verifiedAt = null;
      existing.sourceModifiedAt = modified;
    }
    return existing;
  }

  const record: IngestionRecord = {
    sourceId, contentHash: hash, collection, state: 'discovered',
    discoveredAt: new Date().toISOString(), indexedAt: null, verifiedAt: null,
    chunkCount: null, sourceModifiedAt: modified, attempts: 0, lastAttemptAt: null,
    error: null, supersededHash: null,
  };
  ledger.records[sourceId] = record;
  return record;
}

/** indexed — a claim by the store, not evidence. */
export function markIndexed(
  ledger: IngestionLedger, sourceId: string, chunkCount: number,
): IngestionRecord | null {
  const r = ledger.records[sourceId];
  if (!r) return null;
  r.state = 'indexed';
  r.indexedAt = new Date().toISOString();
  r.lastAttemptAt = r.indexedAt;
  r.attempts += 1;
  r.chunkCount = chunkCount;
  r.error = null;
  return r;
}

/** retrieval_verified — evidence. Only set by verifyRetrievable(). */
export function markVerified(ledger: IngestionLedger, sourceId: string): IngestionRecord | null {
  const r = ledger.records[sourceId];
  if (!r) return null;
  if (r.state !== 'indexed') {
    // Verification of something never indexed is a bug, not a promotion.
    return r;
  }
  r.state = 'retrieval_verified';
  r.verifiedAt = new Date().toISOString();
  return r;
}

/**
 * failed — stays retryable. The record is NOT removed and the source file is
 * NOT moved to a processed/archive directory.
 */
export function markFailed(
  ledger: IngestionLedger, sourceId: string, collection: string,
  errorClass: IngestionErrorClass, message: string,
): IngestionRecord {
  let r = ledger.records[sourceId];
  if (!r) r = markDiscovered(ledger, sourceId, collection);
  r.state = 'failed';
  r.attempts += 1;
  r.lastAttemptAt = new Date().toISOString();
  r.error = { class: errorClass, message: message.slice(0, 2000), at: r.lastAttemptAt };
  return r;
}

/** Everything the retry pass should attempt, newest failure first. */
export function retryInbox(ledger: IngestionLedger): IngestionRecord[] {
  return Object.values(ledger.records)
    .filter((r) => r.state === 'failed' || r.state === 'discovered')
    .sort((a, b) => (b.lastAttemptAt ?? b.discoveredAt).localeCompare(a.lastAttemptAt ?? a.discoveredAt));
}

/** Indexed but never proven retrievable — the population that used to lie. */
export function unverified(ledger: IngestionLedger): IngestionRecord[] {
  return Object.values(ledger.records).filter((r) => r.state === 'indexed');
}

/** Source on disk is newer than what we indexed. */
export function lagging(ledger: IngestionLedger, policy: RetrievalPolicy = POLICY): Array<{
  record: IngestionRecord; lagHours: number; severity: 'warn' | 'fail';
}> {
  const out: Array<{ record: IngestionRecord; lagHours: number; severity: 'warn' | 'fail' }> = [];
  for (const r of Object.values(ledger.records)) {
    let mtime: number;
    try {
      mtime = statSync(r.sourceId).mtime.getTime();
    } catch {
      continue;
    }
    const indexedAt = r.verifiedAt ?? r.indexedAt;
    if (!indexedAt) continue;
    const lagMs = mtime - Date.parse(indexedAt);
    if (lagMs <= 0) continue;
    const lagHours = lagMs / 3_600_000;
    if (lagHours >= policy.freshness.lag_fail_hours) out.push({ record: r, lagHours, severity: 'fail' });
    else if (lagHours >= policy.freshness.lag_warn_hours) out.push({ record: r, lagHours, severity: 'warn' });
  }
  return out.sort((a, b) => b.lagHours - a.lagHours);
}

/**
 * Classify a raw ingestion error message into a policy error class.
 * Transient classes are retried automatically; the rest need a decision.
 */
export function classifyIngestionError(message: string): IngestionErrorClass {
  const m = message.toLowerCase();
  if (/\b(429|rate.?limit|resource.?exhausted|quota)\b/.test(m)) return 'quota';
  if (/\b(503|502|500|unavailable|deadline exceeded|internal error|overloaded)\b/.test(m)) return 'transient_api';
  if (/timeout|timed out|etimedout/.test(m)) return 'timeout';
  if (/too large|exceeds|size limit/.test(m)) return 'too_large';
  if (/denied path|deny rule/.test(m)) return 'denied_path';
  if (/unsupported|unknown format|binary/.test(m)) return 'unsupported_format';
  if (/extract|parse|corrupt|no such (sheet|slide)/.test(m)) return 'extraction_failed';
  if (/permission denied|no such file|unreadable|decode/.test(m)) return 'unreadable';
  return 'unknown';
}

export const RETRYABLE_ERROR_CLASSES: IngestionErrorClass[] = [
  'transient_api', 'quota', 'timeout', 'unknown',
];

export function isAutoRetryable(errorClass: IngestionErrorClass): boolean {
  return RETRYABLE_ERROR_CLASSES.includes(errorClass);
}

// ---------------------------------------------------------------------------
// Retrieval verification
// ---------------------------------------------------------------------------

export interface VerificationOutcome {
  sourceId: string;
  probe: string;
  retrievable: boolean;
  citationResolved: boolean;
  topScore: number;
  reason: string | null;
}

/**
 * Pick a distinctive probe string from a document: the longest line that is
 * not boilerplate. Querying a document by its own rarest sentence is the only
 * honest test of "is this actually retrievable".
 */
export function buildProbe(content: string, maxLen = 160): string {
  const lines = content
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s|]+/, '').trim())
    .filter((l) => l.length >= 25 && l.length <= 400)
    .filter((l) => !/^(https?:|\||`|<)/.test(l));
  if (lines.length === 0) return content.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  // Rarity heuristic: prefer the line with the most distinct long words.
  let best = lines[0];
  let bestScore = -1;
  for (const line of lines) {
    const words = new Set(line.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 5));
    if (words.size > bestScore) {
      bestScore = words.size;
      best = line;
    }
  }
  return best.slice(0, maxLen);
}

/**
 * Prove an indexed document is retrievable: query the store with the
 * document's own distinctive content and assert the winning citation resolves
 * back to that same source id.
 */
export function verifyRetrievable(
  sourceId: string,
  collection: string,
  query: (collection: string, question: string, topK: number, threshold: number) => Array<{
    source?: string; content?: string; result?: string; similarity?: number;
  }>,
  options: { topK?: number; threshold?: number; content?: string } = {},
): VerificationOutcome {
  const topK = options.topK ?? 5;
  const threshold = options.threshold ?? 0.0;

  let content = options.content;
  if (content === undefined) {
    try {
      content = readFileSync(sourceId, 'utf-8');
    } catch (e) {
      return {
        sourceId, probe: '', retrievable: false, citationResolved: false, topScore: 0,
        reason: `cannot read source to build a probe: ${(e as Error).message}`,
      };
    }
  }

  const probe = buildProbe(content);
  if (!probe) {
    return {
      sourceId, probe: '', retrievable: false, citationResolved: false, topScore: 0,
      reason: 'document has no distinctive content to probe with',
    };
  }

  const hits = query(collection, probe, topK, threshold);
  if (hits.length === 0) {
    return {
      sourceId, probe, retrievable: false, citationResolved: false, topScore: 0,
      reason: 'querying the document by its own content returned nothing — indexed but not retrievable',
    };
  }

  const match = hits.find((h) => h.source && normalizePath(h.source) === normalizePath(sourceId));
  const topScore = hits[0]?.similarity ?? 0;
  if (!match) {
    return {
      sourceId, probe, retrievable: true, citationResolved: false, topScore,
      reason: `the document's own text retrieves other sources (top: ${hits[0]?.source ?? 'unknown'}) — the citation does not resolve to it`,
    };
  }
  if (!existsSync(match.source as string)) {
    return {
      sourceId, probe, retrievable: true, citationResolved: false, topScore,
      reason: 'the returned citation points at a path that no longer exists',
    };
  }
  return {
    sourceId, probe, retrievable: true, citationResolved: true,
    topScore: match.similarity ?? topScore, reason: null,
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface SourceConflict {
  claim: string;
  /** The source ids that disagree. */
  sources: string[];
  detail: string;
}

/**
 * Surface (never silently resolve) two sources making incompatible claims.
 * Detection is deliberately narrow: a claim is a policy statement of the form
 * "<subject> is <X>" for a small set of subjects that have exactly one correct
 * answer. Anything broader produces noise nobody reads.
 */
export interface ConflictProbe {
  claim: string;
  /** Regexes whose matches must all agree. */
  variants: Array<{ label: string; pattern: string }>;
}

export const DEFAULT_CONFLICT_PROBES: ConflictProbe[] = [
  {
    claim: 'client CRM system of record',
    variants: [
      { label: 'GoHighLevel (RETIRED 2026-07-06)', pattern: '\\bgohighlevel\\b|\\bghl\\b' },
      { label: 'Supabase uhs_projects / project_contacts', pattern: 'uhs_projects|project_contacts' },
    ],
  },
  {
    claim: 'default outbound email client',
    variants: [
      { label: 'Outlook', pattern: '\\boutlook\\b' },
      { label: 'Apple Mail / mailto: (forbidden)', pattern: 'apple mail|mailto:' },
    ],
  },
  {
    claim: 'listing photo source',
    variants: [
      { label: 'MLS Matrix', pattern: 'mls matrix|matrix' },
      { label: 'Zillow (forbidden)', pattern: '\\bzillow\\b' },
    ],
  },
  {
    claim: 'booking link provider',
    variants: [
      { label: 'UHS Scheduler', pattern: 'uhsscheduler|book\\.utopiahomestaging\\.com' },
      { label: 'Calendly (RETIRED 2026-07)', pattern: 'calendly' },
    ],
  },
];

export function detectConflicts(
  documents: Array<{ sourceId: string; content: string }>,
  probes: ConflictProbe[] = DEFAULT_CONFLICT_PROBES,
): SourceConflict[] {
  const out: SourceConflict[] = [];
  for (const probe of probes) {
    const byVariant = new Map<string, string[]>();
    for (const doc of documents) {
      const lower = doc.content.toLowerCase();
      for (const variant of probe.variants) {
        let re: RegExp;
        try {
          re = new RegExp(variant.pattern, 'i');
        } catch {
          continue;
        }
        if (re.test(lower)) {
          const list = byVariant.get(variant.label) ?? [];
          if (!list.includes(doc.sourceId)) list.push(doc.sourceId);
          byVariant.set(variant.label, list);
        }
      }
    }
    if (byVariant.size > 1) {
      out.push({
        claim: probe.claim,
        sources: Array.from(new Set(Array.from(byVariant.values()).flat())),
        detail: Array.from(byVariant.entries())
          .map(([label, srcs]) => `${label}: ${srcs.length} source(s)`)
          .join(' vs '),
      });
    }
  }
  return out;
}

export function defaultLedgerPath(instanceId: string, org: string): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.cortextos', instanceId, 'orgs', org, 'knowledge-base', 'ingestion-ledger.json',
  );
}
