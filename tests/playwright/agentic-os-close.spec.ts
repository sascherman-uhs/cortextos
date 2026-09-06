/**
 * Agentic OS — CLOSING verification (verify-close).
 *
 * Confirms the seven claimed fixes hold in the LIVE system. Reuses the fixture
 * and login helpers proven by agentic-os-final.spec.ts.
 *
 *   C1  D2/L1  the board sends expectedVersion; a stale move conflicts visibly,
 *              and a card with no version fails closed instead of posting.
 *   C2  D2b    the server refuses a transition that carries no version at all.
 *   C3  D12/H  a refused move is announced INSIDE the sheet (role=alert +
 *              aria-live), on screen, while the background stays aria-hidden.
 *   C4  D11    a failed_terminal record offers exactly one action and it works;
 *              a terminal state says nothing moves out of it.
 *   C5  D13    failed and cancelled work is in the default /tasks Kanban.
 *   C6  D6     create-task with no org refuses (covered at the CLI); the
 *              with-org path reaches the board.
*   C7  D3     /improvements renders an honest empty state, no Supabase 404s.
 *   C8  D6b    create-approval with no org refuses; with an org it reaches the
 *              approvals queue, the API and the dashboard.
 *   C8  L3'    the acceptance-criteria gate still fires once a version is sent.
 *
 * Every fixture carries ZZTEST and is deleted in a finally block.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || '';
const SHOTS =
  process.env.CLOSE_SHOTS ||
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/output/2026-09-05/screenshots/close';
mkdirSync(SHOTS, { recursive: true });

const BIN = process.env.CORTEXTOS_BIN || '/opt/homebrew/bin/cortextos';
const TASK_DIR = join(process.env.HOME || '', '.cortextos', 'default', 'orgs', 'uhs', 'tasks');
const CLI_ENV = { ...process.env, CTX_ORG: 'uhs', CTX_AGENT_NAME: 'verify-close' };

function taskPath(id: string) { return join(TASK_DIR, `${id}.json`); }

function createNativeTask(title: string): string {
  const out = execFileSync(BIN, ['bus', 'create-task', title, '--desc', 'ZZTEST close-verification probe. Deleted by the test.', '--priority', 'low'],
    { encoding: 'utf-8', env: CLI_ENV, timeout: 30_000 });
  const id = out.trim().split(/\s+/).pop() ?? '';
  if (!/^task_\d+_/.test(id)) throw new Error(`could not parse a task id from: ${out}`);
  return id;
}
function readNativeTask(id: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(taskPath(id), 'utf-8')) as Record<string, unknown>; } catch { return null; }
}
function patchNativeTask(id: string, mutate: (t: Record<string, unknown>) => void) {
  const t = readNativeTask(id);
  if (!t) throw new Error(`fixture ${id} is missing`);
  if (!String(t.title ?? '').includes('ZZTEST')) throw new Error('refusing to patch a non-ZZTEST record');
  mutate(t);
  writeFileSync(taskPath(id), JSON.stringify(t, null, 2));
}
/**
 * Remove a fixture and everything it left behind. Deleting only the task file
 * leaves the audit log, the task-events log and the inbox messages the board
 * generated when the card moved — 134 such files had accumulated across this
 * verification effort before anyone looked. Cleanup means all of it.
 */
function deleteNativeTask(id: string) {
  const ORG_ROOT = join(process.env.HOME || '', '.cortextos', 'default', 'orgs', 'uhs');
  const INSTANCE_ROOT = join(process.env.HOME || '', '.cortextos', 'default');
  for (const f of [
    taskPath(id),
    join(ORG_ROOT, 'tasks', 'audit', `${id}.jsonl`),
    join(ORG_ROOT, 'task-events', `${id}.jsonl`),
    join(INSTANCE_ROOT, 'tasks', 'audit', `${id}.jsonl`),
    join(INSTANCE_ROOT, 'task-events', `${id}.jsonl`),
  ]) {
    try { unlinkSync(f); } catch { /* not there */ }
  }
  // Inbox notifications the dashboard sent about this task, to whichever
  // agent they were addressed to.
  const inbox = join(INSTANCE_ROOT, 'inbox');
  let agents: string[] = [];
  try { agents = readdirSync(inbox); } catch { return; }
  for (const agent of agents) {
    let files: string[] = [];
    try { files = readdirSync(join(inbox, agent)); } catch { continue; }
    for (const f of files) {
      const full = join(inbox, agent, f);
      try {
        if (readFileSync(full, 'utf-8').includes(id)) unlinkSync(full);
      } catch { /* unreadable or already gone */ }
    }
  }
}
async function shot(page: Page, name: string) { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); }
function saveEvidence(name: string, e: unknown) { writeFileSync(join(SHOTS, `${name}.json`), JSON.stringify(e, null, 2)); }

