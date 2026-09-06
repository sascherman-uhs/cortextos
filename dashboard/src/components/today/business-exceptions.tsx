// === OS-03 — Business exceptions, including source freshness ===
// New file; never overwritten by upstream merges.

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { BusinessExceptionsSection, ExceptionItem } from '@/lib/os03/today-view';

const CATEGORY_LABEL: Record<ExceptionItem['category'], string> = {
  obligation: 'Business obligation',
  ownership: 'No accountable owner',
  source_freshness: 'Source freshness',
};

export function BusinessExceptions({ section }: { section: BusinessExceptionsSection }) {
  return (
    <Card data-testid="business-exceptions">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Business exceptions
        </CardTitle>
        {section.count > 0 && <Badge variant="destructive">{section.count}</Badge>}
      </CardHeader>
      <CardContent>
        {section.items.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">{section.emptyLabel}</p>
        ) : (
          <ul className="space-y-1.5">
            {section.items.map((item) => (
              <li
                key={item.id}
                className="rounded-md border px-3 py-2 space-y-1"
                data-testid="exception-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">{item.title}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {CATEGORY_LABEL[item.category]}
                  </Badge>
                </div>
                {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {item.nextAction && <span>Next: {item.nextAction}</span>}
                  {item.href && (
                    <Link href={item.href} className="underline underline-offset-2">
                      Open
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
