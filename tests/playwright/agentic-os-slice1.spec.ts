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
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';

const SHOTS =
  process.env.SLICE1_SHOTS ||
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/output/2026-09-05/screenshots/slice1-reverify';
mkdirSync(SHOTS, { recursive: true });

const EXPECTED_AGENTS = [
  'jarvis-telegram', 'jarvis-orchestrator', 'jarvis-heartbeat', 'tron',
  'jarvis-estimator', 'jarvis-inventory', 'jarvis-accounting', 'jarvis-mls',
  'jarvis-marketing', 'vera', 'vivienne', 'trillion-coder',
];

// ---------------------------------------------------------------------------
// Native task helpers (check H). Tasks are created through the bus CLI, read
// straight off the store, and DELETED in a finally block — a ZZTEST row left in
// a shared store is clutter a human has to scroll past.
// ---------------------------------------------------------------------------
const CORTEXTOS_BIN = process.env.CORTEXTOS_BIN || '/opt/homebrew/bin/cortextos';
const TASK_DIR =
  process.env.ZZTEST_TASK_DIR ||
  join(process.env.HOME || '', '.cortextos', 'default', 'orgs', 'uhs', 'tasks');

function taskPath(id: string) {
  return join(TASK_DIR, `${id}.json`);
}

function createNativeTask(title: string): string {
  const out = execFileSync(
    CORTEXTOS_BIN,
    ['bus', 'create-task', title, '--desc', 'ZZTEST re-verification probe. Deleted by the test.', '--priority', 'low'],
    { encoding: 'utf-8', env: { ...process.env, CTX_ORG: 'uhs' }, timeout: 30_000 },
  );
  const id = out.trim().split(/\s+/).pop() ?? '';
  if (!/^task_\d+_/.test(id)) throw new Error(`could not parse a task id from: ${out}`);
  return id;
}