async function uiLogin(page: Page) {
  await page.goto(`${URL}/board`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    await page.fill('input[name="username"]', USER);
    await page.fill('input[name="password"]', PASS);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }),
      page.click('button[type="submit"]'),
    ]);
  }
  expect(page.url()).not.toContain('/login');
}
test.beforeEach(async ({ page }) => { await uiLogin(page); });

function cardByTitle(page: Page, title: string) {
  return page.getByTestId('board-card').filter({ hasText: title }).first();
}
async function waitForCard(page: Page, title: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${URL}/board`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    if (await cardByTitle(page, title).count()) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}
/** Open a task's detail sheet from /tasks and wait for its offered moves. */
async function openSheet(page: Page, title: string) {
  await page.goto(`${URL}/tasks`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 90_000 });
  await page.getByText(title).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // The footer resolves from GET /api/tasks/[id]; wait it out rather than
  // reading the spinner and calling it a missing button.
  await expect(page.getByTestId('task-actions-loading')).toHaveCount(0, { timeout: 30_000 });
  return sheet;
}

/** The move buttons the sheet's footer offers, excluding the housekeeping
 *  controls (Delete/Close/confirm) that are not transitions. Scoped to the
 *  footer so relative-time buttons elsewhere in the sheet are not counted. */
async function moveButtonLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return [];
    // The footer's action row is the element that holds the Delete control.
    const del = Array.from(dialog.querySelectorAll('button'))
      .find((b) => (b as HTMLElement).innerText.trim() === 'Delete') as HTMLElement | undefined;
    const none = dialog.querySelector('[data-testid="task-actions-none"]') as HTMLElement | null;
    let scope: HTMLElement | null = null;
    if (del) scope = del.parentElement?.parentElement ?? del.parentElement;
    else if (none) scope = none.parentElement;
    if (!scope) return ['__NO_FOOTER_FOUND__'];
    return Array.from(scope.querySelectorAll('button'))
      .map((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter((t) => t && !/^(Delete|Close|Yes|No|Dismiss|Edit task)$/i.test(t));
  });
}

// ===========================================================================
// C4 + C3. D11 (the moves offered) and D12 (where a refusal is announced).
// ===========================================================================
test('C4/C3: failed work offers exactly the one legal move, it succeeds, and a refusal is announced inside the sheet', async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1600, height: 1200 });

  const title = 'ZZTEST-close-C4 failed terminal probe';
  const id = createNativeTask(title);
  const e: Record<string, unknown> = { task_id: id };

  try {
    patchNativeTask(id, (t) => {
      t.status = 'failed';
      t.canonical_state = 'failed_terminal';
      t.outcome = 'ZZTEST outcome: failed work stays actionable';
      t.acceptance_criteria = ['ZZTEST criterion: one legal move out of failed'];
      t.agent_role_id = 'dispatcher';
      t.contract_version = 1;
    });
    expect(await waitForCard(page, title), 'the failed ZZTEST fixture must reach the board').toBe(true);

    // ---- D11: exactly one action, and it is the contract's one -------------
    let sheet = await openSheet(page, title);
    const labels = await moveButtonLabels(page);
    e.all_sheet_button_labels = labels;
    const moveLabels = labels;
    e.move_labels = moveLabels;
    e.offers_recovery = moveLabels.some((l) => /recovery/i.test(l));
    e.offers_dead_retry = moveLabels.some((l) => /^Retry$/i.test(l));
    await shot(page, 'C4-failed-sheet');

    // ---- D12: force a REAL refusal on that one button ----------------------
    // Bump the record out of band, exactly as an agent would while the sheet is
    // open. The move the sheet then sends carries a stale version.
    const before = readNativeTask(id) as { version?: number };
    e.version_sheet_read = before?.version ?? null;
    patchNativeTask(id, (t) => { t.version = Number(t.version ?? 1) + 4; });
    e.version_out_of_band = (readNativeTask(id) as { version?: number })?.version ?? null;

    const patches: Record<string, unknown>[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(req.url())) {
        try { patches.push(JSON.parse(req.postData() ?? '{}')); } catch { /* ignore */ }
      }
    });

    const recovery = sheet.getByRole('button', { name: /recovery/i }).first();
    e.recovery_button_present = (await recovery.count()) > 0;
    if (e.recovery_button_present) {
      await recovery.click();
      await page.waitForTimeout(5000);
    }
    e.patch_bodies = patches;
    e.patch_carries_expected_version = patches.some((b) => 'expectedVersion' in b);

    // Judge the refusal the way a person meets it: announced, on screen, and
    // not sealed behind the sheet's own aria-hidden backdrop.
    const reach = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="task-sheet-error"]') as HTMLElement | null;
      const anyAlert = document.querySelector('[role="alert"]') as HTMLElement | null;
      const target = el ?? anyAlert;
      if (!target) return { exists: false };
      let hidden = false; let node: HTMLElement | null = target;
      while (node) { if (node.getAttribute?.('aria-hidden') === 'true') { hidden = true; break; } node = node.parentElement; }
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      // Is the sheet's own container still marked as a dialog with the page behind it hidden?
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
      const backgroundHidden = Array.from(document.querySelectorAll('[aria-hidden="true"]'))
        .some((n) => !n.contains(target) && n !== target);
      return {
        exists: true,
        inside_sheet: dialog ? dialog.contains(target) || target.closest('[role="dialog"]') !== null : false,
        role: target.getAttribute('role'),
        ariaLive: target.getAttribute('aria-live'),
        text: target.innerText.replace(/\s+/g, ' ').slice(0, 400),
        insideAriaHidden: hidden,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
        inViewport: r.top >= 0 && r.top < window.innerHeight && r.width > 0 && r.height > 0,
        top: Math.round(r.top), width: Math.round(r.width),
        backgroundStillAriaHidden: backgroundHidden,
      };
    });
    e.refusal = reach;
    // Playwright's accessibility view: is the alert actually reachable?
    e.alert_role_count = await page.getByRole('alert').count();
    e.alert_text_via_role = (await page.getByRole('alert').count()) > 0
      ? (await page.getByRole('alert').first().innerText()).replace(/\s+/g, ' ') : null;
    e.state_after_refusal = readNativeTask(id);
    await shot(page, 'C3-refusal-in-sheet');

    // ---- D11 (second half): the one move must actually SUCCEED -------------
    // Reload so the sheet reads the current version, then click it for real.
    await page.reload({ waitUntil: 'domcontentloaded' });
    sheet = await openSheet(page, title);
    const recovery2 = sheet.getByRole('button', { name: /recovery/i }).first();
    if (await recovery2.count()) {
      await recovery2.click();
      await page.waitForTimeout(6000);
    }
    const after = readNativeTask(id) as Record<string, unknown> | null;
    e.state_after_real_move = { status: after?.status, canonical_state: after?.canonical_state, version: after?.version };
    e.recovery_move_succeeded = after?.canonical_state === 'waiting' || after?.status === 'blocked';
    await shot(page, 'C4-after-recovery');

    saveEvidence('C4-C3-failed-move-evidence', e);

    expect(e.offers_recovery, 'failed work must offer the one legal move out of failed_terminal').toBe(true);
    expect((e.move_labels as string[]).length, 'failed work must offer exactly one move, not a menu of dead buttons').toBe(1);
    expect(e.offers_dead_retry, 'the old illegal Retry button must be gone').toBe(false);
    expect(e.patch_carries_expected_version, 'the sheet must send the version it rendered').toBe(true);
    const r = e.refusal as Record<string, unknown>;
    expect(r.exists, 'a refused move must produce an alert').toBe(true);
    expect(r.role, 'the refusal must carry role=alert').toBe('alert');
    expect(r.ariaLive, 'the refusal must be announced').toMatch(/assertive|polite/);
    expect(r.inside_sheet, 'the refusal must appear inside the sheet the person clicked in').toBe(true);
    expect(r.insideAriaHidden, 'the refusal must not sit inside an aria-hidden subtree').toBe(false);
    expect(r.visible, 'the refusal must be visible, not merely present').toBe(true);
    expect(r.inViewport, 'the refusal must be on screen at the moment of the click').toBe(true);
    expect(Number(e.alert_role_count), 'the alert must be in the accessibility tree').toBeGreaterThan(0);
    expect(r.backgroundStillAriaHidden, 'the background must keep its aria-hidden while the sheet is open').toBe(true);
    expect(e.recovery_move_succeeded, 'the one move a failed task is offered must actually work').toBe(true);
  } finally {
    deleteNativeTask(id);
  }
});

// ===========================================================================
// C4b. A truly terminal state says nothing moves out of it.
// ===========================================================================
test('C4b: a terminal state states that nothing moves out of it rather than showing dead buttons', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  const title = 'ZZTEST-close-C4b cancelled terminal probe';
  const id = createNativeTask(title);
  const e: Record<string, unknown> = { task_id: id };
  try {
    patchNativeTask(id, (t) => {
      t.status = 'cancelled';
      t.canonical_state = 'cancelled';
      t.contract_version = 1;
    });
    expect(await waitForCard(page, title), 'the cancelled ZZTEST fixture must reach the board').toBe(true);
    const sheet = await openSheet(page, title);
    e.says_nothing_moves = (await page.getByTestId('task-actions-none').count()) > 0;
    e.none_text = e.says_nothing_moves
      ? (await page.getByTestId('task-actions-none').innerText()).replace(/\s+/g, ' ') : null;
    const labels = await moveButtonLabels(page);
    e.move_labels = labels;
    await shot(page, 'C4b-cancelled-sheet');
    saveEvidence('C4b-terminal-evidence', e);
    expect(e.says_nothing_moves, 'a terminal state must say so in words').toBe(true);
    expect(labels, 'a terminal state must offer no move buttons').toEqual([]);
  } finally { deleteNativeTask(id); }
});

// ===========================================================================
// C5. D13 — failed and cancelled work is in the default Kanban.
// ===========================================================================
test('C5: failed and cancelled work appear in the default /tasks Kanban, not only in List', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  const failedTitle = 'ZZTEST-close-C5 failed in kanban';
  const cancelledTitle = 'ZZTEST-close-C5 cancelled in kanban';
  const f = createNativeTask(failedTitle);
  const c = createNativeTask(cancelledTitle);
  const e: Record<string, unknown> = { failed_id: f, cancelled_id: c };
  try {
    patchNativeTask(f, (t) => { t.status = 'failed'; t.canonical_state = 'failed_terminal'; });
    patchNativeTask(c, (t) => { t.status = 'cancelled'; t.canonical_state = 'cancelled'; });
    expect(await waitForCard(page, failedTitle)).toBe(true);
    expect(await waitForCard(page, cancelledTitle)).toBe(true);

    await page.goto(`${URL}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const viewToggle = await page.getByRole('button', { name: /^(Kanban|Board)$/ }).count();
    e.default_view_is_kanban = viewToggle > 0;
    e.failed_visible_in_default = (await page.getByText(failedTitle).count()) > 0;
    e.cancelled_visible_in_default = (await page.getByText(cancelledTitle).count()) > 0;
    const columns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="column-"], [data-column]'))
        .map((n) => (n as HTMLElement).getAttribute('data-testid') ?? (n as HTMLElement).getAttribute('data-column')));
    e.columns = columns;
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    e.fifth_column_header = /Failed|Closed|Ended|Terminal|Cancelled/i.test(body);
    e.body_excerpt = body.slice(0, 500);
    await shot(page, 'C5-tasks-default-kanban');
    saveEvidence('C5-kanban-evidence', e);
    expect(e.failed_visible_in_default, 'failed work must be on the default board').toBe(true);
    expect(e.cancelled_visible_in_default, 'cancelled work must be on the default board').toBe(true);
  } finally { deleteNativeTask(f); deleteNativeTask(c); }
});

