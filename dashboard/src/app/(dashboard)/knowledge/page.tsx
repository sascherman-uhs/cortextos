import { getOrgs } from '@/lib/config';
import { KnowledgeClient } from '@/components/knowledge/knowledge-client';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  const orgs = getOrgs();
  const org = orgs[0] ?? '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One retrieval contract for the fleet CLI, this dashboard, skills and agents. Cited
          answers, last-verified timestamps, source authority, and an honest account of what
          failed to ingest, what disagrees, and what is missing.
        </p>
      </div>
      <KnowledgeClient org={org} />
    </div>
  );
}
