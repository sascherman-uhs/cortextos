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
  /**
   * Observed (actually ran) model — contract §4. Absent when unknown.
   * `binding` / `attempt_id` are emitted by newer CLI builds only: every
   * consumer must degrade gracefully when they are missing.
   */
  observed?: {
    model_id: string | null;
    source: string;
    binding?: string | null;
    confidence?: ObservedConfidence;
    at?: string;
    attempt_id?: string | null;
  } | null;
  /** The model id the registry expects this agent to run. Newer CLI builds only. */
  expected_model_id?: string | null;
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
  /** Newer CLI builds only — absent means "unknown", never "false". */
  restart_required?: boolean;
  /** Pins this operation removed (e.g. a switch with --clear-pins). */
  cleared_pins?: string[];
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

/**
 * One dispatch attempt as shown in the per-agent "Attempts" expander.
 * Every field is nullable: older CLI builds emit a subset.
 */
export interface RoutingAttempt {
  attempt_id: string | null;
  at: string | null;
  agent: string | null;
  requested: string | null;
  resolved: string | null;
  observed: string | null;
  confidence: ObservedConfidence | 'unknown';
  binding: string | null;
}

export interface ModelRoutingAdapter {
  kind: 'service' | 'cli' | 'file' | 'unavailable';
  resolveAgent(agent: string): Promise<Resolution | RoutingError>;
  summary(): Promise<RegistrySummary | RoutingError>;
  events(limit?: number): Promise<{ events: unknown[]; attempts: unknown[] } | RoutingError>;
  apply(op: RoutingOperation): Promise<Receipt | RoutingError>;
  /**
   * Optional — `cortextos model attempts --agent X --json` exists only on newer
   * CLI builds. An adapter without it is not an error; the UI says so.
   */
  attempts?(agent: string, limit?: number): Promise<{ attempts: unknown[] } | RoutingError>;
}

export function isRoutingError(v: unknown): v is RoutingError {
  return !!v && typeof v === 'object' && typeof (v as RoutingError).error === 'string';
}

/**
 * Structural check — a Receipt is identified by its own fields, never by the
 * absence of an `error`. A BLOCKED operation is a receipt that carries an error
 * message, and it has to reach the operator as a receipt (with its reason and
 * its disabled Revert), not as a bare 503 string.
 */
export function isReceipt(v: unknown): v is Receipt {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Receipt).operation_id === 'string' &&
    typeof (v as Receipt).state === 'string'
  );
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
  listAttempts?: (agent: string, limit?: number) => Promise<unknown[]> | unknown[];
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
    async attempts(agent, limit) {
      const m = await load();
      if (!m?.listAttempts) {
        const fb = fallbackAdapter();
        return fb.attempts ? fb.attempts(agent, limit) : { attempts: [] };
      }
      try { return { attempts: await m.listAttempts(agent, limit) }; } catch (e) { return { error: errText(e) }; }
    },
  };
}

// ---------------------------------------------------------------------------
// (b) CLI adapter — `cortextos model … --json`
// ---------------------------------------------------------------------------

/**
 * A JSON document on stdout is the answer, whatever the exit code says.
 *
 * `cortextos model resolve --json` exits non-zero when the resolution FAILS
 * VALIDATION (e.g. `pin_not_dispatchable`) — the document it printed carries
 * the errors the operator has to act on. Discarding it and surfacing
 * "cortextos model exited 2" hides the remediation item behind a shell detail.
 * Only a run that produced no parseable JSON is treated as a transport failure.
 */
export function interpretCliOutput(
  stdout: string | undefined,
  stderr: string | undefined,
  status: number | null,
): unknown | RoutingError {
  const parsed = safeJson((stdout ?? '').trim());

  if (parsed !== undefined) {
    // A bare `{ error }` envelope is still an error; a Resolution or Receipt
    // that merely carries an `error` field is not.
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as RoutingError).error === 'string' &&
      !('validation' in (parsed as object)) &&
      !('operation_id' in (parsed as object)) &&
      !('registry_revision' in (parsed as object))
    ) {
      return parsed as RoutingError;
    }
    return parsed;
  }

  const err = (stderr ?? '').trim();
  if (status !== 0) {
    return { error: err || `routing CLI failed (exit ${status}) and returned no JSON` };
  }
  return { error: err || 'routing CLI returned non-JSON output' };
}

function runCli(bin: string, args: string[]): unknown | RoutingError {
  const res = spawnSync(bin, args, { encoding: 'utf-8', timeout: 120000, env: process.env });
  if (res.error) return { error: errText(res.error) };
  return interpretCliOutput(res.stdout, res.stderr, res.status);
}

/** Loose mapping of whatever the CLI/event files call these fields. */
export function normalizeAttempts(raw: unknown): RoutingAttempt[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { attempts?: unknown[] })?.attempts)
      ? (raw as { attempts: unknown[] }).attempts
      : [];
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => {
      const observed = (a.observed ?? {}) as Record<string, unknown>;
      const confidence = str(a.confidence) ?? str(observed.confidence);
      return {
        attempt_id: str(a.attempt_id) ?? str(a.id),
        at: str(a.at) ?? str(a.created_at) ?? str(a.timestamp),
        agent: str(a.agent) ?? str(a.consumer),
        requested: str(a.requested) ?? str(a.requested_model_id) ?? str(a.requested_entry_id),
        resolved: str(a.resolved) ?? str(a.resolved_model_id) ?? str(a.expected_model_id) ?? str(a.model_id),
        observed: str(a.observed_model_id) ?? str(observed.model_id),
        confidence:
          confidence === 'verified' || confidence === 'mismatch' || confidence === 'unconfirmed'
            ? confidence
            : 'unknown',
        binding: str(a.binding) ?? str(observed.binding) ?? str(a.session_id),
      };
    });
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
      if (isReceipt(out)) return out;
      if (isRoutingError(out)) return out;
      return { error: 'routing CLI returned no recognisable receipt' };
    },
    async attempts(agent, limit) {
      const out = runCli(resolved, ['model', 'attempts', '--agent', agent, '--limit', String(limit ?? 5), '--json']);
      if (isRoutingError(out)) return out;
      return { attempts: normalizeAttempts(out) };
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
    async attempts(agent, limit) {
      const p = findRegistryFile();
      if (!p) return { attempts: [] };
      const all = normalizeAttempts(readEventDir(join(p, '..', 'model-events', 'attempts'), 200));
      return { attempts: all.filter((a) => !a.agent || a.agent === agent).slice(0, limit ?? 5) };
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
    async attempts() { return ROUTING_UNAVAILABLE; },
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

/**
 * Last N dispatch attempts for one agent. An adapter that cannot report them
 * answers `{ attempts: [], supported: false }` — an empty list is not evidence
 * that nothing ran.
 */
export async function getAgentAttempts(
  agent: string,
  limit = 5,
): Promise<{ attempts: RoutingAttempt[]; supported: boolean } | RoutingError> {
  const adapter = getModelRoutingAdapter();
  if (!adapter.attempts) return { attempts: [], supported: false };
  const out = await adapter.attempts(agent, limit);
  if (isRoutingError(out)) {
    // `model attempts` only exists on newer CLI builds. An older binary answers
    // with a commander "unknown command" error — that is "not supported here",
    // not an outage, and it must not be shown as a failure.
    if (/unknown command|unrecognized|unknown option|display help for command/i.test(out.error)) {
      return { attempts: [], supported: false };
    }
    return out;
  }
  return { attempts: normalizeAttempts(out.attempts).slice(0, limit), supported: true };
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