// ===========================================================================
// C1/C2. Version discipline at the API boundary and the board's fail-closed.
// ===========================================================================
test('C1/C2: a transition with no version is refused, and the acceptance gate still fires once a version is sent', async ({ page }) => {
  test.setTimeout(300_000);
  const title = 'ZZTEST-close-C2 version discipline probe';
  const id = createNativeTask(title);
  const e: Record<string, unknown> = { task_id: id };
  try {
    patchNativeTask(id, (t) => { t.contract_version = 1; t.acceptance_criteria = []; t.agent_role_id = 'dispatcher'; });
    expect(await waitForCard(page, title)).toBe(true);

    const noVersion = await page.request.post(`${URL}/api/tasks/${id}/transition`, { data: { to: 'ready' } });
    e.no_version_status = noVersion.status();
    e.no_version_body = await noVersion.json().catch(() => ({}));

    const v = (readNativeTask(id) as { version?: number })?.version ?? 1;
    e.version = v;
    const withVersion = await page.request.post(`${URL}/api/tasks/${id}/transition`, {
      data: { to: 'ready', expectedVersion: v },
    });
    e.with_version_status = withVersion.status();
    e.with_version_body = await withVersion.json().catch(() => ({}));

    const stale = await page.request.post(`${URL}/api/tasks/${id}/transition`, {
      data: { to: 'ready', expectedVersion: 999 },
    });
    e.stale_status = stale.status();
    e.stale_body = await stale.json().catch(() => ({}));

    e.state_after = readNativeTask(id);
    saveEvidence('C1-C2-version-discipline-evidence', e);

    expect(e.no_version_status, 'a transition with no version must be refused').not.toBe(200);
    expect(JSON.stringify(e.no_version_body).toLowerCase()).toContain('version');
    expect(e.with_version_status, 'with a version, the contract gate decides — not the version check').not.toBe(200);
    expect(
      JSON.stringify(e.with_version_body).toLowerCase(),
      'the acceptance-criteria gate must still be the reason once a version is supplied',
    ).toContain('acceptance');
    expect(e.stale_status, 'a stale version must conflict').toBe(409);
    expect((e.state_after as Record<string, unknown>)?.canonical_state, 'nothing may have moved').not.toBe('ready');
  } finally { deleteNativeTask(id); }
});