function readNativeTask(id: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(taskPath(id), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function busUpdateTask(id: string, status: string) {
  try {
    execFileSync(CORTEXTOS_BIN, ['bus', 'update-task', id, status], {
      encoding: 'utf-8',
      env: { ...process.env, CTX_ORG: 'uhs' },
      timeout: 30_000,
    });
  } catch {
    // A refused out-of-band move is itself a fact the test records elsewhere.
  }
}

/** The registry's own view of an agent's pin, read through the CLI (check J). */
function registryPin(agent: string): Record<string, string> | null {
  const out = execFileSync(CORTEXTOS_BIN, ['model', 'list', '--org', 'uhs', '--json'], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const parsed = JSON.parse(out) as { agents?: Record<string, { pin?: Record<string, string> | null }> };
  return parsed.agents?.[agent]?.pin ?? null;
}

function deleteNativeTask(id: string) {
  try {
    unlinkSync(taskPath(id));
  } catch {
    // Already gone.
  }
}

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
// B. Change model → restart → revert, on the live registry
//
// Re-verify run: jarvis-mls no longer carries a legacy migration pin (registry
// revision 20), so a listing_intel tier switch now REACHES the agent. That makes
// this the check for defect 6 as well — an operation that really did restart an
// agent must report the restart, not "deduped — agent already in registry".
// The revert is driven from the receipt's own button, which now requires an
// operator-supplied reason (defect 7).
// ---------------------------------------------------------------------------
test('B: role-tier switch, honest restart reporting, and an operator-reasoned revert', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const evidence: Record<string, unknown> = {};
  const row = () => routingRow(page, 'jarvis-mls');
  const rowText = async () => (await row().innerText()).replace(/\s+/g, ' ');
  const receipt = page.locator('[role="status"]').first();

  const currentOpId = async () =>
    (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;

  const newOperationId = async (previous: string | null) => {
    await expect(receipt).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, {
        timeout: 180_000,
      })
      .not.toBe(previous);
    return currentOpId();
  };

  evidence.before_row = await rowText();
  expect(evidence.before_row as string, 'jarvis-mls starts on the economy tier')
    .toContain('listing_intel / economy');

  // --- open the dialog ------------------------------------------------------
  await row().getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Role tier \(listing_intel\)/)).toBeVisible();

  await dialog.getByRole('radio', { name: /Role tier/ }).check();
  await dialog.locator('#change-model-tier').selectOption('standard');
  await dialog.locator('#change-model-reason').fill('ZZTEST-reverify-1');

  // Every agent currently carries a legacy migration pin, so a bare tier switch
  // would reach nobody. Checking the dialog's clear-pins box (defect 5) is what
  // makes this a switch that actually restarts an agent — which is the
  // condition defect 6 was about.
  const clearBox = dialog.getByRole('checkbox');
  evidence.dialog_offers_clear_pins = await clearBox.count();
  if (await clearBox.count()) {
    await clearBox.first().check();
    evidence.clear_pins_checked = true;
  }

  const preview = dialog.getByRole('group', { name: 'Change preview' });
  await expect(preview).toBeVisible();
  evidence.preview = (await preview.innerText()).replace(/\s+/g, ' ');
  const previewText = evidence.preview as string;
  expect(previewText, 'preview names the affected agents').toMatch(/Affects \d+ agent/);
  expect(previewText, 'preview states the cost-class change').toMatch(/[Cc]ost class/);
  expect(previewText, 'preview states a restart consequence').toMatch(/restart/i);
  await shot(page, 'B1-dialog-preview');

  await dialog.getByRole('button', { name: 'Submit change' }).click();

  // --- receipt: an operation that restarted an agent must say so ------------
  const opSwitch = await newOperationId(null);
  evidence.operation_id_switch = opSwitch;
  expect(opSwitch, 'switch operation id on the receipt').toBeTruthy();
  const receiptText = await receipt.innerText();
  evidence.receipt_switch = receiptText.replace(/\s+/g, ' ');
  expect(receiptText, 'receipt states progress through the operation states')
    .toMatch(/Step \d+ of \d+|Off the normal path/);
  await shot(page, 'B2-receipt-switch');

  // Defect 6: the preview said jarvis-mls would restart. The receipt must
  // report the restart result, not a dedupe block.
  if (/will be restarted/i.test(previewText) || evidence.clear_pins_checked === true) {
    expect
      .soft(receiptText, 'a switch that restarts must not be reported as a dedupe block')
      .not.toMatch(/deduped/i);
    expect
      .soft(receiptText, 'the receipt lists the restart result for the affected agent')
      .toMatch(/Restarted \d+ of \d+ agent/);
  }

  // The receipt's own claim is checked against the daemon's operation record.
  const opsRes = await page.request.get(`${URL}/api/model-routing?limit=50`);
  const ops = (await opsRes.json()) as { events?: Record<string, unknown>[] };
  evidence.events_for_op = (ops.events ?? []).filter(
    (e) => (e as { operation_id?: string }).operation_id === opSwitch,
  );

  await waitForRouting(page);
  evidence.after_switch_row = await rowText();
  expect(evidence.after_switch_row as string, 'role tier moved to standard')
    .toContain('listing_intel / standard');

  // --- revert from the receipt, with an operator reason (defect 7) ----------
  const reasonInput = receipt.locator('#revert-reason');
  await expect(reasonInput, 'the receipt exposes an editable revert reason').toBeVisible();
  evidence.revert_reason_prefill = await reasonInput.inputValue();

  const revertBtn = receipt.getByRole('button', { name: 'Revert' });
  // An empty reason must not be revertible — the reason is the record.
  await reasonInput.fill('');
  await expect
    .soft(revertBtn, 'Revert is disabled until a reason is supplied')
    .toBeDisabled();

  await reasonInput.fill('ZZTEST-reverify-1-revert');
  await expect(revertBtn, 'the receipt offers Revert').toBeEnabled();
  await shot(page, 'B3-revert-reason-editable');
  await revertBtn.click();

  const opRevert = await newOperationId(opSwitch);
  evidence.operation_id_revert = opRevert;
  evidence.receipt_revert = (await receipt.innerText()).replace(/\s+/g, ' ');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  evidence.final_row = await rowText();
  await shot(page, 'B4-after-revert');
  writeFileSync(join(SHOTS, 'B-evidence.json'), JSON.stringify(evidence, null, 2));

  // Back exactly where it started.
  expect(evidence.final_row as string, 'listing_intel back on economy')
    .toContain('listing_intel / economy');
  expect(evidence.final_row as string, 'jarvis-mls back on its economy model')
    .toContain('claude-haiku-4-5-20251001');
  // A revert that restores the tier but not the pin it cleared has not put the
  // registry back — that is a one-way door wearing a Revert button.
  if (evidence.clear_pins_checked === true) {
    expect
      .soft(evidence.final_row as string, 'the revert restored the legacy pin it cleared')
      .toContain('Pinned');
  }
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

// ===========================================================================
// Re-verification of the seven defects found in the first live acceptance run.
// Each test names the defect it re-checks and captures its own evidence file.
// ===========================================================================

/** Defect 1 — trillion-coder's invalid pin reads as remediation, not a shell code. */
test('DEF-1: trillion-coder shows its remediation message, not a CLI exit status', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const tc = routingRow(page, 'trillion-coder');
  const text = (await tc.innerText()).replace(/\s+/g, ' ');
  writeFileSync(join(SHOTS, 'DEF-1-trillion-coder-row.txt'), text);
  await tc.scrollIntoViewIfNeeded();
  await shot(page, 'DEF-1-trillion-coder');

  // The chip is upper-cased by CSS, so innerText reports it upper-case.
  expect(text.toLowerCase(), 'the row carries the validation code as a remediation chip')
    .toContain('pin_not_dispatchable');
  expect(text, 'the row carries the human-readable remediation sentence')
    .toMatch(/awaiting human remediation/i);
  expect(text, 'no raw CLI exit status leaks into the row')
    .not.toMatch(/exited?\s+2|cortextos model exited/i);
});

/** Defect 2 — an enabled-but-unconfigured agent is a note, not a phantom row. */
test('DEF-2: jarvis-scout is a "Configuration missing" note with no row, button or 404s', async ({ page }) => {
  test.setTimeout(180_000);
  const requests: { url: string; status: number }[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/agents/jarvis-scout/')) {
      requests.push({ url: r.url(), status: r.status() });
    }
  });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  await page.waitForTimeout(3000);

  const section = page.locator('section[aria-labelledby="fleet-model-routing-heading"]');
  const scoutRow = routingRow(page, 'jarvis-scout');
  // The heading words live in a span; the sentence naming the agent is the
  // paragraph around it.
  const note = section.locator('p').filter({ hasText: /Configuration missing/i });

  const facts = {
    scout_rows: await scoutRow.count(),
    scout_change_buttons: await scoutRow.getByRole('button', { name: 'Change model' }).count(),
    note_visible: (await note.count()) > 0,
    note_text: (await note.count()) > 0 ? (await note.first().innerText()).replace(/\s+/g, ' ') : null,
    scout_config_requests: requests,
  };
  writeFileSync(join(SHOTS, 'DEF-2-scout.json'), JSON.stringify(facts, null, 2));
  await shot(page, 'DEF-2-configuration-missing-note');

  expect(facts.scout_rows, 'jarvis-scout has no routing row').toBe(0);
  expect(facts.scout_change_buttons, 'jarvis-scout has no Change button').toBe(0);
  expect(facts.note_visible, 'the muted "Configuration missing" note is shown').toBe(true);
  expect(facts.note_text ?? '', 'the note names jarvis-scout').toContain('jarvis-scout');
  expect(requests, 'no request is made to the unconfigured agent\'s config endpoint')
    .toHaveLength(0);
});

