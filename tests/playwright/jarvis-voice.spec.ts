/**
 * JARVIS open-mic voice pipeline — wake gate / follow-up / sign-off (MOD #36)
 *
 * Drives the SPOKEN-utterance path miclessly via window.__cosmosVoiceTest
 * (real mic remains manual-only — MOD #21 lore). Asserts the deterministic
 * turn-taking rules from voice-turn.ts end-to-end in the running app:
 *   F1. non-wake ambient speech is discarded (no bus send)
 *   F2. wake-prefixed utterance sends, with the wake prefix stripped
 *   F3. bare "hey jarvis" opens the follow-up window; next bare utterance sends
 *   F4. natural goodbye → signoff decision, NO bus send
 *   F5. goodbye veto (question after thanks) → still sends
 *
 * === JARVIS MOD #107 (2026-08-09): THIS SPEC IS LEGACY-LANE ONLY. ===
 * Everything below asserts on `__cosmosStats.wakeGate`, which only the legacy
 * open-mic engine (use-voice) ever writes — the Realtime lanes have no wake
 * gate at all, because server VAD does the turn-taking.
 *
 * Until MOD #107 both hooks were mounted LIVE at once, so these tests passed on
 * every lane — but on the Realtime lanes they were driving a hook whose log is
 * never rendered and whose sends were a duplicate shadow conversation. They were
 * green against something the user never sees. Phase −1 killed the second
 * engine, which correctly makes these unrunnable on any lane but 'legacy'; they
 * now self-skip rather than fail, and the coverage is real wherever it runs.
 *
 * Run:  # in dashboard/.env.local set NEXT_PUBLIC_CTX_VOICE_ENGINE=legacy, then
 *       DASHBOARD_URL=http://localhost:3000 npx playwright test tests/playwright/jarvis-voice.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

async function uiLogin(page: Page) {
  await page.goto(`${URL}/jarvis`);
  if (page.url().includes('/login')) {
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([
      page.waitForURL(/\/(jarvis|$)/, { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);
    if (!page.url().includes('/jarvis')) await page.goto(`${URL}/jarvis`);
  }
  await expect(page).toHaveURL(/\/jarvis/);
  await page.waitForFunction(() => (window as any).__cosmosVoiceTest, null, {
    timeout: 20_000,
  });
  // === MOD #107: lane guard. The mic-debug line is the one place the running
  // engine is readable from the DOM ("v107 · <engine> · …"). Skipping is the
  // honest outcome on a non-legacy lane — the wake gate is not merely failing
  // there, it does not exist there.
  const debug = (await page.getByTestId('mic-debug').textContent()) ?? '';
  test.skip(
    !/·\s*legacy\s*·/.test(debug),
    `wake-gate spec requires NEXT_PUBLIC_CTX_VOICE_ENGINE=legacy (running: ${debug.trim() || 'unknown'})`,
  );
}

/** Counts /api/messages/send POSTs for the page's lifetime. */
function trackSends(page: Page): { count: () => number; bodies: string[] } {
  const bodies: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/messages/send') && req.method() === 'POST') {
      bodies.push(req.postData() ?? '');
    }
  });
  return { count: () => bodies.length, bodies };
}

function utter(page: Page, text: string) {
  return page.evaluate((t) => (window as any).__cosmosVoiceTest.utterance(t), text);
}
function agentReply(page: Page, text: string) {
  return page.evaluate((t) => (window as any).__cosmosVoiceTest.agentReply(t), text);
}
function gate(page: Page) {
  return page.evaluate(() => (window as any).__cosmosStats?.wakeGate);
}

test.describe('F. Open-mic wake gate (micless seam)', () => {
  test('F1: ambient speech without wake word is discarded, no bus send', async ({ page }) => {
    await uiLogin(page);
    const sends = trackSends(page);
    await utter(page, "so anyway the install crew gets there around nine");
    await page.waitForFunction(
      () => (window as any).__cosmosStats?.wakeGate?.lastDecision === 'discarded',
      null,
      { timeout: 5_000 },
    );
    await page.waitForTimeout(1_000); // give a wrong send time to appear
    expect(sends.count()).toBe(0);
    expect((await gate(page)).discarded).toBeGreaterThanOrEqual(1);
  });

  test('F2: wake-prefixed utterance sends with the prefix stripped', async ({ page }) => {
    await uiLogin(page);
    const sends = trackSends(page);
    await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes('/api/messages/send') && r.method() === 'POST',
        { timeout: 10_000 },
      ),
      utter(page, 'Hey Jarvis, test ping from the voice regression suite, no reply needed.'),
    ]);
    expect(sends.bodies[0]).toContain('test ping from the voice regression suite');
    expect(sends.bodies[0].toLowerCase()).not.toContain('hey jarvis');
    expect((await gate(page)).lastDecision).toBe('accepted');
  });

  test('F3: bare wake opens follow-up window; next bare utterance sends', async ({ page }) => {
    await uiLogin(page);
    const sends = trackSends(page);
    await utter(page, 'hey jarvis');
    await page.waitForFunction(
      () => (window as any).__cosmosStats?.wakeGate?.lastDecision === 'wake-only',
      null,
      { timeout: 5_000 },
    );
    // Inside the follow-up window a bare utterance needs no wake word.
    await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes('/api/messages/send') && r.method() === 'POST',
        { timeout: 10_000 },
      ),
      utter(page, 'follow-up ping from the regression suite, no reply needed'),
    ]);
    expect(sends.count()).toBe(1);
    expect((await gate(page)).lastDecision).toBe('accepted');
  });

  test('F4: natural goodbye is a signoff — no bus send, no last word', async ({ page }) => {
    await uiLogin(page);
    const sends = trackSends(page);
    await agentReply(page, 'The calendar is clear until two, sir.'); // arms hadAgentTurn
    await utter(page, "jarvis thanks, that's all");
    await page.waitForFunction(
      () => (window as any).__cosmosStats?.wakeGate?.lastDecision === 'signoff',
      null,
      { timeout: 5_000 },
    );
    await page.waitForTimeout(1_000);
    expect(sends.count()).toBe(0);
  });

  test('F5: goodbye veto — thanks followed by a question still sends', async ({ page }) => {
    await uiLogin(page);
    const sends = trackSends(page);
    await agentReply(page, 'Done, sir.');
    await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes('/api/messages/send') && r.method() === 'POST',
        { timeout: 10_000 },
      ),
      utter(page, 'jarvis thanks, but can you also check the calendar? no reply needed, regression test'),
    ]);
    expect(sends.count()).toBe(1);
    expect((await gate(page)).lastDecision).toBe('accepted');
  });
});
