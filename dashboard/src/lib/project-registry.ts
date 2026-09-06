/**
 * OS-05 — project registry reader.
 *
 * Reads the `portfolio-v1` project registry that JARVIS builds
 * (`vault/registry/projects-v1.json`). This route READS that file and nothing
 * else: the registry is the single source of truth, and a dashboard that
 * re-derived the portfolio would just be a second, disagreeing answer.
 *
 * If the registry is missing or unreadable the route says so explicitly rather
 * than returning an empty list — "no projects" and "I could not read the
 * registry" must never look the same to the reader.
 */
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const DEFAULT_REGISTRY = path.join(
  process.env.HOME || '',
  'Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/vault/registry/projects-v1.json',
);

export function registryPath(): string {
  return process.env.UHS_PROJECT_REGISTRY || DEFAULT_REGISTRY;
}

export interface ProjectRegistry {
  inventory_release: string;
  built_at: string;
  complete: boolean;
  completeness_blockers: string[];
  counts_by_classification: Record<string, number>;
  project_count: number;
  projects: RegistryProject[];
  coverage_exceptions: { kind: string; id: string; path: string | null; detail: string }[];
  remediation_items: { id: string; item: string }[];
  non_candidate_directories: { id: string; path: string; reason: string }[];
  open_questions_for_scott?: string[];
  portfolio_owner?: { human?: string; role?: string; note?: string };
}

export interface RegistryProject {
  id: string;
  aliases: string[];
  classification: string;
  classification_reason: string;
  reviewer: string | null;
  review_date: string | null;
  purpose: string | null;
  business_outcome: string | null;
  lifecycle: string | null;
  owner_human: string | null;
  owner_agent_role: string | null;
  stack: string[];
  repo: string | null;
  parent_project?: string | null;
  workspace: string;
  deployment: { kind?: string; url?: string | null; source?: string };
  datastores: string[];
  depends_on: string[];
  commands: Record<string, string>;
  docs_roots: string[];
  active_plan: string | null;
  backlog_links: string[];
  permissions: string | null;
  successor?: string | null;
  operational_risks: string[];
  plan_row: { status?: string; note?: string } | null;
  health: { status: string; notes: string[] };
  observed: {
    path: string;
    is_git: boolean;
    branch: string | null;
    last_verified_change: { sha?: string | null; date?: string | null; subject?: string | null };
    runtime: { pm2_name: string; port: number; matched: string; kind?: string }[];
    vercel_project?: string | null;
    supabase_project_refs: string[];
    package_scripts: Record<string, string>;
    discovery_root: string;
  };
}

export function readRegistry(file = registryPath()):
  | { ok: true; registry: ProjectRegistry }
  | { ok: false; error: string; path: string } {
  try {
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        path: file,
        error:
          'The portfolio-v1 project registry has not been built at this path. Run ' +
          'scripts/agent-os/project_registry.py in uhsJARVIS, or set UHS_PROJECT_REGISTRY.',
      };
    }
    return { ok: true, registry: JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectRegistry };
  } catch (err) {
    return { ok: false, path: file, error: `Registry could not be read: ${(err as Error).message}` };
  }
}

/**
 * Pure view helpers. They live here rather than in the component so the rules
 * that decide what a reader is told can be tested without a DOM.
 */

/** A workspace whose stack says it is not an application is not a software project. */
export function isSoftwareProject(p: RegistryProject): boolean {
  return (p.stack || []).some((s) => !/NOT a web application/i.test(s));
}

/** Owners the registry does not know must never render as an empty cell. */
export function ownerLabel(p: RegistryProject): { text: string; unknown: boolean } {
  if (!p.owner_human) return { text: 'unknown — remediation item', unknown: true };
  return { text: p.owner_human, unknown: false };
}

export function groupByClassification(
  projects: RegistryProject[],
): Record<string, RegistryProject[]> {
  const by: Record<string, RegistryProject[]> = {};
  for (const p of projects) (by[p.classification] ||= []).push(p);
  return by;
}

/**
 * What the coverage banner says. `claimsComplete` is taken from the registry
 * and never inferred from "there are no exceptions visible right now".
 */
export function coverageSummary(reg: ProjectRegistry): {
  claimsComplete: boolean;
  blockers: string[];
  exceptionCount: number;
} {
  return {
    claimsComplete: reg.complete === true,
    blockers: reg.completeness_blockers || [],
    exceptionCount: (reg.coverage_exceptions || []).length,
  };
}