/** Defect 3 — confidence badges reflect the observed model, not a blanket "unconfirmed". */
test('DEF-3: confidence badges show verified and mismatch from real observations', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const section = page.locator('section[aria-labelledby="fleet-model-routing-heading"]');
  const all = (await section.locator('tbody').innerText()).replace(/\s+/g, ' ');

  const perAgent: Record<string, string> = {};
  for (const agent of EXPECTED_AGENTS) {
    const row = routingRow(page, agent);
    if ((await row.count()) === 0) continue;
    const t = (await row.innerText()).replace(/\s+/g, ' ');
    perAgent[agent] = t.match(/verified|mismatch|unconfirmed/)?.[0] ?? 'none';
  }
  writeFileSync(join(SHOTS, 'DEF-3-confidence.json'), JSON.stringify(perAgent, null, 2));
  await shot(page, 'DEF-3-confidence-badges');

  expect(all, 'at least one agent reports a verified running model').toContain('verified');
  expect(
    Object.values(perAgent).every((v) => v === 'unconfirmed'),
    'the table is not a blanket "unconfirmed"',
  ).toBe(false);

  // The daemon observes trillion-coder running gpt-5.5 against an expected
  // claude-sonnet-4-6. That disagreement is the whole point of the column.
  const tc = (await routingRow(page, 'trillion-coder').innerText()).replace(/\s+/g, ' ');
  writeFileSync(join(SHOTS, 'DEF-3-trillion-coder.txt'), tc);
  expect(tc, "trillion-coder's observed/expected disagreement is visible").toContain('mismatch');
});

/** Defect 4 — a switch that restarts nothing must say so, and never narrate restarts. */
test('DEF-4: a no-restart switch is narrated as "no restart needed"', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  // finance_ops holds exactly one agent (jarvis-accounting) and it is pinned,
  // so a tier switch on that role changes the registry and restarts nobody.
  const row = routingRow(page, 'jarvis-accounting');
  const before = (await row.innerText()).replace(/\s+/g, ' ');
  await row.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /Role tier/ }).check();
  await dialog.locator('#change-model-tier').selectOption('premium');
  await dialog.locator('#change-model-reason').fill('ZZTEST-reverify-2-no-restart');

  const preview = dialog.getByRole('group', { name: 'Change preview' });
  const previewText = (await preview.innerText()).replace(/\s+/g, ' ');
  await shot(page, 'DEF-4-preview-no-restart');
  expect(previewText, 'the preview predicts no restarts')
    .toContain('No agents will be restarted by this change.');

  await dialog.getByRole('button', { name: 'Submit change' }).click();

  const receipt = page.locator('[role="status"]').first();
  await expect(receipt).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
    .not.toBeNull();
  const opId = (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;
  const receiptText = (await receipt.innerText()).replace(/\s+/g, ' ');
  await shot(page, 'DEF-4-receipt-no-restart');
  writeFileSync(
    join(SHOTS, 'DEF-4-evidence.json'),
    JSON.stringify({ before, previewText, opId, receiptText }, null, 2),
  );

  expect(receiptText, 'the receipt states that nothing needed restarting')
    .toMatch(/no restart needed|No agent restart is needed/i);
  expect(receiptText, 'the receipt does not claim a restart it did not perform')
    .not.toMatch(/Restarted \d+ of/);

  // --- revert -------------------------------------------------------------
  const reasonInput = receipt.locator('#revert-reason');
  await reasonInput.fill('ZZTEST-reverify-2-no-restart-revert');
  await receipt.getByRole('button', { name: 'Revert' }).click();
  await expect
    .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
    .not.toBe(opId);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  const after = (await routingRow(page, 'jarvis-accounting').innerText()).replace(/\s+/g, ' ');
  await shot(page, 'DEF-4-after-revert');
  expect(after, 'finance_ops is back where it started').toBe(before);
});

