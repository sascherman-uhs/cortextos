import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';
import {
  resolveIngestCollection,
  resolveStore,
  retrieve,
  type CallerRole,
  type RetrievalScope,
} from '../knowledge/contract.js';

/**
 * Knowledge base integration for the fleet CLI.
 *
 * This file used to decide FOR ITSELF which ChromaDB collections a question
 * should search: a fixed `shared-<org>` (+ `agent-<name>`) list. The dashboard
 * decided separately, by listing every collection on disk. The two answers
 * disagreed — the CLI could not reach the `uhs` collection that holds all of
 * JARVIS's business knowledge, so an agent asking a business question got
 * nothing the dashboard could answer, and the dashboard handed out private
 * persona collections to anyone who said `scope=all`.
 *
 * Neither decision lives here any more. Collection selection, authorization and
 * federation are resolved once in `src/knowledge/contract.ts` from
 * `retrieval-policy.json`. This module is a thin caller that adapts the
 * contract's response to the CLI's long-standing result shape.
 */

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base through the ONE retrieval contract.
 *
 * `role` defaults defensively: a process running as an agent (CTX_AGENT_NAME
 * set, which the daemon does for every persona worker) gets the `agent` role
 * and can never read another persona's private collection. An interactive
 * terminal with no agent identity is the operator.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: RetrievalScope;
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
    role?: CallerRole;
    /** JARVIS repo root, enabling the registry and document layers. */
    jarvisRoot?: string;
  },
): KBQueryResponse {
  const { agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two distinct
  // ChromaDB collections and a case-drifted query silently hits the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const store = { frameworkRoot, instanceId, org, agent };
  const resolved = resolveStore(store);
  if (!resolved.configured) {
    // UX safety net: distinguish "the KB is not set up" from "the KB is set up
    // and this question genuinely has no answer". Both used to print 0 results.
    console.warn(
      `[kb] Knowledge base not available for org ${org}: ${resolved.reason}. `
      + `Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const role: CallerRole =
    options.role ?? (process.env.CTX_AGENT_NAME ? 'agent' : 'operator');

  const response = retrieve({
    question,
    caller: { surface: 'cli', role, org, agent },
    scope,
    topK,
    threshold,
    store,
    roots: { jarvisRoot: options.jarvisRoot ?? process.env.UHS_JARVIS_ROOT },
    // The CLI answer stays semantic-only so its result shape is unchanged for
    // existing consumers; `cortextos bus kb-context` exposes the full contract.
    layers: ['semantic'],
  });

  return {
    results: response.results.map((hit) => ({
      content: hit.content,
      source_file: hit.citation.canonicalSource,
      org,
      agent_name: agent,
      score: hit.citation.score,
      doc_type: hit.citation.layer === 'semantic' ? 'markdown' : hit.citation.layer,
    })),
    total: response.total,
    query: question,
    collection:
      response.collectionsSearched.length === 1
        ? response.collectionsSearched[0]
        : `shared-${org}`,
  };
}

/**
 * Query the knowledge base and return the FULL contract response — ordered
 * layers, citations, denied collections, retired-guidance warnings and an
 * explicit uncertainty statement when nothing was found. This is what skills
 * and interactive agents should use; `queryKnowledgeBase` is the legacy shape.
 */
export function retrieveKnowledge(options: {
  question: string;
  org: string;
  agent?: string;
  role?: CallerRole;
  scope?: RetrievalScope;
  topK?: number;
  threshold?: number;
  frameworkRoot: string;
  instanceId: string;
  jarvisRoot?: string;
}) {
  const org = normalizeOrgName(options.frameworkRoot, options.org);
  return retrieve({
    question: options.question,
    caller: {
      surface: 'cli',
      role: options.role ?? (process.env.CTX_AGENT_NAME ? 'agent' : 'operator'),
      org,
      agent: options.agent,
    },
    scope: options.scope ?? 'all',
    topK: options.topK ?? 10,
    threshold: options.threshold ?? 0.5,
    store: {
      frameworkRoot: options.frameworkRoot,
      instanceId: options.instanceId,
      org,
      agent: options.agent,
    },
    roots: { jarvisRoot: options.jarvisRoot ?? process.env.UHS_JARVIS_ROOT },
  });
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', force, frameworkRoot, instanceId } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const resolved = resolveStore({ frameworkRoot, instanceId, org, agent });

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message. Detect the missing-config state up-front and warn-and-skip.
  if (!resolved.configured) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = resolved.python;
  const mmragPath = resolved.mmrag;
  const env = resolved.env;

  // Collection naming is policy, resolved in the contract — never spelled out
  // here, so ingest and retrieval can never disagree about what a collection
  // is called.
  const collection = resolveIngestCollection({ org, agent }, scope);

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
    stdio: 'inherit',
  });

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
