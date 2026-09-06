/**
 * OS-07 — bot identity enumeration.
 *
 * The plan requires ingress to enumerate EVERY enabled bot identity, by the
 * NAME of the env key that holds its token, and to preserve the existing
 * allowed-user controls for each one. Unknown identities are still listed —
 * "unknown route prevents retirement of its current listener" — so an operator
 * can see a bot nobody claims rather than silently losing it.
 *
 * A token value never appears in a `BotIdentity`. `loadToken()` reads it on
 * demand and callers hand it straight to `TelegramAPI`; nothing here logs,
 * serialises or returns it.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEnvFile } from '../utils/env.js';
import { stripBom } from '../utils/strip-bom.js';

/** Token shape Telegram issues: `<numeric bot id>:<secret>`. */
export const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;

export interface BotIdentity {
  /** Stable id used for state files, locks and flags. Agent name, or `activity`. */
  id: string;
  /** Where the credentials live: an agent `.env`, or the org activity channel. */
  source: 'agent' | 'activity';
  /** The agent that currently owns this bot's listener, if any. */
  agentName?: string;
  /** Absolute path of the file holding the token. Never its contents. */
  envFile: string;
  /** NAME of the env key holding the token. Never the value. */
  tokenEnvKey: string;
  chatId?: string;
  /** Numeric Telegram user ids allowed to drive this bot. */
  allowedUserIds: number[];
  /** config.json `enabled` for the owning agent (always true for activity). */
  enabled: boolean;
  /** False when the token is missing/malformed or the allowed-user gate is unset. */
  usable: boolean;
  /** Why `usable` is false — safe to log, never contains a secret. */
  reason?: string;
}

function parseAllowedUsers(raw: string | undefined): { ids: number[]; ok: boolean } {
  if (!raw) return { ids: [], ok: false };
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) return { ids: [], ok: false };
  return { ids: parts.map((p) => parseInt(p, 10)), ok: true };
}

function agentEnabled(agentDir: string): boolean {
  try {
    const cfg = JSON.parse(stripBom(readFileSync(join(agentDir, 'config.json'), 'utf-8')));
    return cfg.enabled !== false;
  } catch {
    return false;
  }
}

/**
 * Enumerate every configured bot identity for an org.
 *
 * @param frameworkRoot repo root holding `orgs/<org>/agents/*`
 */
export function enumerateBotIdentities(frameworkRoot: string, org: string): BotIdentity[] {
  const out: BotIdentity[] = [];
  const orgDir = join(frameworkRoot, 'orgs', org);
  const agentsDir = join(orgDir, 'agents');

  if (existsSync(agentsDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const agentDir = join(agentsDir, name);
      const envFile = join(agentDir, '.env');
      if (!existsSync(envFile)) continue;
      const env = parseEnvFile(envFile);
      // An agent with no BOT_TOKEN key at all has no bot. An agent whose
      // BOT_TOKEN is present but EMPTY is listed as an unusable identity
      // rather than dropped: seven UHS agents are in exactly that state, and
      // "enumerate every configured identity" means an operator should see
      // them in `ingress list`, not have them vanish.
      if (!('BOT_TOKEN' in env)) continue;
      const token = env.BOT_TOKEN;
      const allowed = parseAllowedUsers(env.ALLOWED_USER);
      const tokenOk = Boolean(token) && BOT_TOKEN_PATTERN.test(token);
      let reason: string | undefined;
      if (!token) reason = 'BOT_TOKEN is present but empty — this agent has no bot of its own';
      else if (!tokenOk) reason = 'BOT_TOKEN is malformed';
      else if (!allowed.ok) reason = 'ALLOWED_USER is missing or malformed — fail closed, same rule as the per-agent poller';
      out.push({
        id: name,
        source: 'agent',
        agentName: name,
        envFile,
        tokenEnvKey: 'BOT_TOKEN',
        chatId: env.CHAT_ID,
        allowedUserIds: allowed.ids,
        enabled: agentEnabled(agentDir),
        usable: tokenOk && allowed.ok && Boolean(env.CHAT_ID),
        ...(reason ? { reason } : !env.CHAT_ID ? { reason: 'CHAT_ID is missing' } : {}),
      });
    }
  }

  const activityEnv = join(orgDir, 'activity-channel.env');
  if (existsSync(activityEnv)) {
    const env = parseEnvFile(activityEnv);
    const token = env.ACTIVITY_BOT_TOKEN;
    if (token) {
      const allowed = parseAllowedUsers(env.ACTIVITY_ALLOWED_USER_ID ?? env.ACTIVITY_CHAT_ID);
      const tokenOk = BOT_TOKEN_PATTERN.test(token);
      out.push({
        id: 'activity',
        source: 'activity',
        envFile: activityEnv,
        tokenEnvKey: 'ACTIVITY_BOT_TOKEN',
        chatId: env.ACTIVITY_CHAT_ID,
        allowedUserIds: allowed.ids,
        enabled: true,
        usable: tokenOk && Boolean(env.ACTIVITY_CHAT_ID),
        ...(tokenOk ? {} : { reason: 'ACTIVITY_BOT_TOKEN is missing or malformed' }),
      });
    }
  }

  return out;
}

/**
 * Read one identity's token from its env file at call time.
 *
 * Deliberately not cached on the identity object: a token that never sits in a
 * long-lived struct cannot be logged by an unrelated `JSON.stringify`.
 */
export function loadToken(identity: BotIdentity): string | undefined {
  const env = parseEnvFile(identity.envFile);
  const token = env[identity.tokenEnvKey];
  if (!token || !BOT_TOKEN_PATTERN.test(token)) return undefined;
  return token;
}

/** Redacted, loggable description of an identity. */
export function describeIdentity(identity: BotIdentity): string {
  const chat = identity.chatId ? `chat ****${identity.chatId.slice(-4)}` : 'no chat';
  return `${identity.id} (${identity.source}, token key ${identity.tokenEnvKey}, ${chat}, ` +
    `${identity.allowedUserIds.length} allowed user(s), ${identity.usable ? 'usable' : `unusable: ${identity.reason}`})`;
}
