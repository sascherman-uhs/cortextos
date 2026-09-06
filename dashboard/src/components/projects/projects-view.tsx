'use client';

/**
 * OS-05 — Projects view.
 *
 * Renders the portfolio-v1 registry. Everything shown here comes from the
 * registry payload; this component computes no facts of its own beyond
 * grouping and filtering, so the page and the registry can never disagree.
 */
import { useMemo, useState } from 'react';
import {
  coverageSummary,
  groupByClassification,
  isSoftwareProject,
  ownerLabel,
  type ProjectRegistry,
  type RegistryProject,
} from '@/lib/project-registry-view';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

const CLASSIFICATION_ORDER = ['active', 'paused', 'reserved', 'archived', 'out-of-scope'];

function classificationTone(c: string): string {
  switch (c) {
    case 'active':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
    case 'paused':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
    case 'reserved':
      return 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30';
    case 'archived':
      return 'bg-muted text-muted-foreground border-border';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ProjectCard({ p }: { p: RegistryProject }) {
  const dep = p.deployment || {};
  const runtime = p.observed.runtime || [];
  const last = p.observed.last_verified_change || {};
  const isSoftware = isSoftwareProject(p);
  const owner = ownerLabel(p);

  return (
    <Card data-testid={`project-${p.id}`} className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base font-semibold">{p.id}</CardTitle>
          <Badge variant="outline" className={classificationTone(p.classification)}>
            {p.classification}
          </Badge>
          <Badge variant="outline">{isSoftware ? 'software project' : 'workspace'}</Badge>
          {p.health.status !== 'ok' && (
            <Badge variant="outline" className="bg-amber-500/15 text-amber-600 border-amber-500/30">
              needs attention
            </Badge>
          )}
        </div>
        {p.purpose && <p className="text-sm text-muted-foreground mt-1">{p.purpose}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {p.business_outcome && (
          <p className="text-sm">
            <span className="text-muted-foreground">Outcome it serves. </span>
            {p.business_outcome}
          </p>
        )}
        <dl className="space-y-1.5">
          <Field label="Owner">
            {owner.unknown ? (
              <span className="text-destructive font-medium">{owner.text}</span>
            ) : (
              owner.text
            )}
            <span className="text-muted-foreground">
              {' · agent role: '}
              {p.owner_agent_role || 'unassigned'}
            </span>
          </Field>
          <Field label="Lifecycle">{p.lifecycle}</Field>
          <Field label="Runtime">
            {runtime.length > 0 ? (
              runtime.map((r) => (
                <span key={r.pm2_name + r.port} className="mr-3 font-mono text-xs">
                  {r.pm2_name} :{r.port}
                  {r.matched !== 'exact' ? ` (${r.matched})` : ''}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">no local runtime</span>
            )}
          </Field>
          <Field label="Deployment">
            {dep.url ? (
              <a
                href={dep.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2 break-all"
              >
                {dep.url}
              </a>
            ) : (
              <span className="text-muted-foreground">{dep.kind || 'none'}</span>
            )}
            {dep.source && (
              <div className="text-xs text-muted-foreground mt-0.5">from {dep.source}</div>
            )}
          </Field>
          <Field label="Repository">
            {p.repo ? (
              <a
                href={p.repo}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2 break-all"
              >
                {p.repo}
              </a>
            ) : (
              <span className="text-amber-600">not under version control</span>
            )}
          </Field>
          <Field label="Workspace">
            <span className="font-mono text-xs break-all">{p.workspace}</span>
          </Field>
          <Field label="Depends on">
            {(p.depends_on || []).length ? p.depends_on.join(', ') : null}
          </Field>
          <Field label="Datastores">
            {(p.datastores || []).length ? (
              <span className="text-xs">{p.datastores.join(' · ')}</span>
            ) : null}
          </Field>
          <Field label="Last shipped">
            {last.date ? (
              <>
                <span className="font-mono text-xs">{last.date}</span>{' '}
                <span className="text-muted-foreground">{last.subject}</span>
              </>
            ) : (
              <span className="text-muted-foreground">no commit history</span>
            )}
          </Field>
          <Field label="Current milestone">{p.active_plan}</Field>
          <Field label="Backlog">
            {(p.backlog_links || []).length ? p.backlog_links.join(', ') : null}
          </Field>
          <Field label="Docs">{(p.docs_roots || []).join(', ')}</Field>
          <Field label="Permissions">{p.permissions}</Field>
          <Field label="Reviewed">
            <span className="text-xs">
              {p.reviewer} on {p.review_date} — {p.classification_reason}
            </span>
          </Field>
        </dl>

        {Object.keys(p.commands || {}).length > 0 && (
          <div>
            <Separator className="my-2" />
            <p className="text-xs text-muted-foreground mb-1">Commands</p>
            <ul className="space-y-1">
              {Object.entries(p.commands).map(([k, v]) => (
                <li key={k} className="text-xs">
                  <span className="text-muted-foreground">{k}: </span>
                  <code className="font-mono break-all">{v}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(p.health.notes.length > 0 || (p.operational_risks || []).length > 0) && (
          <div>
            <Separator className="my-2" />
            <p className="text-xs text-muted-foreground mb-1">Open risks</p>
            <ul className="list-disc pl-4 space-y-1 text-xs">
              {p.health.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {(p.operational_risks || []).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ProjectsView({ registry }: { registry: ProjectRegistry }) {
  const [filter, setFilter] = useState<string>('all');

  const grouped = useMemo(() => groupByClassification(registry.projects), [registry.projects]);
  const coverage = coverageSummary(registry);

  const shown = filter === 'all' ? registry.projects : grouped[filter] || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The UHS portfolio from registry <code className="font-mono">{registry.inventory_release}</code>,
          built {registry.built_at}. Software projects and working workspaces only — staging jobs
          are business work and live in the queue.
        </p>
      </div>

      <Card data-testid="coverage-banner">
        <CardContent className="pt-6 space-y-2">
          {coverage.claimsComplete ? (
            <p className="text-sm">
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                Coverage complete.
              </span>{' '}
              Every workspace discovery found has been classified by a reviewer.
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-destructive">
                Coverage incomplete — this registry cannot claim to list everything UHS runs.
              </p>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {coverage.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => setFilter('all')}
              className={`text-xs rounded-full border px-3 py-1 ${
                filter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-background'
              }`}
            >
              all {registry.project_count}
            </button>
            {CLASSIFICATION_ORDER.filter((c) => grouped[c]?.length).map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`text-xs rounded-full border px-3 py-1 ${
                  filter === c ? 'bg-primary text-primary-foreground' : 'bg-background'
                }`}
              >
                {c} {grouped[c].length}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {registry.coverage_exceptions.length > 0 && (
        <Card data-testid="coverage-exceptions">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Coverage exceptions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {registry.coverage_exceptions.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{e.id}</span>{' '}
                  <Badge variant="outline" className="text-xs">
                    {e.kind}
                  </Badge>
                  <div className="text-muted-foreground text-xs mt-0.5">{e.detail}</div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {registry.remediation_items.length > 0 && (
        <Card data-testid="remediation-items">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Remediation items</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {registry.remediation_items.map((r, i) => (
                <li key={`${r.id}-${i}`}>
                  <span className="font-medium">{r.id}</span> — {r.item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {shown.map((p) => (
          <ProjectCard key={p.id} p={p} />
        ))}
      </div>

      {(registry.open_questions_for_scott || []).length > 0 && (
        <Card data-testid="open-questions">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Open questions for Scott</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {registry.open_questions_for_scott!.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
