// fix5 — who a transition is recorded against.
//
// The contract asks for a NAMED person wherever a human's judgement is what
// authorises something: a verifier at completion, and now the actor on a waiver
// that advances legacy work without its acceptance criteria. 'dashboard' names a
// program, not a person, so a route that cannot resolve a real name has to know
// that and refuse rather than sign the decision on someone's behalf.
//
// The auth module is loaded dynamically on purpose. NextAuth pulls in Next's
// server runtime at import time, which a route-level unit test cannot resolve;
// a static import would mean the contract's actor rule could not be tested at
// all. Failing to load resolves to "no signed-in person", which is the same
// answer as an anonymous request and is handled the same way.

/** A person's name reduced to something safe to record as an actor and pass as
 *  a positional CLI argument. Undefined when there is nothing usable. */
export function sanitizeActor(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : undefined;
}

/** The signed-in person, or undefined. Never throws. */
export async function signedInActor(): Promise<string | undefined> {
  try {
    const { auth } = await import('@/lib/auth');
    const session = await auth();
    return sanitizeActor(session?.user?.name);
  } catch {
    return undefined;
  }
}
