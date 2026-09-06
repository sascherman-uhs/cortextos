/**
 * GET/PATCH /api/agents/[name]/config
 *
 * OS-02b-ui (model-routing contract §5, §7):
 *   - GET returns a REDACTED DTO (see @/lib/agent-config-dto) plus the routing
 *     Resolution for the agent. Cron prompt bodies, env and tokens never leave.
 *   - PATCH accepts `{ op: "model_routing", action, … }` and forwards it to the
 *     routing service. `model` and `runtime` are no longer writable here; a
 *     legacy raw `model` PATCH returns 409 { error: "use model_routing operation" }.
 */

import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot, getAllAgents, getAgentDir } from '@/lib/config';
import { spawnSync } from 'child_process';
import { buildAgentConfigDTO, WRITABLE_CONFIG_FIELDS } from '@/lib/agent-config-dto';
import {
  applyRoutingOperation,
  isReceipt,
  isRoutingError,
  resolveAgentRouting,
  type RoutingOperation,
} from '@/lib/model-routing';

export const dynamic = 'force-dynamic';

function resolveAgentConfigPath(frameworkRoot: string, name: string): string | null {
  // First check via getAllAgents (uses enabled-agents.json + filesystem scan)
  const allAgents = getAllAgents();
  const entry = allAgents.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (entry) {
    const agentDir = getAgentDir(entry.name, entry.org || undefined);
    const p = join(agentDir, 'config.json');
    if (existsSync(p)) return p;
  }

  // Fallback: search all orgs directories
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  for (const org of readdirSync(orgsDir)) {
    const p = join(orgsDir, org, 'agents', name, 'config.json');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secret scrubbing — belt and braces on top of the DTO allowlist.
//
// Collects every string in the raw config that is sensitive by position
// (cron prompts, env values) or by key name (token/secret/key/password), then
// removes those literals from ANY response body, including error strings that
// bubbled up from a CLI. Nothing sensitive can survive serialization.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|credential|authorization)/i;

function collectSensitiveStrings(value: unknown, keyHint = '', out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (value.length >= 8 && (SENSITIVE_KEY.test(keyHint) || keyHint === 'prompt' || keyHint === 'env')) out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectSensitiveStrings(v, keyHint, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Under `env:` every value is a credential candidate regardless of key.
      collectSensitiveStrings(v, k === 'env' ? 'env' : (keyHint === 'env' ? 'env' : k), out);
    }
  }
  return out;
}

function scrubbedJson(payload: unknown, sensitive: Set<string>, init?: ResponseInit): Response {
  let text = JSON.stringify(payload);
  for (const s of sensitive) {
    if (!s) continue;
    text = text.split(JSON.stringify(s).slice(1, -1)).join('[redacted]');
  }
  return new Response(text, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function readRawConfig(configPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — redacted DTO + routing resolution
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const configPath = resolveAgentConfigPath(frameworkRoot, name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }
  const raw = readRawConfig(configPath);
  if (!raw) {
    return Response.json({ error: 'Failed to read config' }, { status: 500 });
  }
  const sensitive = collectSensitiveStrings(raw);
  const config = buildAgentConfigDTO(raw);

  let routing: unknown = null;
  let routingError: string | null = null;
  try {
    const r = await resolveAgentRouting(name);
    if (isRoutingError(r)) routingError = r.error;
    else routing = r;
  } catch (e) {
    routingError = e instanceof Error ? e.message : 'routing service unavailable';
  }

  return scrubbedJson({ name, config, routing, routing_error: routingError, redacted: true }, sensitive);
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

function parseRoutingOperation(body: Record<string, unknown>, agentName: string): RoutingOperation | { error: string } {
  const action = body.action;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { error: 'reason is required for a model_routing operation' };
  const actor = typeof body.actor === 'string' ? body.actor : 'dashboard';

  if (action === 'switch') {
    const role = typeof body.role === 'string' ? body.role : '';
    const tier = typeof body.tier === 'string' ? body.tier : '';
    if (!role || !tier) return { error: 'switch requires role and tier' };
    return {
      action: 'switch',
      role,
      tier,
      reason,
      actor,
      clear_pins: body.clear_pins === true,
      ...(typeof body.expected_revision === 'number' ? { expected_revision: body.expected_revision } : {}),
    };
  }
  if (action === 'pin') {
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : agentName;
    const entry_id = typeof body.entry_id === 'string' ? body.entry_id : '';
    if (!agent || !entry_id) return { error: 'pin requires agent and entry_id' };
    return {
      action: 'pin',
      agent,
      entry_id,
      reason,
      actor,
      ...(typeof body.expires_at === 'string' ? { expires_at: body.expires_at } : {}),
    };
  }
  if (action === 'unpin') {
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : agentName;
    if (!agent) return { error: 'unpin requires agent' };
    return { action: 'unpin', agent, reason, actor };
  }
  if (action === 'revert') {
    const operation_id = typeof body.operation_id === 'string' ? body.operation_id : '';
    if (!operation_id) return { error: 'revert requires operation_id' };
    return { action: 'revert', operation_id, reason, actor };
  }
  return { error: 'action must be one of switch, pin, unpin, revert' };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const configPath = resolveAgentConfigPath(frameworkRoot, name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const rawForScrub = readRawConfig(configPath) ?? {};
  const sensitive = collectSensitiveStrings(rawForScrub);

  // --- Routing operations (contract §7) ------------------------------------
  if (body.op === 'model_routing') {
    const op = parseRoutingOperation(body, name);
    if ('error' in op) return scrubbedJson(op, sensitive, { status: 400 });
    try {
      const receipt = await applyRoutingOperation(op);
      // A receipt is returned as a receipt even when it reports a blocked or
      // failed operation — the Fleet page renders its state and reason. Only a
      // bare routing error (service unreachable) is a 503.
      if (!isReceipt(receipt)) {
        if (isRoutingError(receipt)) return scrubbedJson(receipt, sensitive, { status: 503 });
        return scrubbedJson({ error: 'routing service returned no receipt' }, sensitive, { status: 503 });
      }
      const succeeded = receipt.state !== 'blocked' && receipt.state !== 'failed';
      return scrubbedJson({ success: succeeded, name, receipt }, sensitive);
    } catch (e) {
      return scrubbedJson(
        { error: e instanceof Error ? e.message : 'routing operation failed' },
        sensitive,
        { status: 500 },
      );
    }
  }
  if (body.op !== undefined) {
    return Response.json({ error: 'unsupported op' }, { status: 400 });
  }

  // --- Legacy raw model write is refused (contract §5) ----------------------
  if (body.model !== undefined || body.runtime !== undefined) {
    return Response.json({ error: 'use model_routing operation' }, { status: 409 });
  }

  const allowed = WRITABLE_CONFIG_FIELDS as readonly string[];
  const timeRegex = /^\d{2}:\d{2}$/;
  if (body.day_mode_start && !timeRegex.test(body.day_mode_start as string)) {
    return Response.json({ error: 'day_mode_start must be HH:MM' }, { status: 400 });
  }
  if (body.day_mode_end && !timeRegex.test(body.day_mode_end as string)) {
    return Response.json({ error: 'day_mode_end must be HH:MM' }, { status: 400 });
  }

  // Validate approval_rules shape
  if (body.approval_rules !== undefined) {
    const ar = body.approval_rules as Record<string, unknown>;
    const isStringArray = (v: unknown) => Array.isArray(v) && (v as unknown[]).every(el => typeof el === 'string' && el.length > 0);
    if (
      typeof ar !== 'object' || ar === null || Array.isArray(ar) ||
      !isStringArray(ar.always_ask) || !isStringArray(ar.never_ask)
    ) {
      return Response.json(
        { error: 'approval_rules must have shape { always_ask: string[], never_ask: string[] } with non-empty string elements' },
        { status: 400 },
      );
    }
  }

  // Validate context threshold fields: must be numbers between 50 and 95
  for (const pctField of ['ctx_warning_threshold', 'ctx_handoff_threshold'] as const) {
    if (body[pctField] !== undefined) {
      const val = body[pctField];
      if (typeof val !== 'number' || val < 50 || val > 95) {
        return Response.json({ error: `${pctField} must be a number between 50 and 95` }, { status: 400 });
      }
    }
  }
  if (body.ctx_warning_threshold !== undefined && body.ctx_handoff_threshold !== undefined) {
    if ((body.ctx_warning_threshold as number) >= (body.ctx_handoff_threshold as number)) {
      return Response.json({ error: 'ctx_warning_threshold must be less than ctx_handoff_threshold' }, { status: 400 });
    }
  }

  // Validate numeric fields: must be non-negative integers
  for (const numField of ['max_session_seconds', 'max_crashes_per_day', 'startup_delay'] as const) {
    if (body[numField] !== undefined) {
      const val = body[numField];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        return Response.json(
          { error: `${numField} must be a non-negative integer` },
          { status: 400 },
        );
      }
    }
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    for (const key of allowed) {
      if (body[key] !== undefined) config[key] = body[key];
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // Notify agent immediately (non-fatal if offline)
    try {
      const sendMsg = join(frameworkRoot, 'bus', 'send-message.sh');
      if (existsSync(sendMsg)) {
        spawnSync(
          'bash',
          [sendMsg, name, 'normal', 'Settings updated via dashboard. Re-read config.json and apply new operational settings.'],
          {
            env: { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_AGENT_NAME: name },
            timeout: 5000,
            stdio: 'pipe',
          },
        );
      }
    } catch (notifyErr) {
      console.error(`[api/agents/${name}/config] PATCH: send-message.sh failed (non-fatal):`, notifyErr);
    }

    // Respond with the redacted DTO, never the raw config.
    return scrubbedJson({ success: true, name, config: buildAgentConfigDTO(config), redacted: true }, sensitive);
  } catch {
    return Response.json({ error: 'Failed to write config' }, { status: 500 });
  }
}
