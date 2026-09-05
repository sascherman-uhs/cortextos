/**
 * Agentic OS — Slice 1 live acceptance (independent verification).
 *
 * Runs against the LIVE CortexOS dashboard (default http://localhost:3000) and the
 * LIVE model registry at $CTX_ROOT/orgs/uhs/model-registry.json. Test B mutates that
 * registry and reverts itself; every reason string carries a ZZTEST marker.
 *
 * Checks (plan §3, §10 "Slice 1", §11; contract §7):
 *   A. Fleet "Model routing" table — 12 agents, role/tier, source badge, desired vs
 *      running + confidence, billing, activation, trillion-coder validation error.
 *   B. Change-model flow end to end + legacy pin interaction + revert.
 *   C. Keyboard-only dialog open/close, focus return; no horizontal scroll at
 *      390x844 and 1366x768 on /agents and /queue.
 *   D. Queue page — owner filter, Failed/Blocked recovery lanes, unassigned lane,
 *      degraded banner presence.
 *   E. /briefing — snapshot or honest "no snapshot" state; sidebar link.
 *   F. Console errors and failed requests per page.
 *   G. /api/agents/vivienne/config redaction (no cron prompts, no env, no bot token).
 *
 * Run (credentials are sourced, never printed):
 *   cd ~/agent-os-worktrees/verify-slice1/cortextos
 *   set -a; . ~/cortextos/.env.local; set +a
 *   npx playwright test tests/playwright/agentic-os-slice1.spec.ts
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

const SHOTS =
  process.env.SLICE1_SHOTS ||
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/output/2026-09-05/screenshots/slice1-ui';
mkdirSync(SHOTS, { recursive: true });

const EXPECTED_AGENTS = [
  'jarvis-telegram', 'jarvis-orchestrator', 'jarvis-heartbeat', 'tron',
  'jarvis-estimator', 'jarvis-inventory', 'jarvis-accounting', 'jarvis-mls',
  'jarvis-marketing', 'vera', 'vivienne', 'trillion-coder',
];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function uiLogin(page: Page) {
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }),
      page.click('button[type="submit"]'),
    ]);
  }
}

/** The routing table row for one agent (row header cell is the agent name). */
function routingRow(page: Page, agent: string) {
  return page.locator('table tr').filter({ has: page.locator(`th:text-is("${agent}")`) });
}

async function waitForRouting(page: Page) {
  await expect(page.getByRole('heading', { name: 'Model routing' })).toBeVisible({ timeout: 30_000 });
  // The header only names a revision once /api/model-routing has answered.
  await expect(page.getByText(/registry revision \d+/)).toBeVisible({ timeout: 60_000 });
  // Then every per-agent /api/agents/<n>/config fetch has to settle (each spawns
  // the routing CLI), so no row may still say "Loading…".
  await page.waitForFunction(
    () => {
      const tb = document.querySelector(
        'section[aria-labelledby="fleet-model-routing-heading"] tbody',
      );
      if (!tb) return false;
      const rows = tb.querySelectorAll('tr');
      return rows.length > 0 && !(tb.textContent ?? '').includes('Loading…');
    },
    null,
    { timeout: 120_000, polling: 500 },
  );
}

test.beforeEach(async ({ page }) => {
  await uiLogin(page);
});

