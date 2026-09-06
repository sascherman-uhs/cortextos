// GENERATED FILE — DO NOT EDIT.
// Mirrored from src/knowledge/contract.ts by dashboard/src/app/api/kb/_contract/sync.mjs.
// Edit the canonical file and re-run the sync; the drift test regenerates this
// and fails on any difference.
/**
 * contract.ts — THE one retrieval contract for UHS knowledge.
 *
 * Why this file exists
 * --------------------
 * Before OS-06 there were two independent implementations of "which collections
 * do I search?":
 *
 *   - `src/bus/knowledge-base.ts` built a FIXED list: `shared-<org>` plus
 *     `agent-<name>`. It could never reach the `uhs` collection, which is where
 *     JARVIS actually ingests every vault document (10,449 docs at the time of
 *     writing) — so an agent asking a business question got nothing while the
 *     dashboard answered it.
 *   - `dashboard/src/app/api/kb/search/route.ts` ran `mmrag collections` and
 *     queried EVERY collection it found. That reached `uhs`, but it also
 *     reached `agent-tron`, `agent-kimi` and `agent-trillion-coder` for any
 *     caller who said `scope=all` — private persona scope handed out because
 *     the word "all" was read as "everything on disk".
 *
 * Both behaviours are now impossible: collection selection is DATA
 * (`retrieval-policy.json`), resolved by exactly one function
 * (`resolvePermittedCollections`), and both callers are thin wrappers around
 * `retrieve()`. Adding a collection, a role or a restricted path is a policy
 * edit, not a code edit in one of two places.
 *
 * This module deliberately imports ONLY node builtins and its own policy JSON,
 * so the Next.js dashboard (whose Turbopack root is pinned to `dashboard/`) can
 * import it directly without dragging the CLI's module graph in.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, basename } from 'path';

import policyJson from './retrieval-policy.json';

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export interface RetrievalPolicy {
  policy_version: string;
  org: string;
  layers: Array<{ id: LayerId; order: number; authority: string; min_score: number; description: string }>;
  ranking: {
    primary: string; band_size: number; tiebreak: string;
    authoritative_layers: LayerId[];
    authoritative_reserved_slots: Partial<Record<LayerId, number>> & { _note?: string };
  };
  collections: {
    org: Array<{ name: string; authority: string; description: string }>;
    agent_prefix: string;
    agent_authority: string;
  };
  authorization: {
    roles: Record<CallerRole, RoleGrants>;
    restricted_source_patterns: string[];
  };
  federation: { scope_map: Record<RetrievalScope, string[]> };
  dedupe: { key: string; algorithm: string };
  ingestion: {
    states: IngestionState[];
    terminal_success_state: IngestionState;
    error_classes: IngestionErrorClass[];
  };
  freshness: { lag_warn_hours: number; lag_fail_hours: number };
  structured_sources: StructuredSource[];
  retired_sources: RetiredSource[];
  registry_query: { stopwords: string[] };
  registry_sources: Array<{ id: string; authority: string; relative_path: string; description: string }>;
  document_roots: Array<{ id: string; relative_path: string; authority: string; max_depth?: number }>;
}

export interface RoleGrants {
  org_collections: boolean;
  own_agent_collection: boolean;
  other_agent_collections: boolean;
  restricted_documents: boolean;
}

export interface StructuredSource {
  id: string;
  question_patterns: string[];
  authority: string;
  location: string;
  lookup: string;
  supersedes?: string[];
}

export interface RetiredSource {
  id: string;
  retired_on: string;
  successor: string;
  note: string;
}

export type LayerId = 'registry' | 'structured' | 'documents' | 'semantic';
export type CallerRole = 'operator' | 'agent' | 'service' | 'anonymous';
export type RetrievalScope = 'shared' | 'private' | 'all';
export type IngestionState = 'discovered' | 'indexed' | 'retrieval_verified' | 'failed';
export type IngestionErrorClass =
  | 'transient_api' | 'quota' | 'timeout' | 'unsupported_format'
  | 'extraction_failed' | 'too_large' | 'denied_path' | 'unreadable' | 'unknown';

export const POLICY: RetrievalPolicy = policyJson as unknown as RetrievalPolicy;

// ---------------------------------------------------------------------------
// Caller identity and authorization
// ---------------------------------------------------------------------------

export interface RetrievalCaller {
  /** Surface asking the question. Recorded on every response for audit. */
  surface: 'cli' | 'dashboard' | 'skill' | 'agent';
  role: CallerRole;
  org: string;
  /** Persona name, when the caller IS an agent. Grants only that agent's collection. */
  agent?: string;
}

