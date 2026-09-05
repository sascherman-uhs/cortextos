/**
 * `cortextos model …` — the one place a human or an agent changes which model
 * runs behind a role, an agent, or a JARVIS call site.
 *
 * Every verb here goes through `src/bus/model-registry.ts`, so the dashboard
 * (which calls the same service) and the CLI cannot drift apart. Every mutating
 * verb does a CAS write and journals an event; none of them edits an agent's
 * `config.json`.
 */

import { Command } from 'commander';
import {
  DEFAULT_ORG,
  applyOperation,
  listAttempts,
  listEvents,
  loadRegistry,
  migrateBootstrap,
  probeEntryHealth,
  recordAttempt,
  resolve as resolveModel,
  resolveRegistryPaths,
  updateAttemptObserved,
  type HealthResult,
  type ModelOperation,
  type RegistryContext,
} from '../bus/model-registry.js';
import type { ModelActivationMode, ModelResolution } from '../types/index.js';

function ctxFrom(opts: { org?: string; root?: string; instance?: string }): RegistryContext {
  return {
    ...(opts.org ? { org: opts.org } : {}),
    ...(opts.root ? { root: opts.root } : {}),
    ...(opts.instance ? { instanceId: opts.instance } : {}),
  };
}

function out(json: boolean, payload: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    human();
  }
}

function die(json: boolean, message: string): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exit(1);
}

function printResolution(res: ModelResolution): void {
  console.log(`registry revision : ${res.registry_revision}`);
  console.log(`activation        : ${res.activation}`);
  console.log(`role              : ${res.role ?? '(none)'}`);
  console.log(`requested         : ${res.requested.source} ${res.requested.entry_id ?? res.requested.tier ?? ''}`);
  console.log(`candidates        : ${res.candidates.join(', ') || '(none)'}`);
  console.log(
    `selected          : ${res.selected ? `${res.selected.entry_id} → ${res.selected.model_id} ` +
      `(${res.selected.runtime_adapter}, ${res.selected.billing_mode}, cost ${res.selected.cost_class})` : 'NONE'}`,
  );
  if (res.legacy_effective) {
    console.log(`legacy config     : model=${res.legacy_effective.model_id ?? '-'} runtime=${res.legacy_effective.runtime ?? '-'}`);
  }
  console.log(`validation        : ${res.validation.ok ? 'ok' : 'FAILED'}`);
  for (const e of res.validation.errors) console.log(`  error   [${e.code}] ${e.message}`);
  for (const w of res.validation.warnings) console.log(`  warning ${w}`);
}

export const modelCommand = new Command('model')
  .description('Model routing: registry, resolution, switches, pins, provenance');

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

modelCommand
  .command('list')
  .description('List registry entries, tiers, roles and agent assignments')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root (defaults to CTX_FRAMEWORK_ROOT)')
  .action((opts: { json?: boolean; org?: string; root?: string }) => {
    const ctx = ctxFrom(opts);
    let reg;
    try {
      reg = loadRegistry(ctx);
    } catch (err) {
      die(!!opts.json, (err as Error).message);
    }
    out(!!opts.json, reg, () => {
      console.log(`Registry ${resolveRegistryPaths(ctx).registryPath}`);
      console.log(`revision ${reg.revision}  org default tier: ${reg.org_default_tier}  activation: ${reg.activation.org_default}`);
      console.log('\nEntries:');
      for (const [id, e] of Object.entries(reg.entries)) {
        console.log(
          `  ${id.padEnd(24)} ${e.model_id.padEnd(28)} ${e.runtime_adapter.padEnd(18)} ` +
          `${e.status.padEnd(12)} cost ${e.cost_class}  ${e.billing_mode}`,
        );
      }
      console.log('\nTiers:');
      for (const [t, ids] of Object.entries(reg.tiers)) console.log(`  ${t.padEnd(10)} ${ids.join(', ')}`);
      console.log('\nAgents:');
      for (const [name, a] of Object.entries(reg.agents)) {
        const pin = a.pin ? ` pin=${a.pin.entry_id} (${a.pin.kind}${a.pin.expires_at ? `, expires ${a.pin.expires_at}` : ''})` : '';
        console.log(`  ${name.padEnd(22)} role=${a.role}${pin}`);
      }
    });
  });

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

