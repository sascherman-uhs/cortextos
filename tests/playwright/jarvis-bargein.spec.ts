/**
 * JARVIS barge-in — clean state on interrupt (MODs #85–#89, 2026-08-03)
 *
 * Rubric item 5: "barge-in leaves clean state". Verifies IN THE RUNNING APP the
 * parts that need a real network stack and a real event loop — the unit tests in
 * dashboard/src/components/cosmos/__tests__/turn-guard.test.ts cover the pure
 * ordering logic, but only the browser can tell us an in-flight request was
 * genuinely aborted rather than merely ignored.
 *
 * No microphone is involved (MOD #21 lore: real mic is manual-only). Interrupts
 * are driven by clicking the mic control, which is the same handler a real
 * barge-in reaches.
 *
 *   G1. barge-in aborts the in-flight /api/uhs/tts request
 *   G2. barge-in fires NO follow-on TTS request (the MOD #85 prefetch-after-
 *       interrupt bug — a superseded pipeline used to open a fresh ElevenLabs
 *       synthesis on its way out)
 *   G3. a TTS response that lands AFTER the interrupt never plays; queue depth
 *       stays 0 and the turn id does not move again
 *   G4. barge-in aborts the in-flight /api/messages/send reply stream (MOD #88 —
 *       this fetch had no AbortController at all)
 *
 * Run:  NEXT_PUBLIC_CTX_REALTIME_VOICE=0 npm run dev -- -p 3100   # legacy lane
 *       DASHBOARD_URL=http://localhost:3100 npx playwright test tests/playwright/jarvis-bargein.spec.ts
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  await page.waitForFunction(() => (window as any).__cosmosVoiceTest, null, { timeout: 20_000 });
  // TTS must be UNMUTED or speak() is a no-op and no request ever fires.
  await page.evaluate(() => window.localStorage.setItem('cosmos-tts-muted', 'false'));
  await page.reload();
  await page.waitForFunction(() => (window as any).__cosmosVoiceTest, null, { timeout: 20_000 });
  expect(await stats(page, 'ttsMuted')).toBe(false);
}

function stats(page: Page, key: string) {
  return page.evaluate((k) => (window as any).__cosmosStats?.[k], key);
}

/**
 * Start a spoken reply. Uses the "Test voice" control rather than
 * __cosmosVoiceTest.agentReply, because the log-effect path is gated on
 * sentTurnsRef (MOD #33) and would silently discard a reply with no preceding
 * user turn. This button calls speak() directly, and its click doubles as the
 * user gesture iOS-style audio unlocking wants.
 *
 * NOTE: this whole spec exercises the LEGACY voice lane (use-tts + use-voice).
 * With NEXT_PUBLIC_CTX_REALTIME_VOICE=1 the panel mounts use-realtime-voice
 * instead, which handles barge-in inside the OpenAI session and hides this
 * control — run the server with the flag off (see the header).
 */
async function startReply(page: Page) {
  await page.click('[data-testid="cosmos-voice-test"]');
}

/** Click the mic control — the same handler a spoken barge-in reaches. */
function bargeIn(page: Page) {
  return page.click('[aria-label="Start voice input"], [aria-label="Stop listening"]');
}

/**
 * Hold every /api/uhs/tts request open so an interrupt always lands while one is
 * genuinely in flight. Returns the captured routes plus a request counter.
 */
function holdTts(page: Page) {
  const held: Route[] = [];
  let requested = 0;
  const aborted: string[] = [];
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/uhs/tts')) aborted.push(req.failure()?.errorText ?? 'unknown');
  });
  void page.route('**/api/uhs/tts', (route) => {
    requested += 1;
    held.push(route); // never fulfilled until the test says so
  });
  return {
    held,
    aborted,
    count: () => requested,
    /** Answer a held request with a plausible elevenlabs response. */
    async release(i: number) {
      await held[i]
        .fulfill({
          status: 200,
          headers: { 'x-tts-path': 'elevenlabs', 'Content-Type': 'audio/mpeg' },
          body: Buffer.from('not-real-mp3-bytes'),
        })
        .catch(() => {
          /* the request may already be aborted — that is the point of G3 */
        });
    },
  };
}

