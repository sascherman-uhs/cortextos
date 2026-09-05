/**
 * dashboard/src/lib/model-routing.ts — OS-02b-ui
 *
 * Thin server-side adapter onto the model-routing core service defined in
 * `.planning/agentic-os/model-routing-contract.md` (§1–§4).
 *
 * Backend resolution order (contract §7 / package brief):
 *   (a) `service` — import the core service module (`src/bus/model-registry`)
 *       when it exists in the framework repo (compiled `dist` preferred).
 *   (b) `cli`     — shell out to `cortextos model … --json`.
 *   (c) `file`    — read `$CTX_ROOT/orgs/uhs/model-registry.json` READ-ONLY and
 *       compute a display-only resolution. Mutations return
 *       `{ error: 'routing service unavailable' }`.
 *
 * The adapter is swappable: `__setModelRoutingAdapter()` in tests.
 * Nothing here ever returns raw agent config, env values, or secrets.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

// ---------------------------------------------------------------------------
// Contract types (§1–§3)
// ---------------------------------------------------------------------------

export type ActivationMode = 'shadow' | 'enforced';
export type EffectiveSource = 'override' | 'pin' | 'role' | 'org_default';
export type ObservedConfidence = 'verified' | 'unconfirmed' | 'mismatch';

export type ReceiptState =
  | 'requested'
  | 'validated'
  | 'desired_written'
  | 'draining'
  | 'applied'
  | 'blocked'
  | 'failed'
  | 'reverted';

export interface RegistryEntry {
  entry_id: string;
  model_id: string;
  provider: string;
  runtime_adapter: string;
  capability_tags: string[];
  context_window: number;
  billing_mode: string;
  cost_class: number;
  /** env key NAME or login-file id only — never a credential value. */
  auth_source: string | null;
  status: string;
}

export interface RegistryPin {
  entry_id: string;
  kind: 'explicit' | 'legacy-migration' | 'proposed-invalid';
  reason?: string;
  actor?: string;
  created_at?: string;
  expires_at?: string | null;
  fallback?: string[];
}

export interface RegistryRole {
  tier: string;
  required_capabilities: string[];
  min_context: number;
  data_scope: string;
}

export interface RegistryAgentBinding {
  role: string;
  pin: RegistryPin | null;
}

export interface Resolution {
  registry_revision: number;
  activation: ActivationMode;
  requested: { source: EffectiveSource; tier?: string; entry_id?: string };
  candidates: string[];
  selected: null | {
    entry_id: string;
    model_id: string;
    provider: string;
    runtime_adapter: string;
    billing_mode: string;
    cost_class: number;
  };
  validation: { ok: boolean; errors: { code: string; message: string }[]; warnings: string[] };
  legacy_effective?: { model_id?: string; runtime?: string };
  /** Observed (actually ran) model — contract §4. Absent when unknown. */
  observed?: { model_id: string | null; source: string; confidence: ObservedConfidence; at?: string } | null;
  /** OS-08 placeholder until evals exist. */
  eval_state?: string;
}

export interface Receipt {
  operation_id: string;
  kind: string;
  actor: string;
  reason: string;
  from?: unknown;
  to?: unknown;
  affected_consumers: string[];
  registry_revision_before?: number;
  registry_revision_after?: number;
  state: ReceiptState;
  restart_results?: { agent: string; ok: boolean; message?: string }[];
  created_at: string;
  applied_at?: string | null;
  error?: string | null;
}

export interface RegistrySummary {
  schema_version: number;
  revision: number;
  updated_at?: string;
  updated_by?: string;
  activation: { org_default: ActivationMode; consumers: Record<string, ActivationMode> };
  org_default_tier: string;
  entries: RegistryEntry[];
  tiers: Record<string, string[]>;
  roles: Record<string, RegistryRole>;
  agents: Record<string, RegistryAgentBinding>;
}

export interface RoutingError {
  error: string;
}

export type RoutingOperation =
  | { action: 'switch'; role: string; tier: string; reason: string; expected_revision?: number; clear_pins?: boolean; actor?: string }
  | { action: 'pin'; agent: string; entry_id: string; reason: string; expires_at?: string; actor?: string }
  | { action: 'unpin'; agent: string; reason: string; actor?: string }
  | { action: 'revert'; operation_id: string; reason: string; actor?: string };

export interface ModelRoutingAdapter {
  kind: 'service' | 'cli' | 'file' | 'unavailable';
  resolveAgent(agent: string): Promise<Resolution | RoutingError>;
  summary(): Promise<RegistrySummary | RoutingError>;
  events(limit?: number): Promise<{ events: unknown[]; attempts: unknown[] } | RoutingError>;
  apply(op: RoutingOperation): Promise<Receipt | RoutingError>;
}

