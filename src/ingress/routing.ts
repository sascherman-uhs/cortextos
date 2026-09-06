/**
 * OS-07 — person -> role routing.
 *
 * Plan §6 identity table:
 *   Scott's JARVIS bot  -> ingress/dispatcher, replies through that bot
 *   Vera's bot          -> Raquel -> Vera
 *   Vivienne's bot      -> Angelic -> Vivienne
 *   Tron's bot          -> existing authorized users -> dispatcher reliability mode
 *   any other bot       -> its existing route, preserved; never silently retired
 *
 * Two invariants this module exists to hold:
 *   1. A reply goes back through the bot the message arrived on. The route is
 *      recorded on the inbound record, so a reply cannot be composed against a
 *      different identity even if the worker forgets which bot it is.
 *   2. The allowed-user gate is the SAME gate the per-agent poller applied.
 *      Multiplexing must not widen who can drive a bot.
 */

import type { BotIdentity } from './identity.js';
import { readJson, type IngressPaths } from './state.js';

export type IngressRole = 'ingress' | 'dispatcher' | 'vera' | 'vivienne' | 'worker';

export interface RouteDecision {
  /** Bot the update arrived on — and the ONLY bot its reply may leave through. */
  bot: string;
  role: IngressRole;
  /** Which agent should do the work, when the route names one. */
  targetAgent?: string;
  /** Human label for the sender, when the routing table knows them. */
  person?: string;
  /** Extra mode hint carried to the dispatcher (e.g. Tron's reliability mode). */
  mode?: string;
  authorized: boolean;
  /** Why an update was refused. Safe to log. */
  reason?: string;
}

export interface RoutingRule {
  /** Bot identity id this rule applies to. */
  bot: string;
  role: IngressRole;
  targetAgent?: string;
  mode?: string;
  /** Optional per-person labels keyed by Telegram user id (as a string). */
  people?: Record<string, string>;
}

export interface RoutingTable {
  version: number;
  rules: RoutingRule[];
  /** Role applied to an enabled bot with no explicit rule. */
  default_role: IngressRole;
}

/**
 * Built-in routes for the identities the plan names. Everything else falls
 * through to `default_role: 'worker'` — its listener keeps working, it is
 * visible in `ingress status`, and nothing about it is retired implicitly.
 */
export const BUILTIN_RULES: RoutingRule[] = [
  { bot: 'jarvis-telegram', role: 'ingress', targetAgent: 'jarvis-telegram', people: {} },
  { bot: 'jarvis-orchestrator', role: 'dispatcher', targetAgent: 'jarvis-orchestrator' },
  { bot: 'jarvis-heartbeat', role: 'dispatcher', targetAgent: 'jarvis-heartbeat' },
  { bot: 'tron', role: 'dispatcher', targetAgent: 'tron', mode: 'reliability' },
  { bot: 'vera', role: 'vera', targetAgent: 'vera' },
  { bot: 'vivienne', role: 'vivienne', targetAgent: 'vivienne' },
];

export function defaultRoutingTable(): RoutingTable {
  return { version: 1, rules: [...BUILTIN_RULES], default_role: 'worker' };
}

/**
 * Load the routing table. An operator-supplied `ingress/routing.json` replaces
 * a built-in rule for the same bot; built-ins fill any gap so a fresh install
 * routes Raquel and Angelic correctly with no configuration at all.
 */
export function loadRoutingTable(paths: IngressPaths): RoutingTable {
  const onDisk = readJson<Partial<RoutingTable>>(paths.routingPath);
  const table = defaultRoutingTable();
  if (!onDisk || !Array.isArray(onDisk.rules)) return table;
  const byBot = new Map(table.rules.map((r) => [r.bot, r]));
  for (const rule of onDisk.rules) {
    if (!rule || typeof rule.bot !== 'string') continue;
    byBot.set(rule.bot, { ...byBot.get(rule.bot), ...rule } as RoutingRule);
  }
  return {
    version: onDisk.version ?? table.version,
    rules: [...byBot.values()],
    default_role: onDisk.default_role ?? table.default_role,
  };
}

/**
 * Decide where one inbound update goes.
 *
 * The allowed-user check runs FIRST and is identical to the gate in
 * `agent-manager` — a bot with no allowed-user list refuses everyone, and a
 * sender outside the list is refused with the id logged so an operator can
 * whitelist it. Multiplexing changes who polls, never who is trusted.
 */
export function routeUpdate(
  table: RoutingTable,
  identity: BotIdentity,
  fromUserId: number | undefined,
): RouteDecision {
  const rule = table.rules.find((r) => r.bot === identity.id);
  const role = rule?.role ?? table.default_role;
  const base: RouteDecision = {
    bot: identity.id,
    role,
    ...(rule?.targetAgent ? { targetAgent: rule.targetAgent } : identity.agentName ? { targetAgent: identity.agentName } : {}),
    ...(rule?.mode ? { mode: rule.mode } : {}),
    authorized: false,
  };

  if (identity.allowedUserIds.length === 0) {
    return { ...base, reason: `bot ${identity.id} has no ALLOWED_USER list — failing closed` };
  }
  if (typeof fromUserId !== 'number' || !identity.allowedUserIds.includes(fromUserId)) {
    return { ...base, reason: `sender ${fromUserId ?? 'unknown'} is not in ALLOWED_USER for ${identity.id}` };
  }

  const person = rule?.people?.[String(fromUserId)];
  return { ...base, authorized: true, ...(person ? { person } : {}) };
}
