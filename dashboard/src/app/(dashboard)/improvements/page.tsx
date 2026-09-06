import { getImprovementsView } from '@/lib/uhs/improvements';
import {
  CycleStrip,
  ImprovementPipeline,
} from '@/components/improvements/improvement-pipeline';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// /improvements — did the agents actually get better, and how would we know?
//
// OS-08. Two stacked answers: the weekly Kaizen cycles at the top (did the loop even
// run, and did it reach anyone), and the experiment pipeline below (what came of it,
// including what was rejected or reverted).
//
// The degraded banner is not decoration. An improvements page rendering a confident
// empty state during a Supabase outage would be a false all-clear about the exact
// system whose job is to notice false all-clears.
// ---------------------------------------------------------------------------

export default async function ImprovementsPage() {
  const view = await getImprovementsView();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Improvements</h1>
        <p className="text-sm text-muted-foreground">
          Problem → experiment → reviewed → built &amp; tested → released → measured
          outcome. Rejected and reverted changes are shown, not filtered out.
        </p>
      </div>

      {view.degraded ? (
        <Card className="border-destructive">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Showing incomplete data</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {view.degraded}. What is below may be partial — read it as unknown, not as
            an empty loop.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Weekly Kaizen cycles</CardTitle>
        </CardHeader>
        <CardContent>
          <CycleStrip cycles={view.cycles} />
        </CardContent>
      </Card>

      <ImprovementPipeline improvements={view.improvements} events={view.events} />
    </div>
  );
}