/** Defect 5 — "Clear legacy pin" is offered inside the dialog, and a blocked
 *  operation replaces the receipt rather than leaving a stale Revert. */
test('DEF-5: the dialog previews clearable pins; a refused operation replaces the receipt', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const evidence: Record<string, unknown> = {};

  // --- 5a: the clear-pins control lives in the dialog ----------------------
  // vera's role (vera) holds one legacy-pinned agent, so the dialog must offer
  // to clear that pin as part of the same change.
  const veraRow = routingRow(page, 'vera');
  await veraRow.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /Role tier/ }).check();

  const clearBox = dialog.getByRole('checkbox');
  evidence.dialog_clear_pins_checkbox = await clearBox.count();
  const clearBlockText = (await dialog.innerText()).replace(/\s+/g, ' ');
  evidence.dialog_clear_pins_text = clearBlockText;
  await shot(page, 'DEF-5a-dialog-clear-pins');
  expect(evidence.dialog_clear_pins_checkbox as number, 'the dialog offers a clear-pins checkbox')
    .toBeGreaterThan(0);
  expect(clearBlockText, 'the dialog previews which pins would be cleared')
    .toMatch(/clear \d+ legacy pin/i);
  expect(clearBlockText, 'the preview names the pinned agent and entry').toContain('vera');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The row action still exists for a pinned agent.
  evidence.row_clear_legacy_pin =
    (await veraRow.getByRole('button', { name: 'Clear legacy pin' }).count()) > 0;
  expect(evidence.row_clear_legacy_pin, 'the row still offers "Clear legacy pin"').toBe(true);

  // --- 5b: a refused operation must replace the displayed receipt ----------
  // Produce a real receipt with a live Revert first.
  const mls = routingRow(page, 'jarvis-mls');
  await mls.getByRole('button', { name: 'Change model' }).click();
  const d2 = page.getByRole('dialog');
  await d2.getByRole('radio', { name: /Role tier/ }).check();
  await d2.locator('#change-model-tier').selectOption('standard');
  await d2.locator('#change-model-reason').fill('ZZTEST-reverify-3-receipt-replacement');
  await d2.getByRole('button', { name: 'Submit change' }).click();

  const receipt = page.locator('[role="status"]').first();
  await expect(receipt).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
    .not.toBeNull();
  const firstOp = (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;
  evidence.first_operation_id = firstOp;
  evidence.first_receipt_revert_enabled = await receipt
    .getByRole('button', { name: 'Revert' })
    .isEnabled();

  // Now ask for something the routing service must refuse: pinning
  // trillion-coder to the entry the registry already records as not
  // dispatchable for its runtime.
  await waitForRouting(page);
  await routingRow(page, 'trillion-coder').getByRole('button', { name: 'Change model' }).click();
  const d3 = page.getByRole('dialog');
  await expect(d3).toBeVisible();
  await d3.getByRole('radio', { name: /Pin this agent/ }).check();
  await d3.locator('#change-model-entry').selectOption('anthropic-sonnet-4-6').catch(() => {});
  await d3.locator('#change-model-reason').fill('ZZTEST-reverify-3-invalid-pin');
  await d3.getByRole('button', { name: 'Submit change' }).click();
  await page.waitForTimeout(8000);

  const afterText = (await receipt.innerText()).replace(/\s+/g, ' ');
  const afterOp = afterText.match(/op_[a-z0-9]+/)?.[0] ?? null;
  evidence.second_operation_id = afterOp;
  evidence.second_receipt_text = afterText;
  evidence.stale_revert_still_pointing_at_first_op =
    afterOp === firstOp && (await receipt.getByRole('button', { name: 'Revert' }).isEnabled());
  await shot(page, 'DEF-5b-receipt-after-refusal');

  // Whatever the service decided, the panel must be describing the operation
  // that just ran — never still offering to revert the previous one.
  expect(
    evidence.stale_revert_still_pointing_at_first_op,
    'the panel must not leave a stale Revert for a superseded operation',
  ).toBe(false);

  // --- cleanup: put the registry back --------------------------------------
  const d3open = await page.getByRole('dialog').count();
  if (d3open > 0) await page.keyboard.press('Escape');

  // Revert whichever operations actually applied, newest first.
  for (const opId of [afterOp, firstOp].filter((o): o is string => !!o)) {
    const res = await page.request.patch(`${URL}/api/agents/jarvis-mls/config`, {
      data: {
        op: 'model_routing',
        action: 'revert',
        operation_id: opId,
        reason: 'ZZTEST-reverify-3-cleanup-revert',
      },
    });
    evidence[`revert_${opId}`] = { status: res.status(), body: (await res.text()).slice(0, 400) };
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  evidence.final_mls_row = (await routingRow(page, 'jarvis-mls').innerText()).replace(/\s+/g, ' ');
  evidence.final_tc_row = (await routingRow(page, 'trillion-coder').innerText()).replace(/\s+/g, ' ');
  writeFileSync(join(SHOTS, 'DEF-5-evidence.json'), JSON.stringify(evidence, null, 2));
  await shot(page, 'DEF-5-final-state');

  expect(evidence.final_mls_row as string, 'listing_intel restored to economy')
    .toContain('listing_intel / economy');
});