modelCommand
  .command('resolve')
  .description('Resolve the model for an agent, role or call site')
  .option('--agent <agent>', 'Agent name')
  .option('--role <role>', 'Role id')
  .option('--callsite <id>', 'JARVIS call-site id')
  .option('--override-tier <tier>', 'Authorized task override: tier')
  .option('--override-entry <entry>', 'Authorized task override: entry id')
  .option('--actor <actor>', 'Actor for an override', 'scott')
  .option('--reason <reason>', 'Reason for an override', '')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .action((opts: Record<string, string | boolean | undefined>) => {
    const json = !!opts.json;
    if (!opts.agent && !opts.role && !opts.callsite) {
      die(json, 'One of --agent, --role or --callsite is required');
    }
    const ctx = ctxFrom(opts as { org?: string; root?: string });
    try {
      const res = resolveModel(
        {
          ...(opts.agent ? { agent: String(opts.agent) } : {}),
          ...(opts.role ? { role: String(opts.role) } : {}),
          ...(opts.callsite ? { callsite: String(opts.callsite) } : {}),
          ...(opts.overrideTier || opts.overrideEntry
            ? {
                override: {
                  ...(opts.overrideTier ? { tier: String(opts.overrideTier) } : {}),
                  ...(opts.overrideEntry ? { entry_id: String(opts.overrideEntry) } : {}),
                  actor: String(opts.actor || 'scott'),
                  reason: String(opts.reason || 'cli override'),
                },
              }
            : {}),
        },
        ctx,
      );
      out(json, res, () => printResolution(res));
      if (!res.validation.ok) process.exitCode = 2;
    } catch (err) {
      die(json, (err as Error).message);
    }
  });

// ---------------------------------------------------------------------------
// switch / pin / unpin / activation / revert
// ---------------------------------------------------------------------------

async function runOperation(
  op: ModelOperation,
  opts: { json?: boolean; org?: string; root?: string; instance?: string; restart?: boolean },
): Promise<void> {
  const json = !!opts.json;
  try {
    const receipt = await applyOperation(op, { ...ctxFrom(opts), // commander maps `--no-restart` to `restart === false`.
      skipRestart: opts.restart === false });
    out(json, receipt, () => {
      console.log(`operation ${receipt.operation_id} (${receipt.kind}) → ${receipt.state}`);
      console.log(`revision  ${receipt.registry_revision_before} → ${receipt.registry_revision_after}`);
      console.log(`affected  ${receipt.affected_consumers.join(', ') || '(none)'}`);
      for (const r of receipt.restart_results) {
        console.log(`  restart ${r.agent}: ${r.ok ? 'ok' : 'FAILED'} — ${r.detail}${r.observed_after ? ` (now ${r.observed_after})` : ''}`);
      }
      if (receipt.error) console.log(`error     ${receipt.error}`);
    });
    if (receipt.state !== 'applied') process.exitCode = 2;
  } catch (err) {
    die(json, (err as Error).message);
  }
}

modelCommand
  .command('switch')
  .description('Move a role onto a different tier (restarts affected agents)')
  .requiredOption('--role <role>', 'Role id')
  .requiredOption('--tier <tier>', 'Target tier')
  .requiredOption('--reason <reason>', 'Why this change is being made')
  .option('--actor <actor>', 'Who is making the change', 'scott')
  .option('--expected-revision <n>', 'CAS guard: registry revision you read')
  .option('--clear-pins', 'Also clear pins on agents in this role so the tier takes effect')
  .option('--no-restart', 'Write the desired route without restarting agents')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    await runOperation(
      {
        kind: 'switch',
        role: String(opts.role),
        tier: String(opts.tier),
        actor: String(opts.actor || 'scott'),
        reason: String(opts.reason),
        ...(opts.expectedRevision !== undefined ? { expectedRevision: Number(opts.expectedRevision) } : {}),
        clearPins: !!opts.clearPins,
      },
      opts as never,
    );
  });

modelCommand
  .command('pin')
  .description('Pin one agent to a specific registry entry')
  .requiredOption('--agent <agent>', 'Agent name')
  .requiredOption('--entry <entry>', 'Registry entry id')
  .requiredOption('--reason <reason>', 'Why this pin exists')
  .option('--expires-at <iso>', 'When the pin expires (ISO 8601). Omit for no expiry.')
  .option('--fallback <ids>', 'Comma-separated authorized fallback entry ids')
  .option('--actor <actor>', 'Who is making the change', 'scott')
  .option('--expected-revision <n>', 'CAS guard')
  .option('--no-restart', 'Write the desired route without restarting the agent')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    await runOperation(
      {
        kind: 'pin',
        agent: String(opts.agent),
        entry_id: String(opts.entry),
        actor: String(opts.actor || 'scott'),
        reason: String(opts.reason),
        expiresAt: opts.expiresAt ? String(opts.expiresAt) : null,
        ...(opts.fallback ? { fallback: String(opts.fallback).split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(opts.expectedRevision !== undefined ? { expectedRevision: Number(opts.expectedRevision) } : {}),
      },
      opts as never,
    );
  });

