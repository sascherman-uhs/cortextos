// Pure registry shapes and view helpers — deliberately free of any Node import.
//
// Split out of ./project-registry so client components can render the
// portfolio without dragging `fs`/`path` into the browser bundle. A value
// import of ./project-registry from a 'use client' module breaks the whole
// app build — see the 2026-09-05 outage where every route returned 500.

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