test.describe('G. Barge-in leaves clean state (MODs #85–#89)', () => {
  test('G1+G2: interrupt aborts the in-flight TTS fetch and starts no new one', async ({ page }) => {
    await uiLogin(page);
    const tts = holdTts(page);

    const turnBefore = (await stats(page, 'baseTurnId')) as number;
    await startReply(page);
    await page.waitForFunction(() => (window as any).__cosmosStats?.ttsQueueDepth !== undefined);
    await expect.poll(() => tts.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const duringReply = tts.count();

    await bargeIn(page);

    // The request that was open when the user interrupted is aborted…
    await expect.poll(() => tts.aborted.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(tts.aborted[0]).toContain('ABORT');

    // …the turn advanced, and the queue is empty.
    await expect.poll(() => stats(page, 'baseTurnId')).toBeGreaterThan(turnBefore);
    expect(await stats(page, 'ttsQueueDepth')).toBe(0);

    // …and nothing new was synthesized for the abandoned turn. This is the
    // MOD #85 regression: the old ordering prefetched the next sentence AFTER
    // the abort, billing a synthesis for audio nobody would ever hear.
    await page.waitForTimeout(1500);
    expect(tts.count()).toBe(duringReply);
  });

  test('G3: a TTS response landing after the interrupt never plays', async ({ page }) => {
    await uiLogin(page);
    const tts = holdTts(page);

    await startReply(page);
    await expect.poll(() => tts.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    await bargeIn(page);
    const turnAfterInterrupt = (await stats(page, 'baseTurnId')) as number;

    // Bytes arrive for the interrupted turn AFTER the barge-in.
    await tts.release(0);
    await page.waitForTimeout(1500);

    // Nothing queued, nothing started, and no turn was opened to play them.
    expect(await stats(page, 'ttsQueueDepth')).toBe(0);
    expect(await stats(page, 'baseTurnId')).toBe(turnAfterInterrupt);
    // Late bytes must be DROPPED, not fed to the decoder — a decode attempt on
    // this fake body would surface as a playback error on the diagnostics seam.
    expect(await stats(page, 'ttsLastError')).toBeFalsy();
  });

  test('G4: interrupt aborts the in-flight reply stream', async ({ page }) => {
    await uiLogin(page);
    const abortedSends: string[] = [];
    let sendCount = 0;
    page.on('requestfailed', (req) => {
      if (req.url().includes('/api/messages/send')) {
        abortedSends.push(req.failure()?.errorText ?? 'unknown');
      }
    });
    // Hold the reply open so the interrupt lands mid-generation — exactly the
    // window where the un-abortable fetch used to keep streaming (MOD #88).
    await page.route('**/api/messages/send', () => {
      sendCount += 1;
    });

    // The interrupt here is a SECOND spoken turn rather than a mic click: while
    // state === 'processing' the mic control is disabled
    // (voice-panel.tsx:489 `disabled={!supported || state === 'processing'}`),
    // so during think-time the button is not a barge-in surface at all. Speaking
    // again is the path a real user has, and it reaches the same guard —
    // sendText()'s replyGuard.begin() supersedes the pending reply.
    await page.evaluate(() =>
      (window as any).__cosmosVoiceTest.utterance('jarvis what is on the schedule today'),
    );
    await expect.poll(() => sendCount, { timeout: 15_000 }).toBeGreaterThan(0);

    // Clear of MERGE_WINDOW_MS (1200) so this is a new turn, not an aggregation.
    await page.waitForTimeout(1800);
    await page.evaluate(() =>
      (window as any).__cosmosVoiceTest.utterance('jarvis actually never mind'),
    );

    await expect.poll(() => abortedSends.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(abortedSends[0]).toContain('ABORT');
  });
});
