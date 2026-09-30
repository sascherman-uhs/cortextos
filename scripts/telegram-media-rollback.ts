/**
 * scripts/telegram-media-rollback.ts
 *
 * Queue-preserving drain gate for rolling back the Telegram media-race fix
 * (A0, 2026-09-30) — or any daemon change that alters what a raw media record
 * on disk means.
 *
 * Why a gate: code before A0 reads a raw media record (`formatted === ''`) as
 * "the daemon died" and terminalizes it; code after A0 reads it as "a download
 * is in flight". Restarting onto the old code while a download is in flight
 * would silently drop that photo — the exact outage A0 fixed. So:
 *
 *   1. create state/<agent>/telegram-intake-paused; the poller finishes its
 *      current getUpdates batch and stops polling (downloads, the checker and
 *      injection keep running) and acknowledges in telegram-intake-status.json;
 *   2. wait until unfinished media records == 0 AND the daemon's outstanding
 *      media job counter == 0, for up to 2 x TELEGRAM_MEDIA_GRACE_MS;
 *   3. not drained => ABORT: remove the pause file; the running daemon is
 *      untouched and resumes polling. Exit code 2;
 *   4. drained => exit 0 with the pause file LEFT in place, and print the
 *      revert + restart steps. This script never restarts anything itself —
 *      the daemon restart is /restart-cortexos, run by the operator.
 *
 * A missing, stale or foreign (different pid / start time) status file is
 * never read as drained.
 *
 * Usage:
 *   npx tsx scripts/telegram-media-rollback.ts --agent jarvis-telegram
 *   npx tsx scripts/telegram-media-rollback.ts --agent jarvis-telegram --instance default
 *   npx tsx scripts/telegram-media-rollback.ts --agent jarvis-telegram --status    # one check, no pause
 *   npx tsx scripts/telegram-media-rollback.ts --agent jarvis-telegram --release   # remove the pause file
 *
 * Exit codes: 0 drained (safe to revert + restart) · 2 not drained (aborted,
 * pause removed) · 1 usage/other error.
 */
import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  INTAKE_PAUSE_FILE,
  evaluateDrain,
  runRollbackDrain,
  systemProcessProbe,
} from '../src/telegram/intake-control.js';
import { mediaGraceMs } from '../src/telegram/pending-queue.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const agent = arg('agent');
  if (!agent) {
    console.error('usage: telegram-media-rollback.ts --agent <name> [--instance <id>] [--ctx-root <dir>] [--status | --release]');
    return 1;
  }
  const instance = arg('instance') ?? process.env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = arg('ctx-root') ?? join(homedir(), '.cortextos', instance);
  const stateDir = join(ctxRoot, 'state', agent);
  const pausePath = join(stateDir, INTAKE_PAUSE_FILE);

  if (process.argv.includes('--release')) {
    if (existsSync(pausePath)) {
      unlinkSync(pausePath);
      console.log(`Removed ${pausePath} — intake resumes on the next poll.`);
    } else {
      console.log(`${pausePath} does not exist — intake is not paused.`);
    }
    return 0;
  }

  if (process.argv.includes('--status')) {
    const requestedAt = existsSync(pausePath) ? statSync(pausePath).mtimeMs : Number.POSITIVE_INFINITY;
    const v = evaluateDrain({ stateDir, pauseRequestedAtMs: requestedAt, now: Date.now(), probe: systemProcessProbe });
    console.log(JSON.stringify(v, null, 2));
    return v.drained ? 0 : 2;
  }

  const grace = mediaGraceMs();
  const timeoutMs = 2 * grace;
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; });
  console.log(`Pausing Telegram intake for ${agent} and waiting up to ${Math.round(timeoutMs / 1000)}s for media to drain…`);
  const res = await runRollbackDrain({
    stateDir,
    timeoutMs,
    log: (m) => console.log(`  ${m}`),
    aborted: () => interrupted,
  });

  if (!res.drained) {
    console.log(`\nABORTED: ${res.reason}`);
    console.log('The running daemon was not touched. Do NOT revert/restart now; try again later.');
    return 2;
  }

  console.log(`
DRAINED — no unfinished media records and no media jobs running for ${agent}.
Telegram intake stays PAUSED (${pausePath}) until you finish. Next, in ~/cortextos:

  1. git revert <the A0 commit>        # or check out the rollback target
  2. npm run build
  3. /restart-cortexos                  # restarts the daemon + all agents
  4. npx tsx scripts/telegram-media-rollback.ts --agent ${agent} --release

Code without the pause control polls regardless, so step 4 is hygiene there; with
it, step 4 is what resumes intake. If you decide NOT to roll back, run step 4 now —
until you do, ${agent} takes no new Telegram messages.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