/** Defect 6 + the Attempts expander — the per-row provenance drawer. */
test('DEF-6/attempts: the Attempts expander lists recent attempts with observed + confidence', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const row = routingRow(page, 'jarvis-accounting');
  const btn = row.getByRole('button', { name: 'Attempts' });
  await expect(btn, 'each row has an Attempts expander').toBeVisible();
  await btn.click();

  const drawer = page.getByText(/Last \d+ dispatch attempts — jarvis-accounting/);
  await expect(drawer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Loading attempts…')).toHaveCount(0, { timeout: 30_000 });

  const panel = page.locator('tr', { has: page.getByText(/Last \d+ dispatch attempts/) }).first();
  const text = (await panel.innerText()).replace(/\s+/g, ' ');
  writeFileSync(join(SHOTS, 'DEF-6-attempts-jarvis-accounting.txt'), text);
  await shot(page, 'DEF-6-attempts-expander');

  expect(text, 'the drawer names the provenance columns').toContain('Requested');
  expect(text, 'the drawer names the provenance columns').toContain('Resolved');
  expect(text, 'the drawer names the provenance columns').toContain('Observed');
  expect(text, 'the drawer names the provenance columns').toContain('Confidence');
  expect(text, 'the drawer holds at least one recorded attempt, or says it has none')
    .toMatch(/verified|mismatch|unconfirmed|No attempts recorded/);

  // Collapsing works and is announced.
  await row.getByRole('button', { name: 'Hide attempts' }).click();
  await expect(page.getByText(/Last \d+ dispatch attempts — jarvis-accounting/)).toHaveCount(0);
});