// ---------------------------------------------------------------------------
// A. Fleet model-routing table
// ---------------------------------------------------------------------------
test('A: model routing table lists all 12 agents with routing facts', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  await shot(page, 'A-agents-model-routing');

  const section = page.locator('section[aria-labelledby="fleet-model-routing-heading"]');
  const rowTexts = await section.locator('tbody tr').allInnerTexts();
  writeFileSync(
    join(SHOTS, 'A-routing-rows.txt'),
    rowTexts.map((t) => t.replace(/\s+/g, ' ')).join('\n'),
  );

  // Every registry agent has a row. Extra rows are reported, not silently accepted:
  // the roster comes from enabled-agents.json, which can name an agent that has no
  // config and no registry role.
  const extras = rowTexts
    .map((t) => t.split(/[\t\n]/)[0].trim())
    .filter((n) => n && !EXPECTED_AGENTS.includes(n));
  expect.soft(extras, `roster rows with no registry entry: ${extras.join(', ')}`).toHaveLength(0);

  for (const agent of EXPECTED_AGENTS) {
    const row = routingRow(page, agent);
    await expect(row, `row for ${agent}`).toHaveCount(1);
    const roleTier = (await row.locator('td').first().innerText()).trim();
    expect(roleTier, `${agent} role/tier`).not.toBe('— / —');
    await expect(row.getByText(/verified|unconfirmed|mismatch/).first()).toBeVisible();
    await expect(row.getByText(/Shadow|Enforced/).first()).toBeVisible();
  }

  // Eleven legacy-migration pins must read as "Pinned".
  const pinned = await section.getByText('Pinned', { exact: true }).count();
  expect(pinned, 'agents showing a Pinned source badge').toBeGreaterThanOrEqual(11);

  // Every registry agent must show a resolved desired model, billing mode and cost
  // class. A row that reads "Unresolved / — → unknown" is a broken row, not a fact.
  for (const agent of EXPECTED_AGENTS) {
    const row = routingRow(page, agent);
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    expect.soft(text, `${agent} must resolve a desired model`).not.toContain('Unresolved');
    expect.soft(text, `${agent} must show a billing mode`).not.toContain('billing —');
    expect.soft(text, `${agent} must show a cost class`).not.toContain('cost —');
  }

  // "Desired vs running" is only meaningful if the observed model reaches the UI.
  // The daemon records verified observations in
  // orgs/uhs/model-events/attempts/*.json, but `model resolve` carries no
  // `observed` field, so every row can only ever read "unconfirmed".
  const allRows = (await section.locator('tbody').innerText()).replace(/\s+/g, ' ');
  expect
    .soft(allRows, 'at least one agent shows an observed/verified running model')
    .toMatch(/verified|mismatch/);

  // trillion-coder's proposed-invalid pin must be shown as the actual validation
  // error, not as a raw CLI exit status.
  const tc = routingRow(page, 'trillion-coder');
  const tcText = (await tc.innerText()).replace(/\s+/g, ' ');
  writeFileSync(join(SHOTS, 'A-trillion-coder-validation.txt'), tcText);
  await tc.scrollIntoViewIfNeeded();
  await shot(page, 'A-trillion-coder-invalid-pair');
  expect(tcText, 'trillion-coder shows its validation error, not a CLI exit code')
    .toMatch(/pin_not_dispatchable|proposed-invalid|awaiting human remediation/);
});