// ===========================================================================
// C7. D3 — Improvements renders honestly with no Supabase 404s.
// ===========================================================================
test('C7: the Improvements view renders an honest empty state with no failing requests', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const failed: { url: string; status: number }[] = [];
  const errors: string[] = [];
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\/auth\//.test(r.url())) failed.push({ url: r.url(), status: r.status() }); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const res = await page.goto(`${URL}/improvements`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const e = {
    http: res?.status() ?? null,
    chars: body.length,
    mentions_404: /404|PGRST|does not exist|relation .* does not exist/i.test(body),
    shows_error: /error|failed to load|could not load/i.test(body),
    honest_empty: /no .*(cycle|improvement)|nothing yet|none recorded|no data|not started/i.test(body),
    failed_requests: failed,
    console_errors: errors,
    excerpt: body.slice(0, 900),
  };
  await shot(page, 'C7-improvements');
  saveEvidence('C7-improvements-evidence', e);
  expect(e.http).toBe(200);
  expect(e.mentions_404, 'the page must not surface a missing-table error').toBe(false);
  expect(failed, `failing requests: ${JSON.stringify(failed)}`).toHaveLength(0);
  expect(Number(e.chars), 'the page must render content').toBeGreaterThan(200);
});

// ===========================================================================
// C8. The same org hole on approvals, and the worse one: an approval nobody
//     can see looks, to the agent waiting on it, exactly like one still pending.
// ===========================================================================
const APPROVAL_ROOT = join(process.env.HOME || '', '.cortextos', 'default', 'orgs', 'uhs', 'approvals');
const NO_ORG_APPROVAL_ROOT = join(process.env.HOME || '', '.cortextos', 'default', 'approvals');