// ===========================================================================
// H. Task moves: a refused move must be visible, a stale edit must conflict.
// ===========================================================================
test('H: a move that does not take is shown, and a stale version conflicts', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1200 });

  const title = 'ZZTEST-reverify-4 move contract probe';
  const taskId = createNativeTask(title);
  const evidence: Record<string, unknown> = { task_id: taskId };

  try {
    await page.goto(`${URL}/tasks`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 60_000 });
    await page.getByText(title).first().click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await shot(page, 'H1-task-detail');

    // --- H1: a contract-violating move (backlog -> done, no evidence) -------
    evidence.state_before = readNativeTask(taskId);
    await sheet.getByRole('button', { name: /^Complete$/ }).click();
    await page.waitForTimeout(6000);

    const alert = page.getByRole('alert').filter({ hasText: /Could not move|changed while you were/i });
    evidence.refusal_alert_shown = (await alert.count()) > 0;
    evidence.refusal_alert_text =
      (await alert.count()) > 0 ? (await alert.first().innerText()).replace(/\s+/g, ' ') : null;
    evidence.state_after_illegal_move = readNativeTask(taskId);
    await shot(page, 'H2-after-illegal-move');

    // The contract forbids backlog -> done. Either the move is refused with a
    // visible reason, or it lands — and if it lands, the store accepted a
    // transition its own contract calls illegal.
    const landed =
      (evidence.state_after_illegal_move as Record<string, unknown>)?.canonical_state === 'done';
    evidence.illegal_move_landed = landed;

    // --- H2: a stale version must conflict ---------------------------------
    // Reload the board, then move the task out from under it via the bus, so
    // the version the page holds is no longer current.
    await page.goto(`${URL}/tasks`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 60_000 });
    const versionOnScreen = (readNativeTask(taskId) as { version?: number })?.version;
    busUpdateTask(taskId, 'blocked');
    await page.waitForTimeout(1500);
    busUpdateTask(taskId, 'in_progress');
    evidence.version_rendered_from = versionOnScreen;
    evidence.version_after_out_of_band = (readNativeTask(taskId) as { version?: number })?.version;

    await page.getByText(title).first().click();
    const sheet2 = page.getByRole('dialog');
    await expect(sheet2).toBeVisible({ timeout: 20_000 });
    const anyButton = sheet2.getByRole('button', { name: /^(Complete|Block|Start|Unblock|Reopen|Back to Pending)$/ }).first();
    if (await anyButton.count()) {
      await anyButton.click();
      await page.waitForTimeout(6000);
    }
    // Root-cause probe: the board can only send a version it was given. If the
    // list endpoint does not carry one, the conflict path added to the PATCH
    // handler is unreachable from the UI no matter what the store does.
    const listRes = await page.request.get(`${URL}/api/tasks?limit=5`);
    const listBody = (await listRes.json()) as unknown;
    const listRows = (Array.isArray(listBody) ? listBody : []) as Record<string, unknown>[];
    evidence.tasks_list_fields = Object.keys(listRows[0] ?? {});
    evidence.tasks_list_exposes_version = listRows.some((r) => 'version' in r);

    const conflictAlert = page.getByRole('alert').filter({ hasText: /changed while you were|Could not move/i });
    evidence.conflict_alert_shown = (await conflictAlert.count()) > 0;
    evidence.conflict_alert_text =
      (await conflictAlert.count()) > 0
        ? (await conflictAlert.first().innerText()).replace(/\s+/g, ' ')
        : null;
    await shot(page, 'H3-stale-version');

    writeFileSync(join(SHOTS, 'H-task-move-evidence.json'), JSON.stringify(evidence, null, 2));

    // The board must never swallow a move outcome: either it applied and the
    // record moved, or the page said why it did not.
    const finalState = readNativeTask(taskId) as Record<string, unknown> | null;
    expect(finalState, 'the ZZTEST task still exists to be asserted on').not.toBeNull();
    expect
      .soft(
        evidence.tasks_list_exposes_version,
        'the tasks list must carry `version` or the board can never send one, ' +
          'which makes every Kanban move a blind write and the 409 path unreachable',
      )
      .toBe(true);
    expect
      .soft(
        evidence.conflict_alert_shown,
        'an edit made from a stale version must surface a conflict',
      )
      .toBe(true);
    expect(
      evidence.illegal_move_landed === false || evidence.refusal_alert_shown === true,
      'a contract-violating move must be refused visibly, not silently applied',
    ).toBe(true);
  } finally {
    deleteNativeTask(taskId);
  }
});

// ===========================================================================
// I. Briefing person views (OS-04b) and their ACL.
// ===========================================================================
test('I: person-scoped briefings are server-filtered and Angelic-only content stays out of Raquel\'s view', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1200 });

  const capture: Record<string, unknown> = {};

  for (const person of ['scott', 'raquel', 'angelic']) {
    await page.goto(`${URL}/briefing?person=${person}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Morning briefing' })).toBeVisible();
    const body = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    capture[`page_${person}`] = body;
    writeFileSync(join(SHOTS, `I-briefing-${person}.txt`), body);
    await shot(page, `I-briefing-${person}`);

    const api = await page.request.get(`${URL}/api/briefing?person=${person}`);
    const raw = await api.text();
    capture[`api_${person}_status`] = api.status();
    capture[`api_${person}_facets`] = (() => {
      try {
        const b = JSON.parse(raw) as { snapshot?: { facets?: Record<string, unknown> }; permitted_persons?: string[] };
        return { facets: Object.keys(b.snapshot?.facets ?? {}), permitted: b.permitted_persons ?? [] };
      } catch {
        return { parse_error: raw.slice(0, 200) };
      }
    })();
  }

  // The switcher shows exactly the persons this admin session is mapped to.
  await page.goto(`${URL}/briefing`, { waitUntil: 'domcontentloaded' });
  const nav = page.locator('nav[aria-label="Briefing person"]');
  capture.switcher_present = (await nav.count()) > 0;
  capture.switcher_text =
    (await nav.count()) > 0 ? (await nav.innerText()).replace(/\s+/g, ' ') : null;
  await shot(page, 'I-person-switcher');

  // An unknown person is a stated error, not a silent fallback.
  const bogus = await page.request.get(`${URL}/api/briefing?person=notaperson`);
  capture.unknown_person_status = bogus.status();
  capture.unknown_person_body = (await bogus.text()).slice(0, 300);

  writeFileSync(join(SHOTS, 'I-briefing-acl.json'), JSON.stringify(capture, null, 2));

  // ACL: whatever Angelic's view carries that is stamped angelic-only must not
  // appear in Raquel's facets.
  const raquelFacets = ((capture.api_raquel_facets as { facets?: string[] })?.facets ?? []);
  // A 404 for every person means no snapshot exists to filter, so the facet
  // assertions below pass vacuously. Say so in the evidence rather than
  // letting an empty store read as a proven ACL.
  capture.acl_exercised_against_real_content =
    capture.api_raquel_status === 200 || capture.api_angelic_status === 200;
  const angelicOnly = ['angelic_inbox', 'angelic_tasks'];
  for (const f of angelicOnly) {
    expect(raquelFacets, `Raquel's briefing must not carry the ${f} facet`).not.toContain(f);
  }
  expect(capture.unknown_person_status, 'an unknown person is rejected, not defaulted')
    .toBeGreaterThanOrEqual(400);
  expect(capture.switcher_present, 'the person switcher is rendered for a multi-person viewer')
    .toBe(true);
  expect(capture.switcher_text ?? '', 'the switcher names every permitted person')
    .toMatch(/Scott.*Raquel.*Angelic/);
});

