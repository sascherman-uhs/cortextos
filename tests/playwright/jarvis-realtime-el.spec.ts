/**
 * JARVIS "Daniel" lane — engine 'realtime-el' (MOD #107, 2026-08-09)
 *
 * OpenAI Realtime for the brain, ElevenLabs for the voice. What this covers is
 * deliberately narrow: the parts that were SILENT failures on a phone, i.e. the
 * ones where everything looked healthy and nothing came out of the speaker.
 *
 *   R1. the engine is actually the one running, and the build stamp proves the
 *       PWA pulled fresh JS (iOS staleness lore — MOD #39d)
 *   R2. the remote-audio element exists AT MOUNT, is IN the DOM, and is
 *       playsInline. Before MOD #107 it was created lazily inside startSession,
 *       never attached, and had no playsInline — three separate reasons iOS
 *       refuses to play it, all invisible from the JS side.
 *   R3. the local TTS engine owns the voice on this lane, so an agent reply that
 *       did NOT come through the streaming path still gets spoken (the "Test
 *       voice" control is the visible proof the gate was rewired: under engine
 *       'realtime' it is correctly absent, under 'realtime-el' it must be back)
 *   R4. /api/uhs/tts still returns a COMPLETE mp3 body after the switch to the
 *       ElevenLabs /stream endpoint. This is the one that would break playback
 *       outright: the client decodes with decodeAudioData (MOD #28), which
 *       throws on a partial mp3.
 *   R5. a reply pushed with no pending lookup is spoken, not swallowed
 *       (critics' 3c — the late-answer path used to be text-only on this lane)
 *
 * No microphone is involved (MOD #21 lore: real mic is manual-only); the micless
 * __cosmosVoiceTest seam is the driver. Under MOD #107 that seam is owned by
 * whichever lane is ENABLED, so here it drives the Realtime hook — before the
 * mod both hooks were live and the seam could bind to the hook whose log is
 * never rendered, i.e. a test that passes against nothing.
 *
 * Run:  NEXT_PUBLIC_CTX_VOICE_ENGINE=realtime-el (the default after MOD #107)
 *       DASHBOARD_URL=http://localhost:3000 npx playwright test tests/playwright/jarvis-realtime-el.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

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
}

/** The gray diagnostics line — the only place the running engine is readable. */
async function debugLine(page: Page): Promise<string> {
  return (await page.getByTestId('mic-debug').textContent()) ?? '';
}

test.describe('MOD #107 — the Daniel lane', () => {
  test.beforeEach(async ({ page }) => {
    await uiLogin(page);
  });

  test('R1: the debug line names the running engine and a fresh build stamp', async ({ page }) => {
    await expect
      .poll(() => debugLine(page), { timeout: 10_000 })
      .toMatch(/^v107 · realtime-el /);
    const line = await debugLine(page);
    // The Realtime lanes report WebRTC vitals, not the legacy VAD numbers — a
    // row of em-dashes where 'vad' used to be is exactly the "looks dead but
    // isn't" reading MOD #107 removed.
    expect(line).toContain('rtc ');
    expect(line).toContain('dc ');
    expect(line).not.toContain('vad ');
  });

  test('R2: the remote-audio element is mounted, attached, and playsInline', async ({ page }) => {
    const info = await page.evaluate(() => {
      const el = document.querySelector<HTMLAudioElement>('[data-testid="cosmos-remote-audio"]');
      if (!el) return null;
      return {
        attached: document.body.contains(el),
        playsInline: (el as any).playsInline === true || el.hasAttribute('playsinline'),
        hasSource: !!(el.src || el.srcObject),
      };
    });
    expect(info).not.toBeNull();
    expect(info!.attached).toBe(true);
    expect(info!.playsInline).toBe(true);
    // A source is required for the gesture prime to succeed — play() on a
    // sourceless element rejects, and a rejected prime teaches iOS nothing.
    expect(info!.hasSource).toBe(true);
  });

  test('R3: local TTS owns the voice on this lane (the audio check is back)', async ({ page }) => {
    // Under engine 'realtime' this control is deliberately hidden (OpenAI owns
    // all speech — Scott's one-voice rule). Its presence here is the visible
    // proof that voice-panel's blanket `if (USE_REALTIME) return` became a
    // per-engine question.
    await expect(page.getByTestId('cosmos-voice-test')).toBeVisible();
  });

  test('R4: /api/uhs/tts returns a COMPLETE mp3 after the /stream switch', async ({ page }) => {
    const res = await page.request.post(`${URL}/api/uhs/tts`, {
      data: { text: 'Systems nominal, sir. The staging schedule is clear.' },
    });
    expect(res.status()).toBe(200);
    const path = res.headers()['x-tts-path'];
    // 'say'/'browser' mean ElevenLabs was unavailable (no key) — the streaming
    // change is untestable then, so skip rather than assert a false pass.
    test.skip(path !== 'elevenlabs', `ElevenLabs unavailable (x-tts-path=${path})`);
    const body = await res.body();
    expect(body.byteLength).toBeGreaterThan(1000);
    // A buffered mp3, not a chunked passthrough: Content-Length must be present
    // and must match, because decodeAudioData throws on a truncated frame.
    expect(Number(res.headers()['content-length'])).toBe(body.byteLength);
    // mp3 frame sync or an ID3 header — anything else is not decodable audio.
    const id3 = body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33;
    const frameSync = body[0] === 0xff && (body[1] & 0xe0) === 0xe0;
    expect(id3 || frameSync).toBe(true);
  });

  test('R5: an agent reply with no pending lookup is SPOKEN, not swallowed', async ({ page }) => {
    const ttsCalls: string[] = [];
    await page.route('**/api/uhs/tts', async (route) => {
      ttsCalls.push(route.request().url());
      // Answer with the browser tier so no ElevenLabs spend and no real audio.
      await route.fulfill({
        status: 200,
        headers: { 'x-tts-path': 'browser', 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoken: false, path: 'browser' }),
      });
    });

    await page.evaluate(() =>
      (window as any).__cosmosVoiceTest.agentReply(
        'The Ruby Sky install is confirmed for Thursday at nine.',
      ),
    );

    // It reaches the log...
    await expect(page.getByTestId('cosmos-reply').last()).toContainText('Ruby Sky');
    // ...AND the voice pipeline. Before MOD #107 this lane returned early from
    // the log-speak effect, so a late reply was logged and never heard.
    await expect.poll(() => ttsCalls.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });
});