// ---------------------------------------------------------------------------
// B. Change model → legacy pin → revert, on the live registry
// ---------------------------------------------------------------------------
test('B: role-tier switch and revert on the live registry', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const evidence: Record<string, unknown> = {};
  const row = () => routingRow(page, 'jarvis-mls');
  const rowText = async () => (await row().innerText()).replace(/\s+/g, ' ');
  const receipt = page.locator('[role="status"]').first();

  /** Wait until the receipt panel shows an operation id that is not `previous`. */
  const newOperationId = async (previous: string | null) => {
    await expect(receipt).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, {
        timeout: 120_000,
      })
      .not.toBe(previous);
    return (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;
  };

  evidence.before_row = await rowText();
  expect(evidence.before_row as string, 'jarvis-mls starts pinned on the economy tier')
    .toContain('listing_intel / economy');

  // --- open the dialog on jarvis-mls (role listing_intel) --------------------
  await row().getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Role tier \(listing_intel\)/)).toBeVisible();

  // Contract §7 lists "Clear legacy pin" as a dialog action. It is only a row
  // action today, so the operator changing a tier is not offered the one control
  // that makes the change reach a pinned agent.
  evidence.clear_legacy_pin_in_dialog =
    (await dialog.getByRole('button', { name: /clear legacy pin/i }).count()) > 0;
  expect
    .soft(evidence.clear_legacy_pin_in_dialog, 'dialog offers "Clear legacy pin" (contract §7)')
    .toBe(true);

  await dialog.getByRole('radio', { name: /Role tier/ }).check();
  await dialog.locator('#change-model-tier').selectOption('standard');
  await dialog.locator('#change-model-reason').fill('ZZTEST-pw-verify-1');

  const preview = dialog.getByRole('group', { name: 'Change preview' });
  await expect(preview).toBeVisible();
  evidence.preview = (await preview.innerText()).replace(/\s+/g, ' ');
  const previewText = evidence.preview as string;
  expect(previewText, 'preview names the affected agents').toMatch(/Affects \d+ agent/);
  expect(previewText, 'preview states the cost-class change').toMatch(/[Cc]ost class/);
  expect(previewText, 'preview states the billing mode').toMatch(/[Bb]illing mode/);
  expect(previewText, 'preview states a restart consequence').toMatch(/restart/i);
  // The pin is what stops this change reaching the agent; the preview must say so.
  expect(previewText, 'preview warns that a pinned agent is unaffected').toMatch(/pinned/i);
  await shot(page, 'B1-dialog-preview');

  await dialog.getByRole('button', { name: 'Submit change' }).click();

  // --- receipt ---------------------------------------------------------------
  const opSwitch = await newOperationId(null);
  evidence.operation_id_switch = opSwitch;
  expect(opSwitch, 'switch operation id on the receipt').toBeTruthy();
  const receiptText = await receipt.innerText();
  evidence.receipt_switch = receiptText.replace(/\s+/g, ' ');
  expect(receiptText, 'receipt states progress through the operation states')
    .toMatch(/Step \d+ of \d+|Off the normal path/);
  // A receipt must not narrate work it did not do. This preview said nothing would
  // restart, so an "agents restarted" line is a false claim.
  if (/No agents will be restarted/i.test(previewText)) {
    expect
      .soft(receiptText, 'receipt claims restarts the preview said would not happen')
      .not.toMatch(/restarted/i);
  }
  await shot(page, 'B2-receipt-switch');

  await waitForRouting(page);
  evidence.after_switch_row = await rowText();
  // Plan §11 "Role change obscured by migration pins": the role moved to standard,
  // but jarvis-mls keeps its legacy pin, so its effective model must NOT change and
  // the UI must still show the pin as the effective source.
  expect(evidence.after_switch_row as string, 'role tier moved to standard')
    .toContain('listing_intel / standard');
  expect(evidence.after_switch_row as string, 'the legacy pin still governs the agent')
    .toContain('Pinned');
  expect(evidence.after_switch_row as string, 'the running model is unchanged')
    .toContain('claude-haiku-4-5-20251001');

  // "Clear legacy pin" exists as a row action. It is deliberately NOT exercised
  // here: `cortextos model revert` refuses to revert a pin/unpin operation
  // ("Reverting a pin requires `cortextos model pin/unpin --agent`"), so clearing a
  // legacy pin is one-way through the supported verbs and a repeatable test must
  // not leave the live registry in a state it cannot restore.
  evidence.clear_legacy_pin_in_row =
    (await row().getByRole('button', { name: 'Clear legacy pin' }).count()) > 0;
  expect(evidence.clear_legacy_pin_in_row, 'row offers "Clear legacy pin"').toBe(true);

  // --- revert via the receipt ------------------------------------------------
  const revertBtn = receipt.getByRole('button', { name: 'Revert' });
  await expect(revertBtn, 'the receipt offers Revert').toBeEnabled();
  // The button hard-codes its own reason, so no ZZTEST marker can be attached to a
  // UI revert. Recorded, then the revert is driven through the same PATCH door the
  // button uses so the operation carries a marker.
  evidence.ui_revert_reason_is_fixed = true;

  const res = await page.request.patch(`${URL}/api/agents/jarvis-mls/config`, {
    data: {
      op: 'model_routing',
      action: 'revert',
      operation_id: opSwitch,
      reason: 'ZZTEST-pw-verify-1-revert',
    },
  });
  evidence.revert_status = res.status();
  evidence.revert_body = await res.text();
  expect(res.status(), 'revert accepted').toBe(200);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  evidence.final_row = await rowText();
  await shot(page, 'B3-after-revert');
  writeFileSync(join(SHOTS, 'B-evidence.json'), JSON.stringify(evidence, null, 2));

  // Back exactly where it started.
  expect(evidence.final_row as string, 'listing_intel back on economy')
    .toContain('listing_intel / economy');
  expect(evidence.final_row as string, 'jarvis-mls still on its legacy pin').toContain('Pinned');
  expect(evidence.final_row as string).toContain('claude-haiku-4-5-20251001');
});