// ===========================================================================
// J. Clear-pin safety.
//
// A previous verifier destroyed jarvis-mls's legacy-migration pin through a
// clear-pin that failed with a bare 503 and looked like nothing had happened.
// This check exercises the same button on a DIFFERENT agent and requires that
// (a) the outcome is stated, (b) a refusal arrives as a receipt rather than a
// bare error status, (c) Revert puts the pin back, and (d) the restored pin is
// the same pin — same entry_id, same expiry — not a fresh one.
// ===========================================================================
test('J: clearing a legacy pin states its outcome and is reversible', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });

  const AGENT = 'jarvis-marketing';
  const evidence: Record<string, unknown> = { agent: AGENT };

  // The pin as the registry holds it now, read straight off the CLI.
  const pinBefore = registryPin(AGENT);
  evidence.pin_before = pinBefore;
  expect(pinBefore, `${AGENT} must start with a pin for this check to mean anything`)
    .not.toBeNull();

  // Every response to the unpin door, so a bare 503 cannot hide behind a
  // rendered receipt.
  const patches: { url: string; status: number; body: string }[] = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'PATCH' && r.url().includes(`/api/agents/${AGENT}/config`)) {
      patches.push({ url: r.url(), status: r.status(), body: (await r.text().catch(() => '')).slice(0, 800) });
    }
  });

  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const row = () => routingRow(page, AGENT);
  evidence.row_before = (await row().innerText()).replace(/\s+/g, ' ');

  const clearBtn = row().getByRole('button', { name: 'Clear legacy pin' });
  await expect(clearBtn, 'the pinned row offers "Clear legacy pin"').toBeVisible();
  await clearBtn.click();

  // --- (a) the UI states an outcome ---------------------------------------
  const receipt = page.locator('[role="status"]').first();
  await expect(receipt, 'clearing a pin produces a visible receipt, never a silent no-op')
    .toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
    .not.toBeNull();
  const opUnpin = (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;
  const unpinReceipt = (await receipt.innerText()).replace(/\s+/g, ' ');
  evidence.unpin_operation_id = opUnpin;
  evidence.unpin_receipt = unpinReceipt;
  await shot(page, 'J1-clear-pin-receipt');

  expect(unpinReceipt, 'the receipt names a terminal outcome for the operation')
    .toMatch(/Applied|Blocked|Failed|Desired written|Draining/);

  // --- (b) a refusal is a receipt, not a bare error status -----------------
  evidence.patch_responses = patches;
  const bareErrors = patches.filter((p) => {
    if (p.status === 200) return false;
    try {
      return !JSON.parse(p.body).receipt;
    } catch {
      return true;
    }
  });
  evidence.bare_error_responses = bareErrors;
  expect
    .soft(bareErrors, 'a blocked clear-pin must carry a receipt, not a bare 503')
    .toHaveLength(0);

  evidence.pin_after_clear = registryPin(AGENT);
  evidence.row_after_clear = (await row().innerText()).replace(/\s+/g, ' ');

  // --- (c) Revert restores the pin -----------------------------------------
  // The receipt renders before the panel finishes its post-operation refresh,
  // and `submitting` stays true for the whole refresh — so Revert is dead for
  // several seconds with nothing saying why. Wait the refresh out before
  // judging the control, and record how long the dead window lasted.
  const deadWindowStart = Date.now();
  await waitForRouting(page);
  await expect
    .poll(async () => receipt.getByRole('button', { name: 'Revert' }).isEnabled().catch(() => false) ||
                      (await receipt.locator('#revert-reason').inputValue().catch(() => '')) !== null,
      { timeout: 60_000 })
    .toBeTruthy();
  evidence.refresh_ms_before_controls_settle = Date.now() - deadWindowStart;

  const reasonInput = receipt.locator('#revert-reason');
  const revertBtn = receipt.getByRole('button', { name: 'Revert' });
  evidence.revert_offered = await revertBtn.count();
  evidence.revert_enabled_before_reason = await revertBtn.isEnabled().catch(() => false);

  if (await reasonInput.count()) {
    await reasonInput.fill('ZZTEST-reverify-5-clearpin-revert');
  }
  const canRevert = await revertBtn.isEnabled().catch(() => false);
  evidence.revert_enabled_with_reason = canRevert;

  if (canRevert) {
    await revertBtn.click();
    await expect
      .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
      .not.toBe(opUnpin);
    evidence.revert_operation_id = (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null;
    evidence.revert_receipt = (await receipt.innerText()).replace(/\s+/g, ' ');
  }
  await shot(page, 'J2-after-revert');

  // --- (d) the SAME pin is back, per the CLI -------------------------------
  const pinAfter = registryPin(AGENT);
  evidence.pin_after_revert = pinAfter;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  evidence.row_final = (await routingRow(page, AGENT).innerText()).replace(/\s+/g, ' ');
  await shot(page, 'J3-final-row');
  writeFileSync(join(SHOTS, 'J-clear-pin-evidence.json'), JSON.stringify(evidence, null, 2));

  expect(pinAfter, 'the pin is present again after the revert').not.toBeNull();
  expect(pinAfter?.entry_id, 'the restored pin points at the original entry')
    .toBe(pinBefore?.entry_id);
  expect(pinAfter?.kind, 'the restored pin is still a legacy-migration pin')
    .toBe(pinBefore?.kind);
  expect(pinAfter?.expires_at, 'the restored pin keeps its original expiry')
    .toBe(pinBefore?.expires_at);
});