modelCommand
  .command('unpin')
  .description('Clear an agent pin so it inherits its role tier again')
  .requiredOption('--agent <agent>', 'Agent name')
  .requiredOption('--reason <reason>', 'Why the pin is being cleared')
  .option('--actor <actor>', 'Who is making the change', 'scott')
  .option('--expected-revision <n>', 'CAS guard')
  .option('--no-restart', 'Write the desired route without restarting the agent')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    await runOperation(
      {
        kind: 'unpin',
        agent: String(opts.agent),
        actor: String(opts.actor || 'scott'),
        reason: String(opts.reason),
        ...(opts.expectedRevision !== undefined ? { expectedRevision: Number(opts.expectedRevision) } : {}),
      },
      opts as never,
    );
  });

modelCommand
  .command('activation')
  .description('Move a consumer (or the whole org) between shadow and enforced')
  .option('--consumer <name>', 'Agent name or call-site id')
  .option('--org-wide', 'Change the org default instead of one consumer')
  .requiredOption('--mode <mode>', 'shadow | enforced')
  .requiredOption('--reason <reason>', 'Why the activation is changing')
  .option('--actor <actor>', 'Who is making the change', 'scott')
  .option('--expected-revision <n>', 'CAS guard')
  .option('--no-restart', 'Do not restart agents')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const mode = String(opts.mode);
    if (mode !== 'shadow' && mode !== 'enforced') die(!!opts.json, '--mode must be shadow or enforced');
    await runOperation(
      {
        kind: 'activation',
        ...(opts.consumer ? { consumer: String(opts.consumer) } : {}),
        ...(opts.orgWide ? { org: true } : {}),
        mode: mode as ModelActivationMode,
        actor: String(opts.actor || 'scott'),
        reason: String(opts.reason),
        ...(opts.expectedRevision !== undefined ? { expectedRevision: Number(opts.expectedRevision) } : {}),
      },
      opts as never,
    );
  });

modelCommand
  .command('revert')
  .description('Revert a previous routing operation to its recorded prior state')
  .requiredOption('--operation <id>', 'Operation id from a receipt or `model events`')
  .requiredOption('--reason <reason>', 'Why this is being reverted')
  .option('--actor <actor>', 'Who is making the change', 'scott')
  .option('--expected-revision <n>', 'CAS guard')
  .option('--no-restart', 'Do not restart agents')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    await runOperation(
      {
        kind: 'revert',
        operation_id: String(opts.operation),
        actor: String(opts.actor || 'scott'),
        reason: String(opts.reason),
        ...(opts.expectedRevision !== undefined ? { expectedRevision: Number(opts.expectedRevision) } : {}),
      },
      opts as never,
    );
  });

// ---------------------------------------------------------------------------
// attempt (provenance from any consumer)
// ---------------------------------------------------------------------------

modelCommand
  .command('attempt')
  .description('Record a provenance attempt from any consumer (JARVIS scripts included)')
  .requiredOption('--consumer <name>', 'Agent name or call-site id')
  .option('--role <role>', 'Role id (defaults to the consumer assignment)')
  .option('--entry <entry>', 'Entry id actually used, as an authorized override')
  .option('--session <ref>', 'Session / thread id this attempt belongs to')
  .option('--observed <model>', 'Runtime-observed model id (never a config value)')
  .option('--observed-source <src>', 'Where the observation came from', 'consumer-reported')
  .option('--fallback-from <entry>', 'Entry this attempt fell back from')
  .option('--fallback-reason <reason>', 'Fallback class: spawn | auth | quota | outage')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .action((opts: Record<string, string | boolean | undefined>) => {
    const json = !!opts.json;
    const ctx = ctxFrom(opts as { org?: string; root?: string });
    try {
      const consumer = String(opts.consumer);
      const res = resolveModel(
        {
          agent: consumer,
          callsite: consumer,
          ...(opts.role ? { role: String(opts.role) } : {}),
          ...(opts.entry
            ? { override: { entry_id: String(opts.entry), actor: 'consumer', reason: 'reported by consumer' } }
            : {}),
        },
        ctx,
      );
      const written = recordAttempt(
        {
          consumer,
          resolution: res,
          sessionRef: opts.session ? String(opts.session) : null,
          ...(opts.fallbackFrom
            ? { fallback: { from: String(opts.fallbackFrom), reason: String(opts.fallbackReason || 'unspecified') } }
            : {}),
        },
        ctx,
      );
      if (opts.observed) {
        updateAttemptObserved(
          written.path,
          { model_id: String(opts.observed), source: String(opts.observedSource || 'consumer-reported') },
          ctx,
        );
      }
      out(json, { ok: true, attempt_id: written.id, path: written.path, resolution: res }, () => {
        console.log(`attempt ${written.id} recorded at ${written.path}`);
        printResolution(res);
      });
    } catch (err) {
      die(json, (err as Error).message);
    }
  });

