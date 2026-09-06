// Wave-3 telemetry screenshots. Creds come from the env of the calling shell
// (sourced from dashboard.env) and are never written to disk or printed.
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const OUT = process.env.SHOT_OUT;
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'cortextos';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(name, width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    permissions: [],
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  // Field names vary; fill by type.
  const user = page.locator('input[name="username"], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  await user.fill(USER);
  await pass.fill(PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 }).catch(() => {}),
    page.locator('button[type="submit"]').first().click(),
  ]);

  await page.goto(`${BASE}/jarvis`, { waitUntil: 'domcontentloaded' });
  // Wait for the telemetry fetch to land, then let the scene settle.
  await page
    .waitForSelector('[data-testid="telemetry-panel"], [data-testid="telemetry-panel-mobile"]', { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(6000);

  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });

  const readout = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      median: t('[data-testid="telemetry-median"]'),
      mtd: t('[data-testid="telemetry-mtd-total"]'),
      mtdMobile: t('[data-testid="telemetry-mtd-mobile"]'),
      savings: t('[data-testid="telemetry-cache-savings"]'),
      sparkline: !!document.querySelector('[data-testid="telemetry-sparkline"]'),
    };
  });
  console.log(name, JSON.stringify(readout));
  await ctx.close();
}

await shot('telemetry-desktop-1440x900', 1440, 900);
await shot('telemetry-mobile-390x844', 390, 844);
await browser.close();
