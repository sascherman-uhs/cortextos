/**
 * `cortextos ingress …` — operator control for OS-07's multiplexed Telegram
 * ingress.
 *
 * Every bot starts OFF. Installing this package changes nothing: with no flag
 * and no fence file, each agent keeps starting its own poller exactly as it
 * did before. A bot only moves when someone runs `ingress enable <bot>`.
 *
 *   cortextos ingress list                  every configured bot identity
 *   cortextos ingress status [--bot <bot>]  owner, fence token, checkpoint
 *   cortextos ingress enable <bot>          fenced cutover to ingress
 *   cortextos ingress disable <bot>         fenced revert to the agent poller
 *
 * `enable`/`disable` prefer the running daemon over IPC, because only the
 * daemon can stop the in-process poller mid-sequence. With the daemon down the
 * command still works — there is no live poller to stop — and the daemon
 * honours the fence on its next start.
 */

import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { IPCClient } from '../daemon/ipc-server.js';
import { enumerateBotIdentities, describeIdentity, type BotIdentity } from '../ingress/identity.js';
import { resolveIngressPaths, type IngressPaths } from '../ingress/state.js';
import { readFence, readOffset } from '../ingress/fence.js';
import { enableMultiplexed, revertToAgent, loadFlags, legacyOffsetPath, type TransferResult } from '../ingress/cutover.js';
import { listRecords } from '../ingress/dispatch.js';

interface CommonOpts {
  org?: string;
  root?: string;
  instance?: string;
  json?: boolean;
}

function ctxFrom(opts: CommonOpts): { paths: IngressPaths; frameworkRoot: string; org: string; instanceId: string } {
  const instanceId = opts.instance || process.env.CTX_INSTANCE_ID || 'default';
  const org = opts.org || process.env.CTX_ORG || 'uhs';
  const frameworkRoot = opts.root || process.env.CTX_FRAMEWORK_ROOT || join(homedir(), 'cortextos');
  const paths = resolveIngressPaths({ org, instanceId });
  return { paths, frameworkRoot, org, instanceId };
}