// ---------------------------------------------------------------------------
// events / health / migrate
// ---------------------------------------------------------------------------

modelCommand
  .command('events')
  .description('Show the routing event journal (newest first)')
  .option('--limit <n>', 'How many events', '20')
  .option('--attempts', 'Show attempt records instead of operation events')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .action((opts: Record<string, string | boolean | undefined>) => {
    const ctx = ctxFrom(opts as { org?: string; root?: string });
    const limit = Number(opts.limit || 20);
    if (opts.attempts) {
      const attempts = listAttempts(ctx, limit);
      out(!!opts.json, attempts, () => {
        for (const a of attempts) {
          console.log(
            `${a.at}  ${a.consumer.padEnd(22)} ${a.activation.padEnd(9)} ` +
            `${(a.model_id ?? 'none').padEnd(28)} observed=${a.observed.model_id ?? '-'} (${a.observed.confidence})`,
          );
        }
      });
      return;
    }
    const events = listEvents(ctx, limit);
    out(!!opts.json, events, () => {
      for (const e of events) {
        console.log(`${e.at}  ${e.operation_id}  ${e.kind.padEnd(10)} ${e.state.padEnd(16)} rev ${e.registry_revision}  ${e.reason}`);
      }
    });
  });

modelCommand
  .command('health')
  .description('Run bounded, non-billing health probes on registry entries')
  .option('--entry <entry>', 'Probe just this entry')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const json = !!opts.json;
    const ctx = ctxFrom(opts as { org?: string; root?: string });
    try {
      const reg = loadRegistry(ctx);
      const ids = opts.entry ? [String(opts.entry)] : Object.keys(reg.entries);
      const results: HealthResult[] = [];
      for (const id of ids) results.push(await probeEntryHealth(reg, id, ctx));
      out(json, results, () => {
        for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.entry_id.padEnd(24)} [${r.kind}] ${r.detail}`);
      });
    } catch (err) {
      die(json, (err as Error).message);
    }
  });

modelCommand
  .command('migrate')
  .description('Import legacy agent config models as registry pins (never edits config.json)')
  .option('--bootstrap', 'Run the bootstrap import')
  .option('--dry-run', 'Report what would happen without writing')
  .option('--actor <actor>', 'Who is running the migration', 'jarvis')
  .option('--json', 'Output JSON')
  .option('--org <org>', 'Org name', DEFAULT_ORG)
  .option('--root <path>', 'Registry root')
  .option('--instance <id>', 'Instance ID', 'default')
  .action((opts: Record<string, string | boolean | undefined>) => {
    const json = !!opts.json;
    if (!opts.bootstrap) die(json, 'migrate currently supports only --bootstrap');
    try {
      const result = migrateBootstrap({
        ...ctxFrom(opts as { org?: string; root?: string; instance?: string }),
        actor: String(opts.actor || 'jarvis'),
        dryRun: !!opts.dryRun,
      });
      out(json, result, () => {
        console.log(`scanned ${result.scanned.length} agent config(s); registry revision ${result.registry_revision}`);
        for (const p of result.legacy_pins) console.log(`  legacy-migration pin  ${p.agent.padEnd(22)} → ${p.entry_id} (expires ${p.expires_at})`);
        for (const p of result.proposed_invalid) {
          console.log(`  PROPOSED-INVALID      ${p.agent.padEnd(22)} model=${p.model} runtime=${p.runtime}`);
          console.log(`                        ${p.reason}`);
          if (p.task_id) console.log(`                        human task ${p.task_id}`);
        }
        for (const u of result.unmatched) console.log(`  unmatched             ${u.agent.padEnd(22)} model=${u.model} (${u.reason})`);
      });
    } catch (err) {
      die(json, (err as Error).message);
    }
  });
