import { Command } from 'commander';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import { clearHaltMarker, haltMarkerPath, listHaltedAgents, readHaltMarker } from '../daemon/halt-marker.js';

/**
 * `cortextos unhalt <agent>` — the ONLY way a durable halt is cleared
 * (fleet-stability §A4.2).
 *
 * A halted agent carries a `.halted` marker that `AgentProcess.start()` refuses
 * to spawn past, so daemon boot, crons, IPC start-agent and
 * `cortextos restart <agent>` all leave it halted on purpose. Clearing is an
 * explicit operator decision and lives here, in the CLI, deliberately: the
 * daemon has no code path that removes the marker, which is what makes the halt
 * durable rather than merely long-lived.
 *
 * Clearing the marker alone is not enough to make the agent viable again. The
 * daily crash counter is ALSO persisted (`logs/<agent>/.crash_count_today`), and
 * trillion-coder's stood at 12 against a cap of 10 — so an unhalt that left it
 * in place would be undone by the very first crash. Both are cleared together,
 * unless --keep-crash-count says otherwise.
 */
export const unhaltCommand = new Command('unhalt')
  .argument('[agent]', 'Agent to un-halt (omit to list halted agents)')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--no-start', 'Clear the halt but do not start the agent')
  .option('--keep-crash-count', "Keep today's persisted crash count instead of resetting it")
  .description('Clear an agent\'s durable halt marker and start it again')
  .action(async (agent: string | undefined, options: {
    instance: string;
    start?: boolean;
    keepCrashCount?: boolean;
  }) => {
    const ctxRoot = join(homedir(), '.cortextos', options.instance);

    if (!agent) {
      const halted = listHaltedAgents(ctxRoot);
      if (halted.length === 0) {
        console.log('No halted agents.');
        return;
      }
      console.log('\n  Halted agents\n');
      for (const m of halted) {
        console.log(`  ${m.agent}  since ${m.since}  — ${m.reason}`);
      }
      console.log('\n  Clear one with: cortextos unhalt <agent>\n');
      return;
    }

    const marker = readHaltMarker(ctxRoot, agent);
    if (!marker) {
      console.log(`${agent} is not halted (no marker at ${haltMarkerPath(ctxRoot, agent)}).`);
    } else {
      const cleared = clearHaltMarker(ctxRoot, agent);
      if (!cleared) {
        console.error(`Failed to remove ${haltMarkerPath(ctxRoot, agent)} — check permissions.`);
        process.exit(1);
      }
      console.log(`Cleared halt for ${agent} (halted since ${marker.since} — ${marker.reason}).`);
    }

    if (!options.keepCrashCount) {
      const crashFile = join(ctxRoot, 'logs', agent, '.crash_count_today');
      try {
        if (existsSync(crashFile)) {
          unlinkSync(crashFile);
          console.log(`  Reset today's crash count (${crashFile}).`);
        }
      } catch (err) {
        console.error(`  Could not reset the crash count: ${err}`);
      }
    }

    if (options.start === false) {
      console.log(`  Not starting ${agent} (--no-start). Start it with: cortextos start ${agent}`);
      return;
    }

    const ipc = new IPCClient(options.instance);
    if (!(await ipc.isDaemonRunning())) {
      console.log(`  Daemon is not running. Start it with: cortextos start`);
      return;
    }
    const response = await ipc.send({ type: 'start-agent', agent, source: 'cortextos unhalt' });
    if (response.success) {
      console.log(`  ${response.data}`);
    } else {
      console.error(`  Error: ${response.error}`);
    }
  });