function out(json: boolean | undefined, payload: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function statusRows(paths: IngressPaths, identities: BotIdentity[]) {
  const flags = loadFlags(paths);
  return identities.map((identity) => {
    const fence = readFence(paths, identity.id);
    return {
      bot: identity.id,
      source: identity.source,
      enabled: identity.enabled,
      usable: identity.usable,
      reason: identity.reason,
      token_env_key: identity.tokenEnvKey,
      allowed_user_count: identity.allowedUserIds.length,
      owner: fence.owner,
      fence_state: fence.state,
      fence_token: fence.fence_token,
      checkpoint_offset: fence.checkpoint_offset,
      ingress_offset: readOffset(paths, identity.id),
      flag_multiplexed: flags.bots[identity.id]?.multiplexed === true,
    };
  });
}

async function runTransfer(
  bot: string,
  direction: 'ingress' | 'agent',
  opts: CommonOpts & { actor?: string; reason?: string },
): Promise<{ viaDaemon: boolean; result: TransferResult | Record<string, unknown>; ok: boolean; error?: string }> {
  const { paths, instanceId } = ctxFrom(opts);
  const client = new IPCClient(instanceId);
  if (await client.isDaemonRunning()) {
    const response = await client.send({
      type: 'ingress-transfer',
      agent: bot,
      data: { direction, actor: opts.actor, reason: opts.reason },
      source: `cortextos ingress ${direction === 'ingress' ? 'enable' : 'disable'}`,
    });
    return {
      viaDaemon: true,
      ok: response.success,
      result: (response.data ?? {}) as Record<string, unknown>,
      ...(response.error ? { error: response.error } : {}),
    };
  }
  const transferOpts = {
    legacyOffsetFile: legacyOffsetPath(paths, bot),
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  const result = direction === 'ingress'
    ? await enableMultiplexed(paths, bot, transferOpts)
    : await revertToAgent(paths, bot, transferOpts);
  return { viaDaemon: false, ok: result.ok, result, ...(result.error ? { error: result.error } : {}) };
}

export const ingressCommand = new Command('ingress')
  .description('Multiplexed Telegram ingress: identities, ownership fences and cutover')
  .option('--org <org>', 'Org name (default: CTX_ORG or uhs)')
  .option('--root <path>', 'Framework root holding orgs/<org>/agents')
  .option('--instance <id>', 'cortextOS instance id (default: default)');

ingressCommand
  .command('list')
  .description('List every configured bot identity, by token env key name')
  .option('--json', 'Machine-readable output')
  .action((cmdOpts: { json?: boolean }) => {
    const opts = { ...ingressCommand.opts(), ...cmdOpts } as CommonOpts;
    const { frameworkRoot, org } = ctxFrom(opts);
    const identities = enumerateBotIdentities(frameworkRoot, org);
    out(opts.json, identities, () => {
      if (identities.length === 0) {
        console.log(`No bot identities found under ${frameworkRoot}/orgs/${org}.`);
        return;
      }
      for (const identity of identities) console.log(`  ${describeIdentity(identity)}`);
    });
  });

ingressCommand
  .command('status')
  .description('Show ownership, fence token and checkpoint for each bot')
  .option('--bot <bot>', 'Limit to one bot identity')
  .option('--json', 'Machine-readable output')
  .action((cmdOpts: { bot?: string; json?: boolean }) => {
    const opts = { ...ingressCommand.opts(), ...cmdOpts } as CommonOpts;
    const { paths, frameworkRoot, org } = ctxFrom(opts);
    const all = enumerateBotIdentities(frameworkRoot, org);
    const identities = cmdOpts.bot ? all.filter((i) => i.id === cmdOpts.bot) : all;
    const rows = statusRows(paths, identities);
    const queue = listRecords(paths);
    const payload = {
      org,
      ingress_state_root: paths.root,
      bots: rows,
      dispatch: {
        pending: queue.filter((r) => r.state === 'pending').length,
        leased: queue.filter((r) => r.state === 'leased').length,
        failed: queue.filter((r) => r.state === 'failed').length,
      },
    };
    out(cmdOpts.json, payload, () => {
      for (const row of rows) {
        console.log(
          `  ${row.bot.padEnd(22)} owner=${row.owner.padEnd(8)} ${row.fence_state.padEnd(12)} ` +
          `fence=${row.fence_token} checkpoint=${row.checkpoint_offset} ` +
          `flag=${row.flag_multiplexed ? 'on' : 'off'}${row.usable ? '' : `  UNUSABLE: ${row.reason}`}`,
        );
      }
      console.log(
        `  dispatch queue: ${payload.dispatch.pending} pending, ` +
        `${payload.dispatch.leased} leased, ${payload.dispatch.failed} failed`,
      );
    });
  });

ingressCommand
  .command('enable <bot>')
  .description('Fenced cutover: move this bot from its agent poller to ingress')
  .option('--actor <who>', 'Who authorised the change (recorded in the flag store)')
  .option('--reason <why>', 'Why (recorded in the flag store and the fence journal)')
  .option('--json', 'Machine-readable output')
  .action(async (bot: string, cmdOpts: { actor?: string; reason?: string; json?: boolean }) => {
    const opts = { ...ingressCommand.opts(), ...cmdOpts } as CommonOpts & { actor?: string; reason?: string };
    const res = await runTransfer(bot, 'ingress', opts);
    out(cmdOpts.json, res, () => {
      if (res.ok) {
        console.log(`${bot}: now owned by multiplexed ingress${res.viaDaemon ? ' (daemon stopped the old poller)' : ' (daemon not running; it will honour the fence on next start)'}.`);
      } else {
        console.error(`${bot}: cutover did NOT complete — ${res.error}`);
      }
    });
    if (!res.ok) process.exitCode = 1;
  });

ingressCommand
  .command('disable <bot>')
  .description('Fenced revert: hand this bot back to its agent-owned poller')
  .option('--actor <who>', 'Who authorised the change')
  .option('--reason <why>', 'Why')
  .option('--json', 'Machine-readable output')
  .action(async (bot: string, cmdOpts: { actor?: string; reason?: string; json?: boolean }) => {
    const opts = { ...ingressCommand.opts(), ...cmdOpts } as CommonOpts & { actor?: string; reason?: string };
    const res = await runTransfer(bot, 'agent', opts);
    out(cmdOpts.json, res, () => {
      if (res.ok) {
        console.log(
          `${bot}: handed back to the agent-owned poller with the same checkpoint. ` +
          `Restart the agent to bring its listener back up: cortextos restart ${bot}`,
        );
      } else {
        console.error(`${bot}: revert did NOT complete — ${res.error}`);
      }
    });
    if (!res.ok) process.exitCode = 1;
  });
