/**
 * JARVIS Mobile PWA — UI regression suite (MOD #25 verification)
 *
 * Tests the voice-first PWA surface at /jarvis prior to human testing:
 *   A. PWA shell    — manifest, service worker, icons, Apple meta
 *   B. Auth         — mobile JWT API + UI login redirect chain
 *   C. Mobile UI    — iPhone viewport render, seams, tap targets, no errors
 *   D. Voice loop   — micless drive via synth seams (MOD #24 queue/turn-id)
 *   E. Desktop      — regression at 1440x900
 *
 * Run:  DASHBOARD_URL=http://localhost:3000 npx playwright test tests/playwright/jarvis-pwa.spec.ts
 * Creds: ADMIN_USERNAME / ADMIN_PASSWORD env (falls back to dashboard/.env.local values via run script)
 *
 * Notes:
 * - jarvis-telegram may consume synth messages silently (known bus behavior),
 *   so the loop test asserts the SEND path + state transitions, not a spoken reply.
 * - __cosmosStats is the sanctioned test seam (MOD #20-#22); writes are merge-only.
 */
import { test, expect, type Page } from '@playwright/test';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

const IPHONE = { width: 390, height: 844 }; // iPhone 13/14/15 logical viewport

async function uiLogin(page: Page) {
  await page.goto(`${URL}/jarvis`);
  // Session-gated route redirects to /login when unauthenticated
  if (page.url().includes('/login')) {
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([
      page.waitForURL(/\/(jarvis|$)/, { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);
    // Some NextAuth flows land on `/` — hop to /jarvis explicitly
    if (!page.url().includes('/jarvis')) await page.goto(`${URL}/jarvis`);
  }
  await expect(page).toHaveURL(/\/jarvis/);
}

/** Collect page errors for the lifetime of a test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// A. PWA shell (no auth required)
// ---------------------------------------------------------------------------
test.describe('A. PWA shell', () => {
  test('manifest is served with JARVIS identity', async ({ request }) => {
    const res = await request.get(`${URL}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.name).toBe('JARVIS');
    expect(m.start_url).toContain('/jarvis');
    expect(m.display).toBe('standalone');
    expect((m.theme_color || '').toLowerCase()).toBe('#2d2928');
    const sizes = (m.icons || []).map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  });

  test('manifest icons actually resolve as images', async ({ request }) => {
    const m = await (await request.get(`${URL}/manifest.webmanifest`)).json();
    for (const icon of m.icons || []) {
      const res = await request.get(`${URL}${icon.src.startsWith('/') ? '' : '/'}${icon.src}`);
      expect(res.status(), `icon ${icon.src}`).toBe(200);
      expect(res.headers()['content-type'], `icon ${icon.src}`).toContain('image');
    }
  });

  test('service worker script is served', async ({ request }) => {
    const res = await request.get(`${URL}/sw.js`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
    // network-only for API calls is a hard requirement (SSE/auth must never be cached)
    expect(body).toContain('/api/');
  });

  test('apple-touch-icon resolves', async ({ request }) => {
    const res = await request.get(`${URL}/apple-touch-icon.png`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image');
  });
});

// ---------------------------------------------------------------------------
// B. Auth
// ---------------------------------------------------------------------------
test.describe('B. Auth', () => {
  test('mobile JWT API issues a token with valid creds', async ({ request }) => {
    const res = await request.post(`${URL}/api/auth/mobile`, {
      data: { username: USER, password: PASS },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^ey[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('UI login redirect chain returns to /jarvis (mobile viewport)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: IPHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await uiLogin(page);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// C + D. Mobile UI and micless voice loop (one authed mobile context)
// ---------------------------------------------------------------------------
test.describe('C/D. Mobile Cosmos UI', () => {
  test('renders on iPhone viewport with seams, no page errors, MOD #24 stats', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: IPHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = trackErrors(page);

    await uiLogin(page);

    // Orb canvas mounts (R3F is dynamic/ssr:false — allow time)
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });

    // Test seams exist
    const stats = await page.waitForFunction(() => (window as any).__cosmosStats, null, {
      timeout: 20_000,
    });
    expect(stats).toBeTruthy();
    await expect(page.locator('[data-testid="synth-transcript"]')).toBeAttached();
    await expect(page.locator('[data-testid="synth-send"]')).toBeAttached();

    // Viewport meta honors the notch (viewport-fit=cover)
    const viewportMeta = await page
      .locator('meta[name="viewport"]')
      .first()
      .getAttribute('content');
    expect(viewportMeta || '').toContain('viewport-fit=cover');

    // Mic control is tap-friendly (>=44px per Apple HIG). The mic button is the
    // primary interactive control on the page; find it by role/aria first.
    // NOTE: match by testid only — aria-label toggles to "Stop listening" while
    // active, and a loose *="voice" match hits the MUTE button ("Mute JARVIS voice").
    const mic = page.locator('[data-testid="cosmos-mic"]');
    if (await mic.count()) {
      const box = await mic.boundingBox();
      expect(box, 'mic button bounding box').toBeTruthy();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    }

    // MOD #24 seams present on stats object
    const statKeys = await page.evaluate(() => Object.keys((window as any).__cosmosStats ?? {}));
    expect(statKeys).toEqual(expect.arrayContaining(['baseTurnId', 'ttsQueueDepth']));

    // Filter benign dev-mode noise (React devtools hints, favicon 404s in dev)
    const real = errors.filter(
      (e) => !/favicon|Download the React DevTools|hydrat/i.test(e),
    );
    expect(real, `page errors:\n${real.join('\n')}`).toHaveLength(0);

    await ctx.close();
  });

  test('micless voice loop: synth send posts to bus and advances state + turn id', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: IPHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await uiLogin(page);
    await page.waitForFunction(() => (window as any).__cosmosStats, null, { timeout: 20_000 });

    const turn0 = await page.evaluate(() => (window as any).__cosmosStats?.baseTurnId ?? 0);

    // Drive the loop through the sanctioned seams
    await page.fill('[data-testid="synth-transcript"]', 'Test ping from the PWA regression suite — no reply needed.');
    const [sendRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/messages/send'), { timeout: 15_000 }),
      page.click('[data-testid="synth-send"]'),
    ]);
    expect(sendRes.status()).toBe(200);

    // Voice state leaves idle (listening/processing/responding are all acceptable
    // since reply timing is nondeterministic)
    await page.waitForFunction(
      () => (window as any).__cosmosStats?.voiceState !== 'idle',
      null,
      { timeout: 10_000 },
    );

    // Second send bumps the turn id (barge-in bookkeeping, MOD #24)
    await page.fill('[data-testid="synth-transcript"]', 'Second ping — checking turn id increments.');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/messages/send'), { timeout: 15_000 }),
      page.click('[data-testid="synth-send"]'),
    ]);
    await page.waitForFunction(
      (prev) => ((window as any).__cosmosStats?.baseTurnId ?? 0) > prev,
      turn0,
      { timeout: 10_000 },
    );

    await ctx.close();
  });
});

// ---------------------------------------------------------------------------
// E. Desktop regression
// ---------------------------------------------------------------------------
test.describe('E. Desktop regression', () => {
  test('desktop /jarvis still renders clean at 1440x900', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    await uiLogin(page);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => (window as any).__cosmosStats, null, { timeout: 20_000 });
    const real = errors.filter(
      (e) => !/favicon|Download the React DevTools|hydrat/i.test(e),
    );
    expect(real, `page errors:\n${real.join('\n')}`).toHaveLength(0);
    await ctx.close();
  });
});