// ---------------------------------------------------------------------------
// C. Accessibility and responsive layout
// ---------------------------------------------------------------------------
test('C: dialog is keyboard operable and no page scrolls horizontally', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  // Keyboard-only open: focus the row's "Change model" button, press Enter.
  const trigger = routingRow(page, 'jarvis-mls').getByRole('button', { name: 'Change model' });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shot(page, 'C1-dialog-keyboard-open');

  // Tab moves focus INSIDE the dialog.
  await page.keyboard.press('Tab');
  const inDialog = await dialog.evaluate((d) => d.contains(document.activeElement));
  expect(inDialog, 'focus is trapped inside the dialog after Tab').toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger, 'focus returns to the trigger after Escape').toBeFocused();
  await shot(page, 'C2-focus-returned');

  for (const [w, h] of [[390, 844], [1366, 768]] as const) {
    for (const path of ['/agents', '/queue']) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${URL}${path}`, { waitUntil: 'domcontentloaded' });
      if (path === '/agents') await waitForRouting(page);
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      await shot(page, `C3${path.replace('/', '-')}-${w}x${h}`);
      expect(over.scrollWidth, `${path} at ${w}x${h} must not scroll horizontally`)
        .toBeLessThanOrEqual(over.innerWidth);
    }
  }
});

// ---------------------------------------------------------------------------
// D. Queue page
// ---------------------------------------------------------------------------
test('D: queue shows the owner filter, recovery lanes and no degraded banner', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 1400 });

  /** Lane heading text plus the count badge the card renders next to it. */
  const laneCount = async (heading: RegExp) => {
    const card = page.locator('div').filter({ hasText: heading }).last();
    const text = (await card.innerText()).replace(/\s+/g, ' ');
    return text.match(new RegExp(heading.source + '\\s*(\\d+)', 'i'))?.[1] ?? null;
  };

  const facts: Record<string, unknown> = {};

  await page.goto(`${URL}/queue`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  await expect(page.getByTestId('owner-filter-all').first()).toBeVisible();
  await expect(page.getByTestId('owner-filter-scott').first()).toBeVisible();

  const everyoneText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  facts.everyone = {
    needs_you: everyoneText.match(/NEEDS YOU (\d+)/i)?.[1] ?? null,
    recovery_lane: everyoneText.match(/RECOVERY — BLOCKED & FAILED (\d+)/i)?.[1] ?? null,
    waiting_on_retry: everyoneText.match(/Waiting on automatic recovery \((\d+)\)/i)?.[1] ?? null,
    unassigned_recovery: everyoneText.match(/UNASSIGNED RECOVERY (\d+)/i)?.[1] ?? null,
    doing: everyoneText.match(/DOING (\d+)/i)?.[1] ?? null,
    todo: everyoneText.match(/TO DO (\d+)/i)?.[1] ?? null,
    recovery_rows: await page.getByTestId('recovery-row').count(),
  };
  // The banner exists only when a source is degraded; Slice 1 expects it absent.
  facts.degraded_banner = await page
    .getByRole('alert')
    .filter({ hasText: /degrad|could not be read/i })
    .count();
  await shot(page, 'D1-queue-everyone');

  // Failed and blocked work is visible in recovery lanes, not hidden.
  await expect(page.getByText(/RECOVERY — BLOCKED & FAILED/i).first()).toBeVisible();
  await expect(page.getByText(/UNASSIGNED RECOVERY/i).first()).toBeVisible();
  expect(Number(facts.everyone && (facts.everyone as Record<string, string>).recovery_lane))
    .toBeGreaterThan(0);
  expect(facts.everyone && (facts.everyone as Record<string, number>).recovery_rows)
    .toBeGreaterThan(0);
  expect(facts.degraded_banner, 'degraded banner is absent').toBe(0);

  // --- owner filter ----------------------------------------------------------
  await page.getByTestId('owner-filter-scott').first().click();
  await page.waitForURL(/owner=scott/);
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  const scottText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  facts.scott = {
    needs_scott: scottText.match(/NEEDS SCOTT ASCHERMAN (\d+)/i)?.[1] ?? null,
    todo: scottText.match(/TO DO (\d+)/i)?.[1] ?? null,
    doing: scottText.match(/DOING (\d+)/i)?.[1] ?? null,
    recovery_rows: await page.getByTestId('recovery-row').count(),
  };
  await shot(page, 'D2-queue-owner-scott');
  writeFileSync(join(SHOTS, 'D-queue-facts.json'), JSON.stringify(facts, null, 2));

  const scott = facts.scott as Record<string, string | number>;
  expect(scott.needs_scott, 'the filter names Scott and shows his items').toBeTruthy();
  expect(Number(scott.todo), "Scott's pending work is listed").toBeGreaterThan(0);
  // Narrowing must actually narrow.
  expect(Number(scott.todo)).toBeLessThan(
    Number((facts.everyone as Record<string, string>).todo),
  );
});

// ---------------------------------------------------------------------------
// E. Briefing
// ---------------------------------------------------------------------------
test('E: /briefing renders a snapshot or an honest empty state, and is linked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${URL}/briefing`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Morning briefing' })).toBeVisible();

  const body = await page.locator('main').innerText();
  writeFileSync(join(SHOTS, 'E-briefing.txt'), body);
  await shot(page, 'E1-briefing');

  // Either a real snapshot, or a stated absence — never a blank page.
  expect(body.trim().length, 'briefing page has content').toBeGreaterThan(80);
  expect(body).toMatch(/snapshot|briefing/i);

  await expect(page.getByRole('link', { name: /Briefing/ }).first(), 'sidebar link').toBeVisible();
});

