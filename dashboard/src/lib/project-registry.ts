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

import type { ProjectRegistry, RegistryProject } from './project-registry-view';
export type { ProjectRegistry, RegistryProject } from './project-registry-view';
export { isSoftwareProject, ownerLabel, groupByClassification, coverageSummary } from './project-registry-view';

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
