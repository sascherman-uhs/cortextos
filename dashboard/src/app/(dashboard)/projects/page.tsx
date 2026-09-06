/**
 * OS-05 — Projects.
 *
 * The portfolio registry rendered for a human: owner, purpose, runtime
 * location, links, health and freshness, dependencies, open risks, current
 * milestone, backlog, last shipped change and next improvement.
 *
 * Two things this page refuses to do, because the plan says a registry that
 * flatters itself is worse than none:
 *  - it never shows a coverage claim the registry did not earn. When
 *    `complete` is false the banner says so and lists the blockers.
 *  - it never renders an unknown owner as a blank cell. Unknowns are
 *    remediation items with their own section.
 *
 * Staging jobs are business work in the tasks/queue surfaces. Everything here
 * is a software project or a working workspace, and each row says which.
 */
export const dynamic = 'force-dynamic';

import { readRegistry } from '@/lib/project-registry';
import { ProjectsView } from '@/components/projects/projects-view';
import { Card, CardContent } from '@/components/ui/card';

export default function ProjectsPage() {
  const result = readRegistry();

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            The complete UHS project portfolio, from the versioned registry.
          </p>
        </div>
        <Card>
          <CardContent className="pt-6 space-y-2">
            <p className="text-sm font-medium text-destructive">
              The project registry could not be read, so this page is showing nothing rather
              than guessing.
            </p>
            <p className="text-sm text-muted-foreground">{result.error}</p>
            <p className="text-xs text-muted-foreground font-mono break-all">{result.path}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <ProjectsView registry={result.registry} />;
}