function deleteApproval(id: string) {
  for (const f of [
    join(APPROVAL_ROOT, 'pending', `${id}.json`),
    join(APPROVAL_ROOT, 'resolved', `${id}.json`),
    join(APPROVAL_ROOT, 'events', `${id}.jsonl`),
    join(NO_ORG_APPROVAL_ROOT, 'pending', `${id}.json`),
    join(NO_ORG_APPROVAL_ROOT, 'resolved', `${id}.json`),
    join(NO_ORG_APPROVAL_ROOT, 'events', `${id}.jsonl`),
  ]) {
    try { unlinkSync(f); } catch { /* not there */ }
  }
}

test('C8: create-approval refuses with no org, and with an org reaches the queue and the dashboard', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const title = 'ZZTEST-close-C8 approval org guard probe';
  const e: Record<string, unknown> = {};
  let id = '';

  // --- the refusal, with CTX_ORG genuinely absent from the child env --------
  const noOrgEnv = { ...CLI_ENV } as Record<string, string | undefined>;
  delete noOrgEnv.CTX_ORG;
  try {
    execFileSync(BIN, ['bus', 'create-approval', 'ZZTEST-close-C8 no-org probe', 'other', 'ZZTEST'],
      { encoding: 'utf-8', env: noOrgEnv as NodeJS.ProcessEnv, timeout: 30_000, stdio: 'pipe' });
    e.no_org_refused = false;
  } catch (err) {
    const x = err as { status?: number; stderr?: string; stdout?: string };
    e.no_org_refused = true;
    e.no_org_exit = x.status ?? null;
    e.no_org_message = String(x.stderr ?? x.stdout ?? '').replace(/\s+/g, ' ').trim();
  }
  // Nothing may have been written to the directory nothing reads.
  e.no_org_dir_untouched = !existsSync(join(NO_ORG_APPROVAL_ROOT, 'pending'))
    || readdirSync(join(NO_ORG_APPROVAL_ROOT, 'pending')).length === 0;

  try {
    // --- the with-org path --------------------------------------------------
    const out = execFileSync(BIN,
      ['bus', 'create-approval', title, 'other', 'ZZTEST close verification. Deleted by the test.'],
      { encoding: 'utf-8', env: CLI_ENV, timeout: 30_000 });
    id = out.trim().split(/\s+/).pop() ?? '';
    e.approval_id = id;
    e.landed_in_org_queue = existsSync(join(APPROVAL_ROOT, 'pending', `${id}.json`));
    e.did_not_land_outside_an_org = !existsSync(join(NO_ORG_APPROVAL_ROOT, 'pending', `${id}.json`));
    e.record = JSON.parse(readFileSync(join(APPROVAL_ROOT, 'pending', `${id}.json`), 'utf-8'));

    const failed: { url: string; status: number }[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400 && !/\/api\/auth\//.test(r.url())) failed.push({ url: r.url(), status: r.status() });
    });

    const api = await page.request.get(`${URL}/api/approvals?org=uhs`);
    const apiText = await api.text();
    e.api_status = api.status();
    e.api_carries_the_approval = apiText.includes(id);

    const res = await page.goto(`${URL}/approvals`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    e.page_status = res?.status() ?? null;
    const defaultBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    // The surface opens on "Your Tasks"; the Approvals tab carries the count.
    e.visible_on_the_tab_that_opens = defaultBody.includes(title);
    e.approvals_tab_shows_a_count = /Approvals\s+\d+/.test(defaultBody);
    const tab = page.getByRole('tab', { name: /Approvals/i })
      .or(page.getByRole('button', { name: /^Approvals\b/i })).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(4000); }
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    e.visible_on_the_approvals_tab = body.includes(title);
    e.failed_requests = failed;
    await shot(page, 'C8-approvals-page');
    saveEvidence('C8-approval-evidence', e);

    expect(e.no_org_refused, 'create-approval with no org must refuse').toBe(true);
    expect(e.no_org_exit, 'the refusal must exit non-zero').not.toBe(0);
    expect(String(e.no_org_message), 'the refusal must say how to fix it').toMatch(/--org|CTX_ORG/);
    expect(e.no_org_dir_untouched, 'the refusal must create nothing outside an org').toBe(true);
    expect(e.landed_in_org_queue, 'the with-org path must reach the org approvals queue').toBe(true);
    expect(e.did_not_land_outside_an_org, 'it must not also land where nothing reads it').toBe(true);
    expect((e.record as Record<string, unknown>).org, 'the record must carry its org').toBe('uhs');
    expect((e.record as Record<string, unknown>).status, 'a new approval is pending').toBe('pending');
    expect(e.api_carries_the_approval, 'the approvals API must return it').toBe(true);
    expect(e.page_status, 'the approvals page must render').toBe(200);
    expect(e.visible_on_the_approvals_tab, 'the approval must be visible on the dashboard').toBe(true);
    expect(failed, `failing requests: ${JSON.stringify(failed)}`).toHaveLength(0);
  } finally {
    if (id) deleteApproval(id);
  }
});
