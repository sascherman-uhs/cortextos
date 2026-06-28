import { getOrgs } from '@/lib/config';
import { KnowledgeBaseChecklist } from '@/components/knowledge-base/kb-checklist';

export const dynamic = 'force-dynamic';

export default function KnowledgeBaseChecklistPage() {
  const orgs = getOrgs();
  const org = orgs[0] ?? '';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">KB Checklist</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The ideal home-staging knowledge base — a reference checklist of every document a complete
          business should hold. Track what&apos;s been added and what&apos;s still outstanding.
        </p>
      </div>

      <KnowledgeBaseChecklist org={org} />
    </div>
  );
}