export interface CollectionGrant {
  name: string;
  authority: string;
  kind: 'org' | 'own_agent' | 'other_agent';
}

export interface CollectionDenial {
  name: string;
  reason: string;
}

export interface PermittedCollections {
  granted: CollectionGrant[];
  denied: CollectionDenial[];
}

/**
 * THE authorization decision. Every retrieval path goes through here.
 *
 * `available` is the set of collections that physically exist (from
 * `mmrag collections`). The result is the intersection of:
 *   what exists  ∩  what the requested scope asks for  ∩  what the role grants.
 *
 * A scope can never widen a grant: `all` means "all I am permitted to see".
 */
export function resolvePermittedCollections(
  caller: RetrievalCaller,
  scope: RetrievalScope,
  available: string[],
  policy: RetrievalPolicy = POLICY,
): PermittedCollections {
  const grants = policy.authorization.roles[caller.role];
  const scopeKinds = new Set(policy.federation.scope_map[scope] ?? []);
  // '{org}' in a declared collection name is substituted with the caller's org
  // so one policy serves every org without any caller building names itself.
  const orgNames = new Map(
    policy.collections.org.map((c) => [c.name.replace(/\{org\}/g, caller.org), c] as const),
  );
  const prefix = policy.collections.agent_prefix;

  const granted: CollectionGrant[] = [];
  const denied: CollectionDenial[] = [];

  // Org collections are policy-declared, not discovered, so a mis-spelled or
  // stray `shared-*` directory can never become a search target.
  for (const [name, meta] of orgNames) {
    if (!available.includes(name)) {
      denied.push({ name, reason: 'declared in policy but not present in the store' });
      continue;
    }
    if (!scopeKinds.has('org')) {
      denied.push({ name, reason: `scope '${scope}' does not include org collections` });
    } else if (!grants.org_collections) {
      denied.push({ name, reason: `role '${caller.role}' is not granted org collections` });
    } else {
      granted.push({ name, authority: meta.authority, kind: 'org' });
    }
  }

  for (const name of available) {
    if (orgNames.has(name)) continue;
    if (!name.startsWith(prefix)) {
      // Anything that is neither a declared org collection nor an agent
      // collection is out of contract. It is never searched silently.
      denied.push({ name, reason: 'undeclared collection: not in policy and not an agent collection' });
      continue;
    }
    const agentName = name.slice(prefix.length);
    const isOwn = !!caller.agent && agentName === caller.agent;
    const kind: CollectionGrant['kind'] = isOwn ? 'own_agent' : 'other_agent';

    if (!scopeKinds.has(kind)) {
      denied.push({ name, reason: `scope '${scope}' does not include ${kind} collections` });
      continue;
    }
    const allowed = isOwn ? grants.own_agent_collection : grants.other_agent_collections;
    if (!allowed) {
      denied.push({
        name,
        reason: isOwn
          ? `role '${caller.role}' is not granted its own persona collection`
          : `role '${caller.role}' may not read another persona's private collection`,
      });
      continue;
    }
    granted.push({ name, authority: policy.collections.agent_authority, kind });
  }

  return { granted, denied };
}

/**
 * The single place an ingest TARGET collection name is decided.
 *
 * Ingestion has to agree with retrieval about what a collection is called, so
 * the name is built here from the same policy rather than re-spelled at each
 * call site.
 */
