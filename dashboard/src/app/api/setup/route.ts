// First-run setup probe. The login page fetches this on mount to decide
// whether to redirect to an onboarding flow when no admin account exists yet.
// The route was missing, so every login logged a 404 for /api/setup (the
// fetch failure was swallowed by the page's .catch, but the browser still
// surfaced a console error). Admin credentials are provisioned via env
// (ADMIN_USERNAME / ADMIN_PASSWORD in dashboard.env), so setup is "needed"
// only when no admin username is configured.
export const dynamic = 'force-dynamic';

export async function GET() {
  const adminConfigured = Boolean(process.env.ADMIN_USERNAME);
  return Response.json({ needsSetup: !adminConfigured });
}
