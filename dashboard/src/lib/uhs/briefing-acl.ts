// === OS-04b — who may view whose briefing ===
//
// New file; never overwritten by upstream merges.
//
// The dashboard serves one briefing record to three people. Two separate questions have
// to be answered before any of it reaches a browser, and conflating them is how leaks
// happen:
//
//   1. WHICH PERSON may this signed-in viewer look at?   -> viewerPersons()
//   2. WHICH FACETS may that person see?                 -> the visible_to stamp the
//      composer wrote into each facet (permittedFacets)
//
// Both are enforced on the server. The person switcher in the UI is a convenience over
// the answer to (1); it is never the thing that decides it.
//
// Scott may view the personas' BUSINESS scope, because he runs the business. He does not
// get their private content: Angelic's inbox facet is stamped visible_to ["angelic"] and
// stays invisible to him in every format, cached or fresh.
// === END header ===

export const KNOWN_PERSONS = ['scott', 'raquel', 'angelic'] as const;
export type Person = (typeof KNOWN_PERSONS)[number];

export function isPerson(value: string): value is Person {
  return (KNOWN_PERSONS as readonly string[]).includes(value);
}

/**
 * Default viewer -> persons map. Keys are lowercased usernames from the dashboard's own
 * users table (NextAuth's credentials provider puts the username in session.user.name).
 *
 * Override with BRIEFING_VIEWERS, e.g.
 *   BRIEFING_VIEWERS='{"raquel@utopiahomestaging.com":["raquel"]}'
 * The override REPLACES an entry, so a mapping can be narrowed without a code change.
 */
const DEFAULT_VIEWERS: Record<string, Person[]> = {
  'scott@utopiahomestaging.com': ['scott', 'raquel', 'angelic'],
  scott: ['scott', 'raquel', 'angelic'],
  admin: ['scott', 'raquel', 'angelic'],
  'ange@utopiahomestaging.com': ['angelic'],
  angelic: ['angelic'],
  raquel: ['raquel'],
};

function configuredViewers(): Record<string, Person[]> {
  const raw = process.env.BRIEFING_VIEWERS;
  if (!raw) return DEFAULT_VIEWERS;
  try {
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const out: Record<string, Person[]> = { ...DEFAULT_VIEWERS };
    for (const [user, persons] of Object.entries(parsed)) {
      out[user.toLowerCase()] = persons.filter(isPerson);
    }
    return out;
  } catch {
    // A malformed override must not silently widen access, so the defaults stand and the
    // problem is loud in the server log rather than invisible in the ACL.
    console.error('[briefing-acl] BRIEFING_VIEWERS is not valid JSON — using defaults');
    return DEFAULT_VIEWERS;
  }
}

/**
 * Persons this signed-in user may view, most-relevant first.
 *
 * Fails CLOSED: an unrecognised username gets an empty list, not a default view. Adding
 * a dashboard user is therefore an explicit decision about what they can read.
 */
export function viewerPersons(username: string | null | undefined): Person[] {
  if (!username) return [];
  return configuredViewers()[username.trim().toLowerCase()] ?? [];
}

export function canViewPerson(username: string | null | undefined, person: string): boolean {
  return isPerson(person) && viewerPersons(username).includes(person);
}

/** The person a viewer lands on when they do not ask for one. */
export function defaultPersonFor(username: string | null | undefined): Person | null {
  return viewerPersons(username)[0] ?? null;
}

export const PERSON_LABEL: Record<Person, string> = {
  scott: 'Scott',
  raquel: 'Raquel',
  angelic: 'Angelic',
};

export const PERSON_AGENT: Record<Person, string> = {
  scott: 'JARVIS',
  raquel: 'Vera',
  angelic: 'Vivienne',
};
