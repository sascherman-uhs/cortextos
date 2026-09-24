import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import type { AgentStatus, Heartbeat } from '../types/index.js';
import { listHaltedAgents } from '../daemon/halt-marker.js';

export const statusCommand = new Command('status')
  .option('--instance <id>', 'Instance ID')
  .option('--json', 'Emit machine-readable JSON (includes halted agents)')
  .description('Show agent health and status')
  .action(async (options: { instance?: string; json?: boolean }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ipc = new IPCClient(instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    // fleet-stability §A4.3: halted agents are read off disk, not from the
    // daemon, so they stay visible even when the daemon is down — and so an
    // external briefing script can consume `cortextos status --json`.
    const halted = listHaltedAgents(ctxRoot);

    if (options.json) {
      let statuses: AgentStatus[] = [];
      if (daemonRunning) {
        const response = await ipc.send({ type: 'status', source: 'cortextos status --json' });
        if (response.success) statuses = response.data as AgentStatus[];
      }
      console.log(JSON.stringify({
        instance: instanceId,
        daemonRunning,
        agents: statuses,
        halted,
      }, null, 2));
      return;
    }

    if (daemonRunning) {
      // Get live status from daemon
      const response = await ipc.send({ type: 'status', source: 'cortextos status' });
      if (response.success) {
        const statuses = response.data as AgentStatus[];
        displayStatuses(statuses);
      }
      reportHalted(halted);
    } else {
      // Fall back to reading heartbeat files
      console.log('Daemon is not running. Showing last known heartbeats:\n');
      const stateDir = join(ctxRoot, 'state');

      if (!existsSync(stateDir)) {
        console.log('  No heartbeat data found.');
        console.log('  Start with: cortextos start');
        return;
      }

      const agentDirs = readdirSync(stateDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      if (agentDirs.length === 0) {
        console.log('  No agents have reported heartbeats.');
        return;
      }

      const rows: Array<{ agent: string; status: string; age: string; task: string }> = [];
      for (const agent of agentDirs) {
        const hbPath = join(stateDir, agent, 'heartbeat.json');
        try {
          const hb: Heartbeat = JSON.parse(readFileSync(hbPath, 'utf-8'));
          const ts = hb.last_heartbeat || hb.timestamp || new Date().toISOString();
          const age = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
          const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
          rows.push({
            agent: hb.agent || agent,
            status: hb.status || 'unknown',
            age: ageStr,
            task: hb.current_task ? hb.current_task.substring(0, 30) : '-',
          });
        } catch {
          // Skip agents without heartbeat
        }
      }

      if (rows.length === 0) {
        console.log('  No agents have reported heartbeats.');
      } else {
        console.log('\n  Last Known Heartbeats\n');
        const header = '  Name              Status      Last Seen    Current Task';
        const separator = '  ' + '-'.repeat(header.length - 2);
        console.log(header);
        console.log(separator);
        for (const r of rows) {
          const name = r.agent.padEnd(18);
          const status = r.status.padEnd(12);
          const age = r.age.padEnd(13);
          console.log(`  ${name}${status}${age}${r.task}`);
        }
        console.log('');
      }
      reportHalted(halted);
    }
  });

/**
 * fleet-stability §A4.3: a durable halt must never be silent. HALTED is
 * printed as its own block, uppercase and with the age, because in the plain
 * status table it read as just another lowercase word next to 'running' and
 * 'stopped' — and because a halted agent's row disappears entirely when the
 * daemon is down, which is exactly when it matters most.
 */
function reportHalted(halted: Array<{ agent: string; since: string; reason: string }>): void {
  if (halted.length === 0) return;
  console.log('  ⚠️  HALTED — will NOT restart on daemon boot, cron, or restart\n');
  for (const m of halted) {
    const since = Date.parse(m.since);
    const age = Number.isFinite(since)
      ? formatUptime(Math.max(0, Math.floor((Date.now() - since) / 1000)))
      : 'unknown';
    console.log(`    ${m.agent.padEnd(20)} HALTED ${age} ago — ${m.reason}`);
  }
  console.log('\n    Clear with: cortextos unhalt <agent>\n');
}

function displayStatuses(statuses: AgentStatus[]): void {
  if (statuses.length === 0) {
    console.log('No agents running.');
    console.log('Add one with: cortextos add-agent <name>');
    return;
  }

  console.log('\n  Agent Status\n');

  // Table header
  const header = '  Name              Status      PID       Uptime      Model';
  const separator = '  ' + '-'.repeat(header.length - 2);
  console.log(header);
  console.log(separator);

  for (const s of statuses) {
    const name = s.name.padEnd(18);
    // Uppercase HALTED so a durable halt does not read as one more lowercase
    // word among 'running' / 'stopped' (fleet-stability §A4.3).
    const status = (s.status === 'halted' ? 'HALTED' : s.status).padEnd(12);
    const pid = (s.pid?.toString() || '-').padEnd(10);
    const uptime = s.uptime ? formatUptime(s.uptime).padEnd(12) : '-'.padEnd(12);
    const model = s.model || '-';
    console.log(`  ${name}${status}${pid}${uptime}${model}`);
  }

  console.log('');
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