export function isRoutingError(v: unknown): v is RoutingError {
  return !!v && typeof v === 'object' && typeof (v as RoutingError).error === 'string';
}

export const ROUTING_UNAVAILABLE: RoutingError = { error: 'routing service unavailable' };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ORG = process.env.CTX_ORG ?? 'uhs';

/** Candidate locations for the registry file (CTX_ROOT first, contract §1). */
export function registryPathCandidates(): string[] {
  const out: string[] = [];
  try { out.push(join(getCTXRoot(), 'orgs', ORG, 'model-registry.json')); } catch { /* ignore */ }
  try { out.push(join(getFrameworkRoot(), 'orgs', ORG, 'model-registry.json')); } catch { /* ignore */ }
  return out;
}

function findRegistryFile(): string | null {
  for (const p of registryPathCandidates()) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findCortextosBin(): string | null {
  if (process.env.CORTEXTOS_BIN && existsSync(process.env.CORTEXTOS_BIN)) return process.env.CORTEXTOS_BIN;
  const which = spawnSync('which', ['cortextos'], { encoding: 'utf-8', timeout: 5000 });
  const p = (which.stdout ?? '').trim();
  return which.status === 0 && p ? p : null;
}

function findCoreServiceModule(): string | null {
  const root = getFrameworkRoot();
  const candidates = [
    join(root, 'dist', 'bus', 'model-registry.js'),
    join(root, 'src', 'bus', 'model-registry.ts'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// (a) service adapter — dynamic import of the core module
// ---------------------------------------------------------------------------

/** Hidden from the bundler on purpose: the path is runtime-resolved. */
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<Record<string, unknown>>;

interface CoreService {
  resolve?: (input: unknown) => Promise<Resolution> | Resolution;
  loadRegistry?: () => Promise<unknown> | unknown;
  applyOperation?: (op: unknown) => Promise<Receipt> | Receipt;
  listEvents?: (limit?: number) => Promise<unknown[]> | unknown[];
}

/** CLI first, then read-only file — used whenever the core module cannot load. */
function fallbackAdapter(): ModelRoutingAdapter {
  return cliAdapter() ?? fileAdapter();
}

function serviceAdapter(modulePath: string): ModelRoutingAdapter {
  let mod: CoreService | null = null;
  const load = async (): Promise<CoreService | null> => {
    if (mod) return mod;
    try {
      const url = modulePath.startsWith('file:') ? modulePath : `file://${modulePath}`;
      const m = (await dynamicImport(url)) as unknown as CoreService & { default?: CoreService };
      mod = (m.resolve ? m : m.default) ?? null;
      return mod;
    } catch {
      return null;
    }
  };
  return {
    kind: 'service',
    async resolveAgent(agent) {
      const m = await load();
      if (!m?.resolve) return fallbackAdapter().resolveAgent(agent);
      try { return await m.resolve({ agent }); } catch (e) { return { error: errText(e) }; }
    },
    async summary() {
      const m = await load();
      if (!m?.loadRegistry) return fallbackAdapter().summary();
      try { return normalizeSummary(await m.loadRegistry()); } catch (e) { return { error: errText(e) }; }
    },
    async events(limit) {
      const m = await load();
      if (!m?.listEvents) return fallbackAdapter().events(limit);
      try { return { events: await m.listEvents(limit), attempts: [] }; } catch (e) { return { error: errText(e) }; }
    },
    async apply(op) {
      const m = await load();
      if (!m?.applyOperation) return fallbackAdapter().apply(op);
      try { return await m.applyOperation(op); } catch (e) { return { error: errText(e) }; }
    },
  };
}

// ---------------------------------------------------------------------------
// (b) CLI adapter — `cortextos model … --json`
// ---------------------------------------------------------------------------

function runCli(bin: string, args: string[]): unknown | RoutingError {
  const res = spawnSync(bin, args, { encoding: 'utf-8', timeout: 120000, env: process.env });
  if (res.error) return { error: errText(res.error) };
  const stdout = (res.stdout ?? '').trim();
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').trim();
    // Prefer a structured error body when the CLI emits one.
    const parsed = safeJson(stdout);
    if (parsed && typeof parsed === 'object' && 'error' in (parsed as object)) return parsed as RoutingError;
    return { error: stderr || `cortextos model exited ${res.status}` };
  }
  const parsed = safeJson(stdout);
  if (parsed === undefined) return { error: 'routing CLI returned non-JSON output' };
  return parsed;
}

function opToCliArgs(op: RoutingOperation): string[] {
  switch (op.action) {
    case 'switch': {
      const a = ['model', 'switch', '--role', op.role, '--tier', op.tier, '--reason', op.reason];
      if (op.expected_revision !== undefined) a.push('--expected-revision', String(op.expected_revision));
      if (op.clear_pins) a.push('--clear-pins');
      return [...a, '--json'];
    }
    case 'pin': {
      const a = ['model', 'pin', '--agent', op.agent, '--entry', op.entry_id, '--reason', op.reason];
      if (op.expires_at) a.push('--expires-at', op.expires_at);
      return [...a, '--json'];
    }
    case 'unpin':
      return ['model', 'unpin', '--agent', op.agent, '--reason', op.reason, '--json'];
    case 'revert':
      return ['model', 'revert', '--operation', op.operation_id, '--reason', op.reason, '--json'];
  }
}

function cliAdapter(bin?: string): ModelRoutingAdapter | null {
  const resolved = bin ?? findCortextosBin();
  if (!resolved) return null;
  return {
    kind: 'cli',
    async resolveAgent(agent) {
      const out = runCli(resolved, ['model', 'resolve', '--agent', agent, '--json']);
      return isRoutingError(out) ? out : (out as Resolution);
    },
    async summary() {
      const out = runCli(resolved, ['model', 'list', '--json']);
      return isRoutingError(out) ? out : normalizeSummary(out);
    },
    async events(limit) {
      const out = runCli(resolved, ['model', 'events', '--limit', String(limit ?? 25), '--json']);
      if (isRoutingError(out)) return out;
      if (Array.isArray(out)) return { events: out, attempts: [] };
      const o = out as { events?: unknown[]; attempts?: unknown[] };
      return { events: o.events ?? [], attempts: o.attempts ?? [] };
    },
    async apply(op) {
      const out = runCli(resolved, opToCliArgs(op));
      return isRoutingError(out) ? out : (out as Receipt);
    },
  };
}

// ---------------------------------------------------------------------------
// (c) file adapter — read-only display; mutations refused
// ---------------------------------------------------------------------------

interface RawRegistry {
  schema_version?: number;
  revision?: number;
  updated_at?: string;
  updated_by?: string;
  activation?: { org_default?: ActivationMode; consumers?: Record<string, ActivationMode> };
  org_default_tier?: string;
  entries?: Record<string, Omit<RegistryEntry, 'entry_id'>>;
  tiers?: Record<string, string[]>;
  roles?: Record<string, RegistryRole>;
  agents?: Record<string, RegistryAgentBinding>;
}

export function normalizeSummary(raw: unknown): RegistrySummary {
  const r = (raw ?? {}) as RawRegistry;
  const entries: RegistryEntry[] = Object.entries(r.entries ?? {}).map(([entry_id, e]) => ({
    entry_id,
    model_id: e?.model_id ?? '',
    provider: e?.provider ?? '',
    runtime_adapter: e?.runtime_adapter ?? '',
    capability_tags: e?.capability_tags ?? [],
    context_window: e?.context_window ?? 0,
    billing_mode: e?.billing_mode ?? 'unknown',
    cost_class: e?.cost_class ?? 0,
    auth_source: e?.auth_source ?? null,
    status: e?.status ?? 'unknown',
  }));
  return {
    schema_version: r.schema_version ?? 1,
    revision: r.revision ?? 0,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    activation: {
      org_default: r.activation?.org_default ?? 'shadow',
      consumers: r.activation?.consumers ?? {},
    },
    org_default_tier: r.org_default_tier ?? 'standard',
    entries,
    tiers: r.tiers ?? {},
    roles: r.roles ?? {},
    agents: r.agents ?? {},
  };
}

function pinIsLive(pin: RegistryPin | null | undefined, now = Date.now()): boolean {
  if (!pin) return false;
  if (pin.kind === 'proposed-invalid') return false;
  if (pin.expires_at && Date.parse(pin.expires_at) <= now) return false;
  return true;
}

/** Display-only precedence walk (contract §2) used when only the file is readable. */
export function resolveFromRegistry(summary: RegistrySummary, agent: string): Resolution {
  const binding = summary.agents[agent];
  const activation = summary.activation.consumers[agent] ?? summary.activation.org_default;
  const byId = new Map(summary.entries.map((e) => [e.entry_id, e]));
  const warnings = ['routing service unavailable — display-only resolution read from the registry file'];

  const pick = (entryId: string | undefined) => {
    const e = entryId ? byId.get(entryId) : undefined;
    return e
      ? {
          entry_id: e.entry_id,
          model_id: e.model_id,
          provider: e.provider,
          runtime_adapter: e.runtime_adapter,
          billing_mode: e.billing_mode,
          cost_class: e.cost_class,
        }
      : null;
  };

  if (!binding) {
    const tier = summary.org_default_tier;
    const candidates = summary.tiers[tier] ?? [];
    return {
      registry_revision: summary.revision,
      activation,
      requested: { source: 'org_default', tier },
      candidates,
      selected: pick(candidates[0]),
      validation: { ok: false, errors: [{ code: 'agent_unbound', message: `No role binding for agent "${agent}"` }], warnings },
      eval_state: 'unevaluated',
    };
  }

  if (pinIsLive(binding.pin)) {
    const entryId = binding.pin!.entry_id;
    return {
      registry_revision: summary.revision,
      activation,
      requested: { source: 'pin', entry_id: entryId },
      candidates: [entryId, ...(binding.pin!.fallback ?? [])],
      selected: pick(entryId),
      validation: { ok: !!pick(entryId), errors: pick(entryId) ? [] : [{ code: 'unknown_entry', message: `Pinned entry "${entryId}" is not in the registry` }], warnings },
      eval_state: 'unevaluated',
    };
  }

  const role = summary.roles[binding.role];
  const tier = role?.tier ?? summary.org_default_tier;
  const candidates = summary.tiers[tier] ?? [];
  const errors: { code: string; message: string }[] = [];
  if (!role) errors.push({ code: 'unknown_role', message: `Role "${binding.role}" is not defined in the registry` });
  if (candidates.length === 0) errors.push({ code: 'empty_tier', message: `Tier "${tier}" has no candidate entries` });
  if (binding.pin && binding.pin.kind === 'proposed-invalid') {
    errors.push({ code: 'proposed_invalid_pin', message: `Legacy pin "${binding.pin.entry_id}" is invalid and is not dispatchable` });
  }
  return {
    registry_revision: summary.revision,
    activation,
    requested: { source: role ? 'role' : 'org_default', tier },
    candidates,
    selected: pick(candidates[0]),
    validation: { ok: errors.length === 0, errors, warnings },
    eval_state: 'unevaluated',
  };
}

function readEventDir(dir: string, limit: number): unknown[] {
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);
    return files
      .map((f) => safeJson(readFileSync(join(dir, f), 'utf-8')))
      .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  } catch {
    return [];
  }
}

function fileAdapter(): ModelRoutingAdapter {
  return {
    kind: 'file',
    async summary() {
      const p = findRegistryFile();
      if (!p) return { error: 'routing service unavailable: no model-registry.json found' };
      const parsed = safeJson(readFileSafe(p));
      if (parsed === undefined) return { error: 'routing service unavailable: model-registry.json is not valid JSON' };
      return normalizeSummary(parsed);
    },
    async resolveAgent(agent) {
      const s = await this.summary();
      if (isRoutingError(s)) return s;
      return resolveFromRegistry(s, agent);
    },
    async events(limit) {
      const p = findRegistryFile();
      if (!p) return { events: [], attempts: [] };
      const base = join(p, '..', 'model-events');
      return {
        events: readEventDir(base, limit ?? 25),
        attempts: readEventDir(join(base, 'attempts'), limit ?? 25),
      };
    },
    async apply() {
      return ROUTING_UNAVAILABLE;
    },
  };
}

function unavailableAdapter(): ModelRoutingAdapter {
  return {
    kind: 'unavailable',
    async resolveAgent() { return ROUTING_UNAVAILABLE; },
    async summary() { return ROUTING_UNAVAILABLE; },
    async events() { return ROUTING_UNAVAILABLE; },
    async apply() { return ROUTING_UNAVAILABLE; },
  };
}

// ---------------------------------------------------------------------------
// Adapter selection (swappable for tests)
// ---------------------------------------------------------------------------

let override: ModelRoutingAdapter | null = null;
let cached: ModelRoutingAdapter | null = null;

/** Test seam — inject a fake adapter. */
export function __setModelRoutingAdapter(a: ModelRoutingAdapter | null): void {
  override = a;
  cached = null;
}

export function getModelRoutingAdapter(): ModelRoutingAdapter {
  if (override) return override;
  if (cached) return cached;
  const svc = findCoreServiceModule();
  if (svc) cached = serviceAdapter(svc);
  else cached = cliAdapter() ?? (findRegistryFile() ? fileAdapter() : unavailableAdapter());
  return cached;
}

// ---------------------------------------------------------------------------
// Public helpers used by routes
// ---------------------------------------------------------------------------

export async function resolveAgentRouting(agent: string): Promise<Resolution | RoutingError> {
  return getModelRoutingAdapter().resolveAgent(agent);
}

export async function getRoutingSummary(): Promise<RegistrySummary | RoutingError> {
  return getModelRoutingAdapter().summary();
}

export async function getRoutingEvents(limit = 25): Promise<{ events: unknown[]; attempts: unknown[] } | RoutingError> {
  return getModelRoutingAdapter().events(limit);
}

export async function applyRoutingOperation(op: RoutingOperation): Promise<Receipt | RoutingError> {
  return getModelRoutingAdapter().apply(op);
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function safeJson(text: string | undefined): unknown | undefined {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function readFileSafe(p: string): string | undefined {
  try { return readFileSync(p, 'utf-8'); } catch { return undefined; }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