// ===========================================================================
// MOD #107 ROUND 3 — SSE echo suppression, against a FIXTURE log.
//
// SCOPE, stated honestly (round 2 overstated this and the re-verify was right to
// call it out): these tests exercise the SSE DELIVERY + DEDUPE path only. They
// cannot reach the Realtime tool bridge — that needs an open WebRTC data
// channel, which needs a microphone, which headless Chromium does not have — so
// the utterance below falls to the HTTP send leg. The tool-leg ordering (which
// is where the round-3 fix actually lives) is covered by unit tests in
// tool-reply-reconciler.test.ts, and the live round-trip is Scott's on-device
// pass. Nothing here is evidence for the tool path.
//
// ISOLATION: `?ctxAgent=` / the localStorage override points the panel's
// history + SSE reads at a THROWAWAY agent log under CTX_ROOT. Round 2 appended
// to Scott's real jarvis-telegram log and truncated it back afterwards; that
// left no residue in the end, but "promises to tidy up" is the wrong shape, and
// reading real history made the tests depend on it (a genuine reply containing
// "Eighteen active stagings" was replayed by backfill and broke R6
// deterministically). The real log is now unreachable from this spec, and
// /api/messages/send returns 404 "Agent not found" for a non-configured agent
// anyway (send/route.ts:147-149) — so a write to the real bus is structurally
// impossible, not merely tidied up after.
// ===========================================================================
const CTX_ROOT = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`;
const FIXTURE_AGENT = 'jarvis-e2e-fixture';
const FIXTURE_DIR = path.join(CTX_ROOT, 'logs', FIXTURE_AGENT);
const FIXTURE_LOG = path.join(FIXTURE_DIR, 'outbound-messages.jsonl');

function resetFixtureLog(): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(FIXTURE_LOG, '');
}

function appendFixtureLine(entry: Record<string, unknown>): void {
  fs.appendFileSync(FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
}

/** Log in with the panel bound to the fixture agent instead of jarvis-telegram. */
async function uiLoginOnFixture(page: Page) {
  await page.addInitScript(
    ([key, agent]) => {
      window.localStorage.setItem(key, agent);
      window.localStorage.setItem('cosmos-tts-muted', 'false');
    },
    ['cosmos-voice-agent-override', FIXTURE_AGENT] as const,
  );
  await uiLogin(page);
  // Prove the override actually took, rather than assuming it did — a silently
  // ignored override would put these tests back on the real log.
  const streamedAgent = await page.evaluate(
    () => window.localStorage.getItem('cosmos-voice-agent-override'),
  );
  expect(streamedAgent).toBe(FIXTURE_AGENT);
}

test.describe('MOD #107 round 3 — SSE echo suppression (fixture log)', () => {
  test.beforeEach(() => resetFixtureLog());
  test.afterAll(() => {
    try {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('R6: an outbound line already delivered by the send response is not spoken again', async ({ page }) => {
    const REPLY = 'Eighteen active stagings right now, sir.';
    const REPLY_ID = `msg-e2e-${Date.now()}`;
    const ttsBodies: string[] = [];

    await page.route('**/api/uhs/tts', async (route) => {
      ttsBodies.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 200,
        headers: { 'x-tts-path': 'browser', 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoken: false, path: 'browser' }),
      });
    });
    // Stubbed so the test never depends on the real bus. The shape mirrors what
    // the fast lane returns: reply text AND the outbound-log id.
    await page.route('**/api/messages/send', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastpath: true, replyText: REPLY, replyId: REPLY_ID }),
      });
    });

    await uiLoginOnFixture(page);

    await page.evaluate(() =>
      (window as any).__cosmosVoiceTest.utterance('How many active stagings right now?'),
    );
    await expect.poll(() => ttsBodies.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByTestId('cosmos-reply').last()).toContainText('Eighteen active stagings');

    // The same line now arrives over the live SSE route (real file tail, fixture log).
    appendFixtureLine({
      timestamp: new Date().toISOString(),
      agent: FIXTURE_AGENT,
      text: REPLY,
      message_id: REPLY_ID,
      type: 'text',
    });

    await page.waitForTimeout(5_000);
    expect(ttsBodies.length).toBe(1); // NOT spoken a second time
    const bubbles = await page.getByTestId('cosmos-reply').allTextContents();
    expect(bubbles.filter((t) => t.includes('Eighteen active stagings'))).toHaveLength(1);
  });

  test('R7: control — an UNRELATED outbound line still surfaces', async ({ page }) => {
    // Without this, R6 would pass just as well if SSE delivery were broken.
    const OTHER = `Overnight run finished at ${Date.now()}.`;

    await page.route('**/api/uhs/tts', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'x-tts-path': 'browser', 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoken: false, path: 'browser' }),
      });
    });
    await page.route('**/api/messages/send', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastpath: true, replyText: 'Acknowledged.', replyId: `msg-ack-${Date.now()}` }),
      });
    });

    await uiLoginOnFixture(page);

    // A turn must have been sent or the seed-mode gate discards everything.
    await page.evaluate(() => (window as any).__cosmosVoiceTest.utterance('Status check.'));
    await expect(page.getByTestId('cosmos-reply').last()).toContainText('Acknowledged');

    appendFixtureLine({
      timestamp: new Date().toISOString(),
      agent: FIXTURE_AGENT,
      text: OTHER,
      message_id: `msg-unrelated-${Date.now()}`,
      type: 'text',
    });

    await expect
      .poll(async () => (await page.getByTestId('cosmos-reply').allTextContents()).join(' | '), {
        timeout: 15_000,
      })
      .toContain('Overnight run finished');
  });

  test('R8: the real jarvis-telegram log is never touched by this spec', async ({ page }) => {
    // The isolation claim, asserted rather than asserted-in-prose.
    const realLog = path.join(CTX_ROOT, 'logs', 'jarvis-telegram', 'outbound-messages.jsonl');
    const before = fs.existsSync(realLog) ? fs.statSync(realLog).size : 0;

    await page.route('**/api/uhs/tts', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'x-tts-path': 'browser', 'Content-Type': 'application/json' },
        body: JSON.stringify({ spoken: false, path: 'browser' }),
      }),
    );
    await page.route('**/api/messages/send', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fastpath: true, replyText: 'Acknowledged.', replyId: `msg-x-${Date.now()}` }),
      }),
    );

    await uiLoginOnFixture(page);
    await page.evaluate(() => (window as any).__cosmosVoiceTest.utterance('Isolation check.'));
    appendFixtureLine({
      timestamp: new Date().toISOString(),
      agent: FIXTURE_AGENT,
      text: 'fixture-only line',
      message_id: `msg-iso-${Date.now()}`,
      type: 'text',
    });
    await page.waitForTimeout(3_000);

    const after = fs.existsSync(realLog) ? fs.statSync(realLog).size : 0;
    expect(after).toBe(before);
  });
});