// ===========================================================================
// K. Operation history after a reload.
//
// Revert lives on the receipt the panel is holding in memory. If nothing else
// lists past operations, then reloading the page is enough to make a switch
// permanently un-undoable from the UI, even though the journal behind
// `cortextos model events` still has it.
// ===========================================================================
test('K: a past operation is reachable and revertible after a page reload', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.goto(`${URL}/agents`, { waitUntil: 'domcontentloaded' });
  await waitForRouting(page);

  const evidence: Record<string, unknown> = {};

  // Make one real operation to look for afterwards.
  const row = routingRow(page, 'jarvis-accounting');
  await row.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /Role tier/ }).check();
  await dialog.locator('#change-model-tier').selectOption('premium');
  await dialog.locator('#change-model-reason').fill('ZZTEST-reverify-6-history');
  await dialog.getByRole('button', { name: 'Submit change' }).click();

  const receipt = page.locator('[role="status"]').first();
  await expect(receipt).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(async () => (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? null, { timeout: 180_000 })
    .not.toBeNull();
  const opId = (await receipt.innerText()).match(/op_[a-z0-9]+/)?.[0] ?? '';
  evidence.operation_id = opId;
  evidence.revert_available_in_session = await receipt
    .getByRole('button', { name: 'Revert' })
    .isEnabled();
  await shot(page, 'K1-receipt-in-session');

  // --- the reload ----------------------------------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRouting(page);
  await page.waitForTimeout(2000);

  const bodyText = await page.locator('body').innerText();
  evidence.operation_id_visible_after_reload = bodyText.includes(opId);
  evidence.any_operation_id_visible_after_reload = /op_[a-z0-9]{6,}/.test(bodyText);
  evidence.receipt_panels_after_reload = await page.locator('[role="status"]').count();
  evidence.revert_buttons_after_reload = await page.getByRole('button', { name: 'Revert' }).count();
  evidence.history_heading_after_reload = await page
    .getByRole('heading', { name: /history|recent operations|activity|audit|journal/i })
    .count();
  await shot(page, 'K2-after-reload');

  // The data exists behind the API — that is what makes its absence a UI gap
  // rather than a missing capability.
  const api = await page.request.get(`${URL}/api/model-routing?limit=50`);
  const body = (await api.json()) as { events?: { operation_id?: string }[] };
  evidence.api_returns_events = (body.events ?? []).length;
  evidence.api_has_this_operation = (body.events ?? []).some((e) => e.operation_id === opId);

  writeFileSync(join(SHOTS, 'K-history-evidence.json'), JSON.stringify(evidence, null, 2));

  // --- restore the registry regardless of the outcome ----------------------
  const res = await page.request.patch(`${URL}/api/agents/jarvis-accounting/config`, {
    data: {
      op: 'model_routing',
      action: 'revert',
      operation_id: opId,
      reason: 'ZZTEST-reverify-6-history-revert',
    },
  });
  evidence.cleanup_revert_status = res.status();
  writeFileSync(join(SHOTS, 'K-history-evidence.json'), JSON.stringify(evidence, null, 2));

  expect(
    evidence.operation_id_visible_after_reload,
    'a past operation must still be identifiable in the UI after a reload',
  ).toBe(true);
  expect(
    Number(evidence.revert_buttons_after_reload),
    'a past operation must still be revertible after a reload',
  ).toBeGreaterThan(0);
});
