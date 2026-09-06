/**
 * OS-05 — Projects API. Serves the portfolio-v1 registry, read-only.
 *
 * A missing or unreadable registry returns 503 with the reason, never an empty
 * list: "no projects" and "I could not read the registry" must not look alike.
 */
import { readRegistry } from '@/lib/project-registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = readRegistry();
  if (!result.ok) {
    return Response.json({ error: result.error, path: result.path }, { status: 503 });
  }
  return Response.json(result.registry);
}