export function resolveIngestCollection(
  caller: { org: string; agent?: string },
  scope: 'shared' | 'private',
  policy: RetrievalPolicy = POLICY,
): string {
  if (scope === 'private') {
    if (!caller.agent) {
      throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    }
    return `${policy.collections.agent_prefix}${caller.agent}`;
  }
  const shared = policy.collections.org.find((c) => c.name.includes('{org}'));
  if (!shared) throw new Error('policy declares no org-templated shared collection');
  return shared.name.replace(/\{org\}/g, caller.org);
}

/** Document-level scope enforcement, applied AFTER collection-level. */
export function isRestrictedSource(source: string, policy: RetrievalPolicy = POLICY): string | null {
  const normalized = source.replace(/\\/g, '/');
  for (const pattern of policy.authorization.restricted_source_patterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    if (re.test(normalized)) return pattern;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conflicts — surfaced, never silently resolved
// ---------------------------------------------------------------------------

export interface ConflictProbe {
  claim: string;
  /** Every variant that matches must agree; two matching variants is a conflict. */
  variants: Array<{ label: string; pattern: string }>;
}

export interface SourceConflict {
  claim: string;
  sources: string[];
  detail: string;
}

/**
 * Detection is deliberately narrow: a claim is a policy statement for a small
 * set of subjects that have exactly one correct answer. Anything broader
 * produces noise nobody reads, and a conflict nobody reads is not surfaced.
 */
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
      { label: 'MLS Matrix', pattern: 'mls matrix' },
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
        if (!re.test(lower)) continue;
        const list = byVariant.get(variant.label) ?? [];
        if (!list.includes(doc.sourceId)) list.push(doc.sourceId);
        byVariant.set(variant.label, list);
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

// ---------------------------------------------------------------------------
// Citations and results
// ---------------------------------------------------------------------------

export interface Citation {
  /** Stable id: absolute canonical source path (plus chunk when chunked). */
  sourceId: string;
  canonicalSource: string;
  filename: string;
  collection: string;
  layer: LayerId;
  authority: string;
  contentHash: string;
  score: number;
  chunkIndex: number | null;
  totalChunks: number | null;
  /** Other collections that held a byte-equal copy of this content. */
  duplicateCollections: string[];
  /** mtime of the source on disk, when resolvable. */
  sourceModifiedAt: string | null;
  /** When the retrieval that produced this citation ran. */
  retrievedAt: string;
  /**
   * True when the source file is newer than the index entry behind this hit.
   *
   * Only computable when the store reports WHEN it indexed the chunk. mmrag
   * stores `ingested_at` in chunk metadata but does not emit it in `--json`
   * output, and mmrag is a shared skill outside this package, so per-citation
   * staleness is currently always false. Lag IS surfaced — from the ingestion
   * ledger, which compares source mtime against the recorded index time, on
   * /api/kb/health and the Knowledge view's Lag tab. Adding `ingested_at` to
   * mmrag's query output is what would make this field live.
   */
  stale: boolean;
  /** True when the cited file no longer resolves on disk. */
  missing: boolean;
}

export interface RetrievalHit {
  content: string;
  citation: Citation;
}

export interface RetrievalResponse {
  query: string;
  caller: { surface: string; role: CallerRole; org: string; agent: string | null };
  scope: RetrievalScope;
  layersConsulted: LayerId[];
  collectionsSearched: string[];
  collectionsDenied: CollectionDenial[];
  results: RetrievalHit[];
  total: number;
  /** Documents withheld because their source path is in restricted scope. */
  restrictedWithheld: number;
  /** Sources retrieved that the policy marks retired, with their successor. */
  retiredGuidance: Array<{ sourceId: string; retired: RetiredSource }>;
  /** Two cited sources making incompatible claims, surfaced not resolved. */
  conflicts: Array<{ claim: string; sources: string[] }>;
  /** Non-fatal degradation (store unreachable, KB unconfigured, layer skipped). */
  degraded: string[];
  /** Explicit uncertainty statement when nothing authoritative was found. */
  uncertainty: string | null;
}

export function contentHash(content: string): string {
  return createHash('sha256')
    .update(content.replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// mmrag transport — the ONLY place either surface shells out to the store
// ---------------------------------------------------------------------------

export interface StoreConfig {
  /** CortexOS framework root (holds knowledge-base/venv + scripts). */
  frameworkRoot: string;
  instanceId: string;
  org: string;
  agent?: string;
  /** Absolute path to a JARVIS-style mmrag.py, used when the CortexOS venv is absent. */
  mmragPath?: string;
  pythonPath?: string;
  env?: Record<string, string>;
}

function loadEnvFile(p: string, into: Record<string, string>): void {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    let val = trimmed.slice(idx + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    into[trimmed.slice(0, idx)] = val;
  }
}

export interface ResolvedStore {
  python: string;
  mmrag: string;
  env: Record<string, string>;
  configured: boolean;
  reason?: string;
}

export function resolveStore(cfg: StoreConfig): ResolvedStore {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';

  const kbRoot = join(homedir(), '.cortextos', cfg.instanceId, 'orgs', cfg.org, 'knowledge-base');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  loadEnvFile(join(cfg.frameworkRoot, '.env'), env);
  loadEnvFile(join(cfg.frameworkRoot, 'orgs', cfg.org, 'secrets.env'), env);
  Object.assign(env, {
    CTX_ORG: cfg.org,
    CTX_AGENT_NAME: cfg.agent || '',
    CTX_INSTANCE_ID: cfg.instanceId,
    CTX_FRAMEWORK_ROOT: cfg.frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
    ...(cfg.env || {}),
  });

  const python = cfg.pythonPath || join(cfg.frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
  const mmrag = cfg.mmragPath || join(cfg.frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  if (!existsSync(python)) {
    return { python, mmrag, env, configured: false, reason: `python interpreter not found at ${python}` };
  }
  if (!existsSync(mmrag)) {
    return { python, mmrag, env, configured: false, reason: `mmrag.py not found at ${mmrag}` };
  }
  if (!existsSync(env.MMRAG_CONFIG)) {
    return { python, mmrag, env, configured: false, reason: `knowledge base not configured for org ${cfg.org}` };
  }
  return { python, mmrag, env, configured: true };
}

function runMmrag(store: ResolvedStore, args: string[], timeoutMs: number): string {
  try {
    return execFileSync(store.python, [store.mmrag, ...args], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: store.env as NodeJS.ProcessEnv,
    });
  } catch (e: unknown) {
    // ChromaDB can crash mid-output; salvage partial stdout rather than
    // silently returning nothing, which is how "0 results" used to be
    // indistinguishable from "the store fell over".
    return (e as { stdout?: string }).stdout || '';
  }
}

export function listCollections(store: ResolvedStore): string[] {
  if (!store.configured) return [];
  const out = runMmrag(store, ['collections'], 15000);
  const names: string[] = [];
  for (const line of out.trim().split('\n')) {
    if (!line || line.startsWith('Collection') || line.startsWith('---')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const name = parts.slice(0, parts.length - 1).join(' ');
      if (name) names.push(name);
    }
  }
  return names;
}

interface RawHit {
  content?: string; result?: string; similarity?: number; source?: string;
  type?: string; filename?: string; chunk_index?: number; total_chunks?: number;
}

export function queryCollection(
  store: ResolvedStore, collection: string, question: string, topK: number, threshold: number,
): RawHit[] {
  if (!store.configured) return [];
  const out = runMmrag(store, [
    'query', question, '--collection', collection,
    '--top-k', String(topK), '--threshold', String(threshold), '--json',
  ], 30000);
  const trimmed = out.trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as { results?: RawHit[] };
    return parsed.results || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Layers 1–3: registry, structured, documents
// ---------------------------------------------------------------------------

export interface KnowledgeRoots {
  /** JARVIS repo root — holds vault/, memory/ and the capability registry. */
  jarvisRoot?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeCitation(
  partial: Partial<Citation> & { canonicalSource: string; collection: string; layer: LayerId; authority: string; content: string },
): Citation {
  const src = partial.canonicalSource;
  let modified: string | null = null;
  let missing = false;
  try {
    modified = statSync(src).mtime.toISOString();
  } catch {
    missing = !src.startsWith('supabase:') && !src.startsWith('https:');
  }
  return {
    sourceId: partial.sourceId ?? (partial.chunkIndex != null ? `${src}#${partial.chunkIndex}` : src),
    canonicalSource: src,
    filename: partial.filename ?? basename(src),
    collection: partial.collection,
    layer: partial.layer,
    authority: partial.authority,
    contentHash: contentHash(partial.content),
    score: partial.score ?? 1,
    chunkIndex: partial.chunkIndex ?? null,
    totalChunks: partial.totalChunks ?? null,
    duplicateCollections: [],
    sourceModifiedAt: modified,
    retrievedAt: nowIso(),
    stale: false,
    missing,
  };
}

/** Layer 1 — canonical registry lookup. "Do we have X?" is answered from here. */
export function registryLookup(
  question: string, roots: KnowledgeRoots, policy: RetrievalPolicy = POLICY,
): RetrievalHit[] {
  if (!roots.jarvisRoot) return [];
  const hits: RetrievalHit[] = [];
  // Only DISTINCTIVE terms count. Scoring on every word let "the UHS policy on
  // submarine leasing in Antarctica" match registry entries on "uhs" and
  // "policy" and clear the relevance floor, so a question with no answer came
  // back with citations. A query with no distinctive term matches nothing.
  const stop = new Set(policy.registry_query?.stopwords ?? []);
  const terms = question.toLowerCase()
    .split(/[^a-z0-9.+_-]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  if (terms.length === 0) return hits;
  for (const src of policy.registry_sources) {
    const p = join(roots.jarvisRoot, src.relative_path);
    if (!existsSync(p)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      continue;
    }
    const matches = searchRegistry(parsed, terms);
    for (const m of matches.slice(0, 5)) {
      hits.push({
        content: m.text,
        citation: makeCitation({
          canonicalSource: p, collection: src.id, layer: 'registry',
          authority: src.authority, content: m.text, score: m.score,
        }),
      });
    }
  }
  return hits;
}

function searchRegistry(node: unknown, terms: string[]): Array<{ text: string; score: number }> {
  const out: Array<{ text: string; score: number }> = [];
  const walk = (n: unknown, path: string[]): void => {
    if (path.length > 6) return;
    if (Array.isArray(n)) {
      n.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (n && typeof n === 'object') {
      const text = JSON.stringify(n);
      if (text.length < 4000) {
        const lower = text.toLowerCase();
        const matched = terms.filter((t) => lower.includes(t));
        if (matched.length > 0) {
          out.push({ text: `${path.join('.')}: ${text}`, score: matched.length / Math.max(terms.length, 1) });
          return; // do not also emit every child of a matched node
        }
      }
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) walk(v, [...path, k]);
    }
  };
  walk(node, []);
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Layer 2 — structured authoritative data.
 *
 * This layer does NOT invent database rows. It routes the question to the
 * authoritative record system and cites it, so an agent answers "query
 * uhsMLS.agents" instead of recalling an agent's phone number from prose — and
 * so retired systems (GoHighLevel) can never be offered as the answer.
 */
export function structuredLookup(
  question: string, policy: RetrievalPolicy = POLICY,
): RetrievalHit[] {
  const lower = question.toLowerCase();
  const hits: RetrievalHit[] = [];
  for (const src of policy.structured_sources) {
    const matched = src.question_patterns.filter((p) => lower.includes(p));
    if (matched.length === 0) continue;
    const text = `AUTHORITATIVE SOURCE ${src.id} — ${src.location}. ${src.lookup}`;
    hits.push({
      content: text,
      citation: makeCitation({
        canonicalSource: `supabase:${src.id}`, collection: 'structured',
        layer: 'structured', authority: src.authority, content: text,
        score: Math.min(1, matched.length / 2),
      }),
    });
  }
  return hits.sort((a, b) => b.citation.score - a.citation.score);
}

/** Layer 3 — deterministic scoped document/wiki lookup by filename and heading. */
export function documentLookup(
  question: string, roots: KnowledgeRoots, limit: number, policy: RetrievalPolicy = POLICY,
): RetrievalHit[] {
  if (!roots.jarvisRoot) return [];
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  if (terms.length === 0) return [];
  const hits: RetrievalHit[] = [];

  for (const root of policy.document_roots) {
    const base = resolve(join(roots.jarvisRoot, root.relative_path));
    if (!existsSync(base)) continue;
    for (const file of walkFiles(base, root.max_depth ?? 4)) {
      const name = basename(file).toLowerCase();
      const matched = terms.filter((t) => name.includes(t));
      if (matched.length === 0) continue;
      let content = '';
      try {
        content = readFileSync(file, 'utf-8').slice(0, 2000);
      } catch {
        continue;
      }
      hits.push({
        content,
        citation: makeCitation({
          canonicalSource: file, collection: root.id, layer: 'documents',
          authority: root.authority, content, score: matched.length / terms.length,
        }),
      });
      if (hits.length >= limit * 3) break;
    }
  }
  return hits.sort((a, b) => b.citation.score - a.citation.score).slice(0, limit);
}

function walkFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth > maxDepth) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkFiles(full, maxDepth, depth + 1));
    else if (/\.(md|txt|json)$/i.test(e)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface RetrieveOptions {
  question: string;
  caller: RetrievalCaller;
  scope?: RetrievalScope;
  topK?: number;
  threshold?: number;
  store: StoreConfig;
  roots?: KnowledgeRoots;
  /** Restrict to a subset of layers. Order is always policy order. */
  layers?: LayerId[];
  /** Injected for tests: bypasses the mmrag subprocess. */
  transport?: {
    listCollections: () => string[];
    query: (collection: string, question: string, topK: number, threshold: number) => RawHit[];
  };
}

export function retrieve(opts: RetrieveOptions): RetrievalResponse {
  const policy = POLICY;
  const scope: RetrievalScope = opts.scope ?? 'all';
  const topK = opts.topK ?? 10;
  const threshold = opts.threshold ?? 0.5;
  const roots = opts.roots ?? {};
  const wanted = new Set<LayerId>(opts.layers ?? policy.layers.map((l) => l.id));
  const degraded: string[] = [];
  const layersConsulted: LayerId[] = [];

  const response: RetrievalResponse = {
    query: opts.question,
    caller: {
      surface: opts.caller.surface, role: opts.caller.role,
      org: opts.caller.org, agent: opts.caller.agent ?? null,
    },
    scope,
    layersConsulted,
    collectionsSearched: [],
    collectionsDenied: [],
    results: [],
    total: 0,
    restrictedWithheld: 0,
    retiredGuidance: [],
    conflicts: [],
    degraded,
    uncertainty: null,
  };

  // An anonymous caller is denied before any store is touched.
  if (opts.caller.role === 'anonymous') {
    response.uncertainty =
      'No knowledge returned: the caller is unauthenticated and is granted no collections.';
    return response;
  }

  const raw: RetrievalHit[] = [];

  if (wanted.has('registry')) {
    layersConsulted.push('registry');
    try {
      raw.push(...registryLookup(opts.question, roots, policy));
    } catch (e) {
      degraded.push(`registry layer failed: ${(e as Error).message}`);
    }
  }
  if (wanted.has('structured')) {
    layersConsulted.push('structured');
    raw.push(...structuredLookup(opts.question, policy));
  }
  if (wanted.has('documents')) {
    layersConsulted.push('documents');
    try {
      raw.push(...documentLookup(opts.question, roots, topK, policy));
    } catch (e) {
      degraded.push(`documents layer failed: ${(e as Error).message}`);
    }
  }

  if (wanted.has('semantic')) {
    layersConsulted.push('semantic');
    const transport = opts.transport;
    let available: string[];
    let query: (c: string, q: string, k: number, t: number) => RawHit[];

    if (transport) {
      available = transport.listCollections();
      query = transport.query;
    } else {
      const store = resolveStore(opts.store);
      if (!store.configured) {
        degraded.push(`semantic layer unavailable: ${store.reason}`);
        available = [];
        query = () => [];
      } else {
        available = listCollections(store);
        query = (c, q, k, t) => queryCollection(store, c, q, k, t);
      }
    }

    if (available.length === 0) {
      // The store could not enumerate collections (crashed listing, partial
      // pickle, no CLI). Fall back to the collections the POLICY declares for
      // this org — never to a discovered list, so the fallback can only ever
      // be narrower, never leak a persona collection.
      const declared = policy.collections.org.map((c) => c.name.replace(/\{org\}/g, opts.caller.org));
      if (declared.length > 0) {
        degraded.push('collection listing unavailable; falling back to the policy-declared org collections');
        available = declared;
      }
    }

    const permitted = resolvePermittedCollections(opts.caller, scope, available, policy);
    response.collectionsDenied = permitted.denied;
    response.collectionsSearched = permitted.granted.map((g) => g.name);

    if (permitted.granted.length === 0 && available.length > 0) {
      degraded.push(
        `no collection is both present and permitted for role '${opts.caller.role}' at scope '${scope}'`,
      );
    }

    for (const grant of permitted.granted) {
      for (const hit of query(grant.name, opts.question, topK, threshold)) {
        const content = hit.content || hit.result || '';
        if (!content) continue;
        const source = hit.source || '';
        raw.push({
          content,
          citation: makeCitation({
            canonicalSource: source || `${grant.name}:unknown-source`,
            filename: hit.filename || (source ? basename(source) : grant.name),
            collection: grant.name, layer: 'semantic', authority: grant.authority,
            content, score: hit.similarity ?? 0,
            chunkIndex: hit.chunk_index ?? null, totalChunks: hit.total_chunks ?? null,
          }),
        });
      }
    }
  }

  // --- per-layer minimum relevance -----------------------------------------
  // A deterministic keyword layer that barely matched contributes nothing; it
  // is noise wearing an authoritative label.
  const minScore = new Map(policy.layers.map((l) => [l.id, l.min_score ?? 0]));
  const relevant = raw.filter((h) => h.citation.score >= (minScore.get(h.citation.layer) ?? 0));

  // --- document-level restricted scope -------------------------------------
  const grants = policy.authorization.roles[opts.caller.role];
  const visible: RetrievalHit[] = [];
  for (const hit of relevant) {
    if (!grants.restricted_documents) {
      const pattern = isRestrictedSource(hit.citation.canonicalSource, policy);
      if (pattern) {
        response.restrictedWithheld += 1;
        continue;
      }
    }
    visible.push(hit);
  }

  // --- dedupe by canonical source + content hash ----------------------------
  const byKey = new Map<string, RetrievalHit>();
  const authorityRank = new Map(policy.layers.map((l) => [l.id, l.order]));
  for (const hit of visible) {
    const key = `${hit.citation.canonicalSource}|${hit.citation.contentHash}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, hit);
      continue;
    }
    if (existing.citation.collection !== hit.citation.collection
      && !existing.citation.duplicateCollections.includes(hit.citation.collection)) {
      existing.citation.duplicateCollections.push(hit.citation.collection);
    }
    // Higher authority (earlier layer) wins; then higher score.
    const existingRank = authorityRank.get(existing.citation.layer) ?? 99;
    const hitRank = authorityRank.get(hit.citation.layer) ?? 99;
    if (hitRank < existingRank || (hitRank === existingRank && hit.citation.score > existing.citation.score)) {
      hit.citation.duplicateCollections = existing.citation.duplicateCollections;
      byKey.set(key, hit);
    }
  }

  // Layer order is AUTHORITY, not display order. Ranking by layer first would
  // let a weak registry keyword match bury a strong semantic hit, which is
  // exactly how a "layered" retriever starts returning noise. Rank by score
  // band, and let authority decide only inside a band.
  const band = policy.ranking?.band_size || 0.1;
  const byBand = (a: RetrievalHit, b: RetrievalHit): number => {
    const ba = Math.floor(a.citation.score / band);
    const bb = Math.floor(b.citation.score / band);
    if (ba !== bb) return bb - ba;
    const ra = authorityRank.get(a.citation.layer) ?? 99;
    const rb = authorityRank.get(b.citation.layer) ?? 99;
    if (ra !== rb) return ra - rb;
    return b.citation.score - a.citation.score;
  };

  // Reserved slots for the authoritative layers.
  //
  // Semantic similarity and keyword-match fraction are different numbers on the
  // same scale, and the semantic one is always larger: "who is the owner of a
  // listed property" scored 0.76 on a memory note and 0.50 on the Assessor
  // record pointer, so pure ranking dropped the authoritative source that
  // actually answers the question and kept the prose about it. A registry or
  // structured hit that fires at all is telling the caller WHERE the current
  // fact lives, which is the first thing the contract is supposed to do — so a
  // bounded number of them are placed at the front instead of competing on a
  // score that means something else.
  const authoritative = new Set<LayerId>(policy.ranking?.authoritative_layers ?? []);
  const reserved = policy.ranking?.authoritative_reserved_slots ?? {};
  const all = Array.from(byKey.values()).sort(byBand);
  const front: RetrievalHit[] = [];
  for (const layer of policy.layers.map((l) => l.id)) {
    if (!authoritative.has(layer)) continue;
    const slots = reserved[layer] ?? 0;
    front.push(...all.filter((h) => h.citation.layer === layer).slice(0, slots));
  }
  // The reserved slots are ADDITIVE to topK, not carved out of it. Carving them
  // out meant that when seven authoritative pointers fired for "which email
  // client are outbound UHS emails drafted in?" they filled every slot and the
  // document that actually says Outlook never appeared. A pointer costs one
  // line and says where the fact lives; it must never displace the fact.
  const rest = all.filter((h) => !front.includes(h));
  const merged = [...front, ...rest.slice(0, topK)];

  // --- retired guidance + staleness ----------------------------------------
  for (const hit of merged) {
    const lower = `${hit.content} ${hit.citation.canonicalSource}`.toLowerCase();
    for (const retired of policy.retired_sources) {
      if (lower.includes(retired.id.toLowerCase())) {
        response.retiredGuidance.push({ sourceId: hit.citation.sourceId, retired });
      }
    }
    if (hit.citation.missing) {
      degraded.push(`cited source no longer resolves on disk: ${hit.citation.canonicalSource}`);
    }
  }

  // Two cited sources making incompatible claims are shown as a conflict, not
  // silently reconciled by whichever one happened to rank higher.
  response.conflicts = detectConflicts(
    merged.map((h) => ({ sourceId: h.citation.sourceId, content: h.content })),
  );

  response.results = merged;
  response.total = merged.length;

  if (merged.length === 0) {
    response.uncertainty = buildUncertainty(response, degraded);
  } else if (response.retiredGuidance.length > 0) {
    const names = Array.from(new Set(response.retiredGuidance.map((r) => r.retired.id)));
    response.uncertainty =
      `Retrieved material references retired system(s) ${names.join(', ')}. `
      + `That guidance is obsolete; answer from the successor named in the policy and say so explicitly.`;
  }

  return response;
}

function buildUncertainty(response: RetrievalResponse, degraded: string[]): string {
  const parts = ['No source was found that answers this.'];
  if (response.restrictedWithheld > 0) {
    parts.push(
      `${response.restrictedWithheld} document(s) matched but are outside this caller's permitted scope.`,
    );
  }
  if (response.collectionsSearched.length === 0) {
    parts.push('No collection was searched.');
  } else {
    parts.push(`Searched: ${response.collectionsSearched.join(', ')}.`);
  }
  if (degraded.length > 0) parts.push(`Degraded: ${degraded.join('; ')}.`);
  parts.push('Say the answer is unavailable rather than inferring one.');
  return parts.join(' ');
}