// ---------------------------------------------------------------------------
// F. Console errors and failed requests
// ---------------------------------------------------------------------------
test('F: no console errors or failed requests on the Slice 1 pages', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: { page: string; text: string }[] = [];
  const failed: { page: string; url: string; status: number }[] = [];
  let current = 'login';

  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push({ page: current, text: m.text() });
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push({ page: current, url: r.url(), status: r.status() });
  });

  for (const path of ['/agents', '/queue', '/briefing']) {
    current = path;
    await page.goto(`${URL}${path}`, { waitUntil: 'domcontentloaded' });
    if (path === '/agents') await waitForRouting(page);
    await page.waitForTimeout(3000);
  }

  writeFileSync(
    join(SHOTS, 'F-console-network.json'),
    JSON.stringify({ errors, failed }, null, 2),
  );
  expect(failed, `failed requests: ${JSON.stringify(failed)}`).toHaveLength(0);
  expect(errors, `console errors: ${JSON.stringify(errors)}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// G. Config redaction
// ---------------------------------------------------------------------------
test('G: /api/agents/vivienne/config is redacted', async ({ page }) => {
  const res = await page.request.get(`${URL}/api/agents/vivienne/config`);
  expect(res.status()).toBe(200);
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;

  const crons = (body.crons as { prompt?: unknown }[] | undefined) ?? [];
  const hasPrompt = crons.some((c) => c && Object.prototype.hasOwnProperty.call(c, 'prompt'));
  const hasEnv = Object.prototype.hasOwnProperty.call(body, 'env');
  const hasToken = /bot\d{6,}:[A-Za-z0-9_-]{20,}/.test(raw);

  writeFileSync(
    join(SHOTS, 'G-redaction.json'),
    JSON.stringify({ crons_prompt_present: hasPrompt, env_present: hasEnv, bot_token_present: hasToken }, null, 2),
  );

  expect(hasPrompt, 'crons[].prompt present').toBe(false);
  expect(hasEnv, 'env present').toBe(false);
  expect(hasToken, 'telegram bot token present').toBe(false);
});
