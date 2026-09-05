/**
 * Model routing registry — the single authority for "which model does this
 * consumer run on".
 *
 * Implements `.planning/agentic-os/model-routing-contract.md` (OS-02b-core).
 *
 * Design notes that differ from a naive reading of the contract:
 *
 *  - **Where the file lives.** The contract says `$CTX_ROOT/orgs/uhs/…` and
 *    parenthetically "CTX_ROOT = ~/cortextos". Those are two different roots in
 *    this install: `CTX_ROOT` (`~/.cortextos/<instance>`) holds *runtime* state,
 *    while the repo root (`CTX_FRAMEWORK_ROOT` / `CTX_PROJECT_ROOT`, i.e.
 *    `~/cortextos`) holds the per-agent `config.json` files under `orgs/<org>/agents/`. The registry is the
 *    peer of those config files, so it resolves against the FRAMEWORK root first
 *    and only falls back to `CTX_ROOT`. `CTX_MODEL_REGISTRY_ROOT` overrides both.
 *
 *  - **Event filenames** replace `:` with `-` so the journal is portable to
 *    Windows (the daemon runs there too). Ordering is preserved because the
 *    timestamp is still ISO-8601 lexicographic.
 *
 * Nothing in this module mutates an agent's `config.json`. The literal `model`
 * field there is legacy evidence, imported as a pin by `migrateBootstrap()`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type {
  AgentConfig,
  ModelActivationMode,
  ModelAttemptRecord,
  ModelEventRecord,
  ModelFallbackClass,
  ModelObservationBinding,
  ModelObservedConfidence,
  ModelOperationKind,
  ModelOperationReceipt,
  ModelOperationState,
  ModelPin,
  ModelRegistry,
  ModelResolution,
  ModelResolveInput,
  ModelRestartResult,
  ModelRoleAssignment,
  ModelValidationError,
} from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Context + paths
// ---------------------------------------------------------------------------

export interface RegistryContext {
  /** Root that contains `orgs/<org>/`. Overrides all env detection (tests). */
  root?: string;
  /** Org name. Defaults to `CTX_ORG` then `uhs`. */
  org?: string;
  /** Repo root used to read agent `config.json` for legacy reporting. */
  frameworkRoot?: string;
  /** Runtime root used for native task creation (`orgs/<org>/tasks`). */
  ctxRoot?: string;
  instanceId?: string;
  /** Injectable clock — tests freeze it. */
  now?: () => Date;
}

export interface RegistryPaths {
  root: string;
  org: string;
  orgDir: string;
  registryPath: string;
  eventsDir: string;
  attemptsDir: string;
  lockPath: string;
}

export const DEFAULT_ORG = 'uhs';
/** A switch lock older than this is stale and may be broken. */
export const LOCK_EXPIRY_MS = 10 * 60 * 1000;
/** Contract §3: a drain that exceeds this makes the operation `blocked`. */
export const DRAIN_DEADLINE_MS = 5 * 60 * 1000;
/** Contract §5: legacy pins imported by bootstrap expire after 30 days. */
export const LEGACY_PIN_DAYS = 30;

export function resolveRegistryPaths(ctx: RegistryContext = {}): RegistryPaths {
  const org = ctx.org || process.env.CTX_ORG || DEFAULT_ORG;
  const root =
    ctx.root ||
    process.env.CTX_MODEL_REGISTRY_ROOT ||
    ctx.frameworkRoot ||
    process.env.CTX_FRAMEWORK_ROOT ||
    process.env.CTX_PROJECT_ROOT ||
    process.env.CTX_ROOT ||
    join(homedir(), 'cortextos');

  const orgDir = join(root, 'orgs', org);
  const eventsDir = join(orgDir, 'model-events');
  return {
    root,
    org,
    orgDir,
    registryPath: join(orgDir, 'model-registry.json'),
    eventsDir,
    attemptsDir: join(eventsDir, 'attempts'),
    lockPath: join(orgDir, '.model-switch.lock'),
  };
}

function nowOf(ctx: RegistryContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

function isoOf(ctx: RegistryContext): string {
  return nowOf(ctx).toISOString();
}

/** Filesystem-safe, lexicographically ordered timestamp prefix. */
function stamp(iso: string): string {
  return iso.replace(/:/g, '-');
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RegistryNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Model registry not found at ${path}. Run: cortextos model migrate --bootstrap`);
    this.name = 'RegistryNotFoundError';
  }
}

export class RegistryConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Registry revision conflict: expected ${expected}, on-disk is ${actual}. Re-read and retry.`);
    this.name = 'RegistryConflictError';
  }
}

export class SwitchLockedError extends Error {
  constructor(public readonly holder: { operation_id?: string; agents?: string[]; expires_at?: string }) {
    super(
      `A model switch is already in progress (operation ${holder.operation_id ?? 'unknown'}, ` +
      `agents ${(holder.agents ?? []).join(', ') || 'none'}, expires ${holder.expires_at ?? 'unknown'}).`,
    );
    this.name = 'SwitchLockedError';
  }
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function loadRegistry(ctx: RegistryContext = {}): ModelRegistry {
  const paths = resolveRegistryPaths(ctx);
  if (!existsSync(paths.registryPath)) throw new RegistryNotFoundError(paths.registryPath);
  const raw = readFileSync(paths.registryPath, 'utf-8');
  const reg = JSON.parse(raw) as ModelRegistry;
  return normalizeRegistry(reg);
}

/** Fill in optional containers so callers never have to null-guard them. */
function normalizeRegistry(reg: ModelRegistry): ModelRegistry {
  reg.activation = reg.activation || { org_default: 'shadow', consumers: {} };
  reg.activation.consumers = reg.activation.consumers || {};
  reg.adapters = reg.adapters || {};
  reg.entries = reg.entries || {};
  reg.tiers = reg.tiers || {};
  reg.roles = reg.roles || {};
  reg.agents = reg.agents || {};
  reg.callsites = reg.callsites || {};
  return reg;
}

/**
 * Compare-and-swap write. `expectedRevision` must equal the revision currently
 * on disk (or the registry must be absent when `expectedRevision` is 0).
 * Returns the registry as written, with `revision` incremented.
 */
export function saveRegistryCAS(
  next: ModelRegistry,
  expectedRevision: number,
  ctx: RegistryContext = {},
): ModelRegistry {
  const paths = resolveRegistryPaths(ctx);
  let onDisk = 0;
  if (existsSync(paths.registryPath)) {
    try {
      onDisk = (JSON.parse(readFileSync(paths.registryPath, 'utf-8')) as ModelRegistry).revision ?? 0;
    } catch {
      onDisk = -1;
    }
  }
  if (onDisk !== expectedRevision) throw new RegistryConflictError(expectedRevision, onDisk);

  const written: ModelRegistry = {
    ...normalizeRegistry(next),
    revision: expectedRevision + 1,
    updated_at: isoOf(ctx),
    updated_by: next.updated_by || 'jarvis',
  };
  ensureDir(paths.orgDir);
  atomicWriteSync(paths.registryPath, JSON.stringify(written, null, 2));
  return written;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const VALIDATION_CODES = {
  ENTRY_NOT_FOUND: 'entry_not_found',
  ENTRY_NOT_ACTIVE: 'entry_not_active',
  ADAPTER_UNKNOWN: 'adapter_unknown',
  ADAPTER_RUNTIME_MISMATCH: 'adapter_runtime_mismatch',
  MISSING_CAPABILITIES: 'missing_capabilities',
  CONTEXT_TOO_SMALL: 'context_window_too_small',
  AUTH_MISSING: 'auth_missing',
  TIER_EMPTY: 'tier_empty',
  TIER_UNKNOWN: 'tier_unknown',
  ROLE_UNKNOWN: 'role_unknown',
  NO_ROUTE: 'no_route',
  PIN_NOT_DISPATCHABLE: 'pin_not_dispatchable',
} as const;

/**
 * Presence-only auth check. NEVER reads or logs a credential value — it only
 * asserts that the named env var is set or the named CLI login file exists.
 */
export function authSourcePresent(authSource: string | null | undefined): boolean {
  if (!authSource) return true; // local / no auth required
  if (authSource.startsWith('env:')) {
    const name = authSource.slice(4);
    return !!process.env[name] && process.env[name] !== '';
  }
  if (authSource === 'claude-cli-login') {
    return existsSync(join(homedir(), '.claude', '.credentials.json')) || existsSync(join(homedir(), '.claude.json'));
  }
  if (authSource === 'codex-cli-login') {
    return existsSync(join(homedir(), '.codex', 'auth.json'));
  }
  if (authSource === 'kimi-cli-login') {
    // The Kimi CLI on this machine authenticates from `~/.kimi/credentials`,
    // not from `KIMI_API_KEY` as the contract's adapter descriptor assumes.
    // The descriptor keeps the contract spelling; the ENTRY records what is
    // actually true here, so `tron` stays routable.
    return existsSync(join(homedir(), '.kimi', 'credentials'));
  }
  // Unknown scheme: do not fail a human's explicit choice on a scheme we do
  // not model — report it as present and let the health probe say more.
  return true;
}

/** Can `adapterId` host an agent whose config declares `runtime`? */
export function adapterHostsRuntime(reg: ModelRegistry, adapterId: string, runtime: string): boolean {
  const adapter = reg.adapters[adapterId];
  if (!adapter) return false;
  // An explicit list is authoritative, INCLUDING when it is empty — `[]` is how
  // an API/SDK adapter says "I can serve JARVIS call sites but can never back a
  // PTY agent". Absent means "the adapter id is itself the runtime name".
  if (adapter.hosts_runtimes) return adapter.hosts_runtimes.includes(runtime);
  return adapterId === runtime;
}

export function validateCandidate(
  reg: ModelRegistry,
  entryId: string,
  opts: { role?: ModelRoleAssignment | null; agentRuntime?: string | null } = {},
): ModelValidationError[] {
  const errors: ModelValidationError[] = [];
  const entry = reg.entries[entryId];
  if (!entry) {
    return [{ code: VALIDATION_CODES.ENTRY_NOT_FOUND, message: `No registry entry "${entryId}"` }];
  }
  if (entry.status !== 'active') {
    errors.push({
      code: VALIDATION_CODES.ENTRY_NOT_ACTIVE,
      message: `Entry "${entryId}" has status "${entry.status}"`,
    });
  }
  if (!reg.adapters[entry.runtime_adapter]) {
    errors.push({
      code: VALIDATION_CODES.ADAPTER_UNKNOWN,
      message: `Entry "${entryId}" names unregistered adapter "${entry.runtime_adapter}"`,
    });
  } else if (opts.agentRuntime && !adapterHostsRuntime(reg, entry.runtime_adapter, opts.agentRuntime)) {
    errors.push({
      code: VALIDATION_CODES.ADAPTER_RUNTIME_MISMATCH,
      message:
        `Entry "${entryId}" runs on adapter "${entry.runtime_adapter}" but the agent config declares ` +
        `runtime "${opts.agentRuntime}"`,
    });
  }
  if (opts.role) {
    const missing = opts.role.required_capabilities.filter((c) => !entry.capability_tags.includes(c));
    if (missing.length) {
      errors.push({
        code: VALIDATION_CODES.MISSING_CAPABILITIES,
        message: `Entry "${entryId}" lacks required capabilities: ${missing.join(', ')}`,
      });
    }
    if (entry.context_window < opts.role.min_context) {
      errors.push({
        code: VALIDATION_CODES.CONTEXT_TOO_SMALL,
        message: `Entry "${entryId}" context ${entry.context_window} < role minimum ${opts.role.min_context}`,
      });
    }
  }
  if (!authSourcePresent(entry.auth_source)) {
    errors.push({
      code: VALIDATION_CODES.AUTH_MISSING,
      message: `Auth source "${entry.auth_source}" for "${entryId}" is not present on this machine`,
    });
  }
  return errors;
}

/** Contract §3: automatic fallback is only ever allowed on these classes. */
export function isFallbackEligible(kind: string): kind is ModelFallbackClass {
  return kind === 'spawn' || kind === 'auth' || kind === 'quota' || kind === 'outage';
}

export function isPinExpired(pin: ModelPin, at: Date): boolean {
  if (!pin.expires_at) return false;
  const t = Date.parse(pin.expires_at);
  if (Number.isNaN(t)) return false;
  return t <= at.getTime();
}

/** A pin that can actually dispatch work (proposed-invalid never can). */
export function isPinDispatchable(pin: ModelPin | null | undefined, at: Date): boolean {
  if (!pin) return false;
  if (pin.kind === 'proposed-invalid') return false;
  return !isPinExpired(pin, at);
}

// ---------------------------------------------------------------------------
// Legacy config reading (shadow reporting only — never written)
// ---------------------------------------------------------------------------

/**
 * Directory holding `<agent>/config.json`, always under the SAME root the
 * registry itself resolved from (`resolveRegistryPaths`).
 *
 * Before this was true, `readAgentConfig` kept its own root list that omitted
 * `CTX_ROOT` and the `~/cortextos` fallback: from a plain shell the registry
 * was found (via the fallback) while zero agent configs were, so
 * `cortextos model migrate --bootstrap` imported nothing and still bumped a
 * revision. One root, or the registry and the agents it describes can disagree.
 */
export function agentsDir(ctx: RegistryContext = {}): string {
  return join(resolveRegistryPaths(ctx).orgDir, 'agents');
}

export function readAgentConfig(agent: string, ctx: RegistryContext = {}): AgentConfig | null {
  const p = join(agentsDir(ctx), agent, 'config.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as AgentConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

export function activationFor(reg: ModelRegistry, consumer: string | undefined): ModelActivationMode {
  if (consumer && reg.activation.consumers[consumer]) return reg.activation.consumers[consumer];
  return reg.activation.org_default;
}

/**
 * Precedence (contract §2): task override → valid non-expired pin → role
 * assignment → org default tier.
 */
export function resolve(
  input: ModelResolveInput,
  ctx: RegistryContext = {},
  preloaded?: ModelRegistry,
): ModelResolution {
  const reg = preloaded ? normalizeRegistry(preloaded) : loadRegistry(ctx);
  const at = nowOf(ctx);
  const consumer = input.agent || input.callsite;
  const activation = activationFor(reg, consumer);

  const agentAssignment = input.agent ? reg.agents[input.agent] : undefined;
  const callsiteAssignment = input.callsite ? reg.callsites[input.callsite] : undefined;
  const roleId = input.role || agentAssignment?.role || callsiteAssignment?.role;
  const role = roleId ? reg.roles[roleId] : undefined;

  const errors: ModelValidationError[] = [];
  const warnings: string[] = [];

  if (roleId && !role) {
    errors.push({ code: VALIDATION_CODES.ROLE_UNKNOWN, message: `No role "${roleId}" in registry` });
  }

  // --- requested route ------------------------------------------------------
  let requested: ModelResolution['requested'];
  const pin = agentAssignment?.pin ?? callsiteAssignment?.pin ?? null;

  if (input.override && (input.override.entry_id || input.override.tier)) {
    requested = { source: 'override', ...(input.override.entry_id ? { entry_id: input.override.entry_id } : {}), ...(input.override.tier ? { tier: input.override.tier } : {}) };
  } else if (isPinDispatchable(pin, at)) {
    requested = { source: 'pin', entry_id: pin!.entry_id };
  } else {
    if (pin && pin.kind === 'proposed-invalid') {
      errors.push({
        code: VALIDATION_CODES.PIN_NOT_DISPATCHABLE,
        message: `Agent has a proposed-invalid pin on "${pin.entry_id}" awaiting human remediation; inheriting role route instead`,
      });
    } else if (pin && isPinExpired(pin, at)) {
      warnings.push(`Pin on "${pin.entry_id}" expired at ${pin.expires_at}; inheriting role route`);
    }
    if (role) {
      requested = { source: 'role', tier: role.tier };
    } else {
      requested = { source: 'org_default', tier: reg.org_default_tier };
    }
  }

  // --- candidate list -------------------------------------------------------
  let rawCandidates: string[] = [];
  if (requested.entry_id) {
    rawCandidates = [requested.entry_id];
    if (isPinDispatchable(pin, at) && pin!.fallback?.length && requested.source === 'pin') {
      rawCandidates = [requested.entry_id, ...pin!.fallback];
    }
  } else if (requested.tier) {
    if (!(requested.tier in reg.tiers)) {
      errors.push({ code: VALIDATION_CODES.TIER_UNKNOWN, message: `No tier "${requested.tier}" in registry` });
    } else {
      rawCandidates = [...reg.tiers[requested.tier]];
      if (rawCandidates.length === 0) {
        errors.push({ code: VALIDATION_CODES.TIER_EMPTY, message: `Tier "${requested.tier}" has no entries` });
      }
    }
  }

  const agentRuntime = input.agent ? readAgentConfig(input.agent, ctx)?.runtime ?? 'claude-code' : null;

  const candidates: string[] = [];
  let firstErrors: ModelValidationError[] | null = null;
  for (const candidate of rawCandidates) {
    const candErrors = validateCandidate(reg, candidate, { role, agentRuntime });
    if (candErrors.length === 0) {
      candidates.push(candidate);
    } else if (firstErrors === null) {
      firstErrors = candErrors;
    }
  }
  if (candidates.length === 0) {
    if (firstErrors) errors.push(...firstErrors);
    if (rawCandidates.length > 0 && !firstErrors) {
      errors.push({ code: VALIDATION_CODES.NO_ROUTE, message: 'No eligible candidate after validation' });
    }
    if (rawCandidates.length === 0 && errors.length === 0) {
      errors.push({ code: VALIDATION_CODES.NO_ROUTE, message: 'No route requested and no org default tier resolved' });
    }
  }

  const selectedId = candidates[0] ?? null;
  const selectedEntry = selectedId ? reg.entries[selectedId] : null;

  const resolution: ModelResolution = {
    registry_revision: reg.revision,
    activation,
    requested,
    candidates,
    selected: selectedEntry
      ? {
          entry_id: selectedId!,
          model_id: selectedEntry.model_id,
          provider: selectedEntry.provider,
          runtime_adapter: selectedEntry.runtime_adapter,
          billing_mode: selectedEntry.billing_mode,
          cost_class: selectedEntry.cost_class,
        }
      : null,
    validation: { ok: !!selectedEntry && errors.length === 0, errors, warnings },
    ...(roleId ? { role: roleId } : {}),
  };

  if (input.agent) {
    const cfg = readAgentConfig(input.agent, ctx);
    if (cfg) {
      resolution.legacy_effective = {
        ...(cfg.model ? { model_id: cfg.model } : {}),
        ...(cfg.runtime ? { runtime: cfg.runtime } : {}),
      };
    }
  }

  return resolution;
}

/**
 * What a spawn should actually pass to the adapter.
 *
 * Shadow: `null` — the legacy config model keeps running, and the daemon only
 * logs. Enforced: the resolved model id, or `null` with `refuse: true` when
 * validation failed (the spawn must be refused, not silently downgraded).
 */
export function spawnDecision(res: ModelResolution): {
  mode: ModelActivationMode;
  modelOverride: string | null;
  refuse: boolean;
  reason: string;
} {
  if (res.activation === 'shadow') {
    return {
      mode: 'shadow',
      modelOverride: null,
      refuse: false,
      reason: res.validation.ok ? 'shadow: reporting only' : 'shadow: validation failed, legacy dispatch retained',
    };
  }
  if (!res.selected) {
    return {
      mode: 'enforced',
      modelOverride: null,
      refuse: true,
      reason: `enforced: no valid route (${res.validation.errors.map((e) => e.code).join(', ') || 'no_route'})`,
    };
  }
  return { mode: 'enforced', modelOverride: res.selected.model_id, refuse: false, reason: 'enforced: explicit selection' };
}

// ---------------------------------------------------------------------------
// Event + attempt journal (additive; never rewritten)
// ---------------------------------------------------------------------------

export function appendEvent(event: ModelEventRecord, ctx: RegistryContext = {}): string {
  const paths = resolveRegistryPaths(ctx);
  ensureDir(paths.eventsDir);
  const file = join(paths.eventsDir, `${stamp(event.at)}-${event.operation_id}-${event.state}.json`);
  atomicWriteSync(file, JSON.stringify(event, null, 2));
  return file;
}

export function listEvents(ctx: RegistryContext = {}, limit = 50): ModelEventRecord[] {
  const paths = resolveRegistryPaths(ctx);
  if (!existsSync(paths.eventsDir)) return [];
  const files = readdirSync(paths.eventsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: ModelEventRecord[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(paths.eventsDir, f), 'utf-8')) as ModelEventRecord);
    } catch { /* skip unreadable event */ }
  }
  return out;
}

export interface RecordAttemptInput {
  consumer: string;
  resolution: ModelResolution;
  sessionRef?: string | null;
  observed?: { model_id: string | null; source: string | null; confidence?: ModelObservedConfidence } | null;
  fallback?: { from: string; reason: string };
}

/**
 * The model that a spawn from this resolution ACTUALLY dispatches — the only
 * honest baseline for an observation.
 *
 * In `shadow` the registry's `selected` entry is a proposal: the legacy config
 * model is what runs, so comparing an observation against `selected` reported
 * a "mismatch" for every correctly-behaving shadow agent. In `enforced` the
 * resolved model is passed to the adapter, so it is the baseline.
 */
export function expectedModelId(res: ModelResolution): string | null {
  if (res.activation === 'enforced') return res.selected?.model_id ?? null;
  return res.legacy_effective?.model_id ?? res.selected?.model_id ?? null;
}

export function recordAttempt(input: RecordAttemptInput, ctx: RegistryContext = {}): { id: string; path: string } {
  const paths = resolveRegistryPaths(ctx);
  ensureDir(paths.attemptsDir);
  const at = isoOf(ctx);
  const id = newId('att');
  const res = input.resolution;
  const record: ModelAttemptRecord = {
    attempt_id: id,
    consumer: input.consumer,
    role: res.role ?? null,
    requested: res.requested,
    selected_entry: res.selected?.entry_id ?? null,
    model_id: res.selected?.model_id ?? null,
    runtime_adapter: res.selected?.runtime_adapter ?? null,
    billing_mode: res.selected?.billing_mode ?? null,
    registry_revision: res.registry_revision,
    session_ref: input.sessionRef ?? null,
    activation: res.activation,
    expected_model_id: expectedModelId(res),
    at,
    observed: {
      model_id: input.observed?.model_id ?? null,
      source: input.observed?.source ?? null,
      confidence: input.observed?.confidence ?? 'unconfirmed',
      at: input.observed?.model_id ? at : null,
    },
    ...(input.fallback ? { fallback: input.fallback } : {}),
  };
  const file = join(paths.attemptsDir, `${stamp(at)}-${id}.json`);
  atomicWriteSync(file, JSON.stringify(record, null, 2));
  return { id, path: file };
}

export function readAttempt(attemptPath: string): ModelAttemptRecord | null {
  try {
    return JSON.parse(readFileSync(attemptPath, 'utf-8')) as ModelAttemptRecord;
  } catch {
    return null;
  }
}

/**
 * Attach an observed model id to an existing attempt.
 *
 * Confidence follows contract §4: `verified` when the observation matches what
 * we asked for, `mismatch` when it contradicts it, `unconfirmed` when nothing
 * was observed. A config-derived label is NEVER written here — the caller must
 * pass a value read from runtime evidence.
 */
/** Bindings strong enough to attribute a transcript to THIS spawn. */
export const STRONG_OBSERVATION_BINDINGS: ModelObservationBinding[] = ['session-id', 'thread-id', 'prompt-correlated'];

export function updateAttemptObserved(
  attemptPath: string,
  observed: { model_id: string | null; source: string | null; binding?: ModelObservationBinding },
  ctx: RegistryContext = {},
): ModelAttemptRecord | null {
  const record = readAttempt(attemptPath);
  if (!record) return null;
  // Baseline = what actually ran (see expectedModelId). Older records written
  // before that field existed fall back to the resolved model.
  const baseline = record.expected_model_id ?? record.model_id;
  const bound = observed.binding ? STRONG_OBSERVATION_BINDINGS.includes(observed.binding) : true;
  let confidence: ModelObservedConfidence = 'unconfirmed';
  if (observed.model_id && bound && baseline) {
    confidence = observed.model_id !== baseline ? 'mismatch' : 'verified';
  }
  record.observed = {
    model_id: observed.model_id,
    source: observed.source,
    confidence,
    at: observed.model_id ? isoOf(ctx) : null,
    ...(observed.binding ? { binding: observed.binding } : {}),
  };
  atomicWriteSync(attemptPath, JSON.stringify(record, null, 2));
  return record;
}

export function listAttempts(ctx: RegistryContext = {}, limit = 50): ModelAttemptRecord[] {
  const paths = resolveRegistryPaths(ctx);
  if (!existsSync(paths.attemptsDir)) return [];
  const files = readdirSync(paths.attemptsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const out: ModelAttemptRecord[] = [];
  for (const f of files) {
    const rec = readAttempt(join(paths.attemptsDir, f));
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observed-model capture (contract §4)
// ---------------------------------------------------------------------------

/** `~/.claude/projects/<slug>` — Claude Code slugifies the cwd this way. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.\\ ]/g, '-');
}

/** Read at most `bytes` from the head of a file (transcripts get large). */
function readHead(path: string, bytes: number): string {
  let fd: number | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, read);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        (require('fs') as typeof import('fs')).closeSync(fd);
      } catch { /* ignore */ }
    }
  }
}

/** Whitespace-collapsed lowercase text, for prompt fingerprint comparison. */
function normalizeText(v: string): string {
  return v.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textOfMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join(' ');
  }
  return '';
}

/** First user message text in a transcript (head-limited read). */
export function transcriptFirstUserText(path: string, headBytes = 256 * 1024): string | null {
  const head = readHead(path, headBytes);
  if (!head) return null;
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated tail line at the head boundary
    }
    if (rec.type !== 'user') continue;
    const message = rec.message as Record<string, unknown> | undefined;
    const text = textOfMessageContent(message?.content);
    if (text.trim()) return text;
  }
  return null;
}

/**
 * Does this transcript's first user message correlate with the prompt the PTY
 * launched with? A fingerprint is enough — Claude Code may prepend/append its
 * own scaffolding around the prompt we passed.
 */
export function promptCorrelates(firstUserText: string | null, bootPrompt: string): boolean {
  if (!firstUserText) return false;
  const prompt = normalizeText(bootPrompt);
  if (prompt.length < 24) return false; // too short to identify a session
  const haystack = normalizeText(firstUserText);
  const fingerprint = prompt.slice(0, 160);
  return haystack.includes(fingerprint) || prompt.includes(haystack.slice(0, 160));
}

/** Newest non-synthetic assistant `message.model` in one transcript file. */
function newestModelInTranscript(path: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf-8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = rec.message as Record<string, unknown> | undefined;
    const model = message && typeof message.model === 'string' ? message.model : null;
    // `<synthetic>` is Claude Code's own filler, not a model identity.
    if (model && model !== '<synthetic>') return model;
  }
  return null;
}

/**
 * Newest assistant `message.model` from the Claude Code transcript that belongs
 * to THIS spawn.
 *
 * The cwd slug alone does not identify an agent: five UHS agents share
 * `…/uhsJARVIS` and two share `…/uhsEstimate`, so "newest .jsonl in the slug
 * directory" attributed another agent's (or Scott's own) session — the reason
 * jarvis-accounting reported a model its config never names. Binding is
 * therefore either the session id the PTY launched with, or a transcript that
 * is BOTH newer than the spawn AND opens with the boot prompt. Anything weaker
 * returns null, and the attempt stays `unconfirmed`.
 */
export function observeClaudeModel(opts: {
  cwd: string;
  sessionId?: string | null;
  since?: Date;
  bootPrompt?: string | null;
  projectsRoot?: string;
}): { model_id: string; source: string; binding: ModelObservationBinding } | null {
  const root = opts.projectsRoot || join(homedir(), '.claude', 'projects');
  const dir = join(root, claudeProjectSlug(opts.cwd));
  if (!existsSync(dir)) return null;

  // 1. Session id — exact. Never fall back to "some other file in this dir".
  if (opts.sessionId) {
    const p = join(dir, `${opts.sessionId}.jsonl`);
    if (!existsSync(p)) return null;
    const model = newestModelInTranscript(p);
    return model ? { model_id: model, source: 'claude-transcript', binding: 'session-id' } : null;
  }

  // 2. Correlation — needs both a spawn timestamp and the prompt we launched
  //    with. Without them there is no way to tell whose transcript this is.
  if (!opts.since || !opts.bootPrompt) return null;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const ranked = files
    .map((f) => {
      const p = join(dir, f);
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; mtime: number } => x !== null)
    // Strictly after the spawn: a file last written before this agent started
    // cannot be its session, however recently it was touched.
    .filter((x) => x.mtime >= (opts.since as Date).getTime())
    .sort((a, b) => b.mtime - a.mtime);

  for (const { p } of ranked) {
    if (!promptCorrelates(transcriptFirstUserText(p), opts.bootPrompt)) continue;
    const model = newestModelInTranscript(p);
    if (model) return { model_id: model, source: 'claude-transcript', binding: 'prompt-correlated' };
  }
  return null;
}

/**
 * `turn_context.payload.model` from the Codex rollout for a given thread id.
 * The config-labelled `codex-tokens.jsonl` is NOT an observation source — it
 * echoes config, which is exactly the self-confirming loop the contract bans.
 */
export function observeCodexModel(opts: {
  threadId: string;
  since?: Date;
  sessionsRoot?: string;
}): { model_id: string; source: string; binding: ModelObservationBinding } | null {
  const root = opts.sessionsRoot || join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;

  const rollouts: { p: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
        if (opts.since && st.mtimeMs < opts.since.getTime() - 60_000) continue;
        rollouts.push({ p, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  rollouts.sort((a, b) => b.mtime - a.mtime);

  for (const { p } of rollouts.slice(0, 25)) {
    let content: string;
    try {
      content = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes(opts.threadId)) continue;
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('turn_context')) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const payload = rec.payload as Record<string, unknown> | undefined;
        if (rec.type === 'turn_context' && payload && typeof payload.model === 'string') {
          // The rollout file contains the thread id the PTY launched — that is
          // an exact binding, not a newest-file guess.
          return { model_id: payload.model, source: 'codex-rollout', binding: 'thread-id' };
        }
      } catch { /* skip malformed line */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Health probes (bounded, never billed)
// ---------------------------------------------------------------------------

export interface HealthResult {
  entry_id: string;
  kind: string;
  ok: boolean;
  detail: string;
  at: string;
}

export async function probeEntryHealth(
  reg: ModelRegistry,
  entryId: string,
  ctx: RegistryContext = {},
): Promise<HealthResult> {
  const at = isoOf(ctx);
  const entry = reg.entries[entryId];
  if (!entry) return { entry_id: entryId, kind: 'none', ok: false, detail: 'no such entry', at };
  const probe = entry.health_probe || { kind: 'none' as const };

  if (probe.kind === 'http-tags') {
    const url = probe.url || 'http://127.0.0.1:11434/api/tags';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probe.timeout_ms ?? 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { entry_id: entryId, kind: probe.kind, ok: res.ok, detail: `HTTP ${res.status}`, at };
    } catch (err) {
      return { entry_id: entryId, kind: probe.kind, ok: false, detail: `unreachable: ${(err as Error).message}`, at };
    } finally {
      clearTimeout(timer);
    }
  }

  // cli-print / env-key / none all reduce to a credential-presence assertion.
  // Presence is not proof of authentication and never proof of quality.
  const present = authSourcePresent(entry.auth_source);
  return {
    entry_id: entryId,
    kind: probe.kind,
    ok: present && entry.status === 'active',
    detail: present
      ? `auth source "${entry.auth_source ?? 'none'}" present; status ${entry.status}`
      : `auth source "${entry.auth_source}" absent`,
    at,
  };
}

// ---------------------------------------------------------------------------
// Switch lock
// ---------------------------------------------------------------------------

export interface SwitchLock {
  operation_id: string;
  agents: string[];
  expires_at: string;
}

export function readSwitchLock(ctx: RegistryContext = {}): SwitchLock | null {
  const paths = resolveRegistryPaths(ctx);
  if (!existsSync(paths.lockPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.lockPath, 'utf-8')) as SwitchLock;
  } catch {
    return null;
  }
}

export function acquireSwitchLock(operationId: string, agents: string[], ctx: RegistryContext = {}): SwitchLock {
  const paths = resolveRegistryPaths(ctx);
  ensureDir(paths.orgDir);
  const existing = readSwitchLock(ctx);
  if (existing) {
    const expired = Date.parse(existing.expires_at) <= nowOf(ctx).getTime();
    if (!expired) throw new SwitchLockedError(existing);
    try { unlinkSync(paths.lockPath); } catch { /* raced with the holder's release */ }
  }
  const lock: SwitchLock = {
    operation_id: operationId,
    agents,
    expires_at: new Date(nowOf(ctx).getTime() + LOCK_EXPIRY_MS).toISOString(),
  };
  try {
    // `wx` makes creation fail if another process won the race between the
    // read above and this write.
    writeFileSync(paths.lockPath, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', encoding: 'utf-8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SwitchLockedError(readSwitchLock(ctx) ?? {});
    }
    throw err;
  }
  return lock;
}

export function releaseSwitchLock(operationId: string, ctx: RegistryContext = {}): void {
  const paths = resolveRegistryPaths(ctx);
  const existing = readSwitchLock(ctx);
  if (!existing || existing.operation_id !== operationId) return;
  try { unlinkSync(paths.lockPath); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type ModelOperation =
  | { kind: 'switch'; role: string; tier: string; actor: string; reason: string; expectedRevision?: number; clearPins?: boolean }
  | { kind: 'pin'; agent: string; entry_id: string; actor: string; reason: string; expiresAt: string | null; expectedRevision?: number; fallback?: string[] }
  | { kind: 'unpin'; agent: string; actor: string; reason: string; expectedRevision?: number }
  | { kind: 'activation'; consumer?: string; org?: boolean; mode: ModelActivationMode; actor: string; reason: string; expectedRevision?: number }
  | { kind: 'revert'; operation_id: string; actor: string; reason: string; expectedRevision?: number };

export type Restarter = (agent: string) => Promise<ModelRestartResult>;

export interface ApplyOptions extends RegistryContext {
  /** Injected in tests; defaults to the daemon IPC stop+start lifecycle. */
  restart?: Restarter;
  /** Skip restarts entirely (preview / `--no-restart`). */
  skipRestart?: boolean;
  drainDeadlineMs?: number;
}

/** Agents whose routing changes as a result of this operation. */
export function affectedAgents(reg: ModelRegistry, op: ModelOperation, at: Date): string[] {
  switch (op.kind) {
    case 'switch':
      return Object.entries(reg.agents)
        .filter(([, a]) => a.role === op.role)
        // A dispatchable pin overrides the role, so those agents are unaffected
        // UNLESS the operation explicitly clears pins.
        .filter(([, a]) => op.clearPins || !isPinDispatchable(a.pin, at))
        .map(([name]) => name);
    case 'pin':
    case 'unpin':
      return reg.agents[op.agent] ? [op.agent] : [];
    case 'activation':
      if (op.org) return Object.keys(reg.agents);
      return op.consumer && reg.agents[op.consumer] ? [op.consumer] : [];
    case 'revert':
      return [];
  }
}

function defaultRestarter(ctx: RegistryContext): Restarter {
  return async (agent: string): Promise<ModelRestartResult> => {
    try {
      // Imported lazily so the registry service stays usable in tests and in
      // any context where the daemon IPC module is not wanted.
      const { IPCClient } = await import('../daemon/ipc-server.js');
      const ipc = new IPCClient(ctx.instanceId || process.env.CTX_INSTANCE_ID || 'default');
      if (!(await ipc.isDaemonRunning())) {
        return { agent, ok: false, detail: 'daemon not running; agent will pick up the new route on next start' };
      }
      const stop = await ipc.send({ type: 'stop-agent', agent, source: 'cortextos model switch' } as never);
      if (!stop.success) return { agent, ok: false, detail: `stop failed: ${stop.error}` };
      const start = await ipc.send({ type: 'start-agent', agent, source: 'cortextos model switch' } as never);
      if (!start.success) return { agent, ok: false, detail: `start failed: ${start.error}` };
      return { agent, ok: true, detail: 'restarted' };
    } catch (err) {
      return { agent, ok: false, detail: `restart error: ${(err as Error).message}` };
    }
  };
}

/**
 * Run one routing operation end to end:
 * requested → validated → desired_written → draining → applied|blocked|failed.
 *
 * Every transition appends an event file. Restarts run at concurrency 1 and
 * stop at the drain deadline — an operation that runs out of time is `blocked`
 * with a reason, never a killed agent mid-write.
 */
export async function applyOperation(op: ModelOperation, opts: ApplyOptions = {}): Promise<ModelOperationReceipt> {
  const ctx: RegistryContext = opts;
  const at = nowOf(ctx);
  const operationId = newId('op');
  const reg = loadRegistry(ctx);
  const before = reg.revision;
  const drainDeadline = opts.drainDeadlineMs ?? DRAIN_DEADLINE_MS;

  const receipt: ModelOperationReceipt = {
    operation_id: operationId,
    kind: op.kind,
    actor: op.actor,
    reason: op.reason,
    from: null,
    to: null,
    affected_consumers: [],
    registry_revision_before: before,
    registry_revision_after: before,
    state: 'requested',
    restart_results: [],
    created_at: isoOf(ctx),
    applied_at: null,
    error: null,
  };

  const emit = (state: ModelOperationState | 'revert', detail?: Record<string, unknown>): void => {
    appendEvent(
      {
        operation_id: operationId,
        state,
        kind: op.kind,
        actor: op.actor,
        reason: op.reason,
        at: isoOf(ctx),
        registry_revision: receipt.registry_revision_after,
        ...(detail ? { detail } : {}),
      },
      ctx,
    );
  };

  emit('requested', { op: { ...op, actor: undefined } as unknown as Record<string, unknown> });

  // --- validate -------------------------------------------------------------
  try {
    validateOperation(reg, op, at);
  } catch (err) {
    receipt.state = 'failed';
    receipt.error = (err as Error).message;
    emit('failed', { error: receipt.error });
    return receipt;
  }

  const expected = op.expectedRevision ?? before;
  if (expected !== before) {
    receipt.state = 'failed';
    receipt.error = new RegistryConflictError(expected, before).message;
    emit('failed', { error: receipt.error });
    return receipt;
  }

  const affected = affectedAgents(reg, op, at);
  receipt.affected_consumers = affected;
  receipt.state = 'validated';
  emit('validated', { affected_consumers: affected });

  // --- mutate ---------------------------------------------------------------
  const next: ModelRegistry = JSON.parse(JSON.stringify(reg)) as ModelRegistry;
  next.updated_by = op.actor;
  const change = mutateRegistry(next, op, at, receipt, ctx);
  receipt.from = change.from;
  receipt.to = change.to;

  let written: ModelRegistry;
  try {
    written = saveRegistryCAS(next, before, ctx);
  } catch (err) {
    receipt.state = 'failed';
    receipt.error = (err as Error).message;
    emit('failed', { error: receipt.error });
    return receipt;
  }
  receipt.registry_revision_after = written.revision;
  receipt.state = 'desired_written';
  emit('desired_written', { from: receipt.from, to: receipt.to });

  // --- drain + restart ------------------------------------------------------
  if (opts.skipRestart || affected.length === 0) {
    receipt.state = 'applied';
    receipt.applied_at = isoOf(ctx);
    emit('applied', { restart_results: receipt.restart_results, restarts_skipped: !!opts.skipRestart });
    return receipt;
  }

  let lock: SwitchLock;
  try {
    lock = acquireSwitchLock(operationId, affected, ctx);
  } catch (err) {
    receipt.state = 'blocked';
    receipt.error = (err as Error).message;
    emit('blocked', { error: receipt.error });
    return receipt;
  }

  receipt.state = 'draining';
  emit('draining', { agents: affected, lock_expires_at: lock.expires_at });

  const restart = opts.restart ?? defaultRestarter(ctx);
  const startedAt = Date.now();
  try {
    for (const agent of affected) {
      if (Date.now() - startedAt > drainDeadline) {
        receipt.state = 'blocked';
        receipt.error =
          `Drain deadline (${Math.round(drainDeadline / 1000)}s) reached with ` +
          `${affected.length - receipt.restart_results.length} agent(s) not yet restarted. ` +
          `Desired route is written; restart the remainder manually.`;
        emit('blocked', { error: receipt.error, restart_results: receipt.restart_results });
        return receipt;
      }
      // Concurrency 1: never restart two agents at once.
      const result = await restart(agent);
      if (result.ok) {
        const after = resolve({ agent }, ctx, written);
        result.observed_after = after.selected?.model_id ?? null;
      }
      receipt.restart_results.push(result);
    }
  } finally {
    releaseSwitchLock(operationId, ctx);
  }

  const anyFailed = receipt.restart_results.some((r) => !r.ok);
  receipt.state = anyFailed ? 'blocked' : 'applied';
  receipt.applied_at = isoOf(ctx);
  if (anyFailed) {
    receipt.error = `One or more agents did not restart: ${receipt.restart_results.filter((r) => !r.ok).map((r) => `${r.agent} (${r.detail})`).join('; ')}`;
  }
  emit(receipt.state, { restart_results: receipt.restart_results, ...(receipt.error ? { error: receipt.error } : {}) });
  return receipt;
}

function validateOperation(reg: ModelRegistry, op: ModelOperation, at: Date): void {
  switch (op.kind) {
    case 'switch': {
      if (!reg.roles[op.role]) throw new Error(`No role "${op.role}" in registry`);
      const tier = reg.tiers[op.tier];
      if (!tier) throw new Error(`No tier "${op.tier}" in registry`);
      if (tier.length === 0) throw new Error(`Tier "${op.tier}" is empty — an empty tier cannot dispatch work`);
      const role = { ...reg.roles[op.role], tier: op.tier };
      const viable = tier.filter((e) => validateCandidate(reg, e, { role }).length === 0);
      if (viable.length === 0) {
        throw new Error(
          `No entry in tier "${op.tier}" satisfies role "${op.role}" ` +
          `(capabilities ${role.required_capabilities.join(', ')}, min context ${role.min_context})`,
        );
      }
      return;
    }
    case 'pin': {
      const errors = validateCandidate(reg, op.entry_id, {
        role: reg.roles[reg.agents[op.agent]?.role ?? ''] ?? null,
        agentRuntime: null,
      });
      if (!reg.agents[op.agent]) throw new Error(`No agent "${op.agent}" in registry`);
      if (errors.length) throw new Error(`Pin target invalid: ${errors.map((e) => e.message).join('; ')}`);
      if (op.expiresAt && Date.parse(op.expiresAt) <= at.getTime()) {
        throw new Error(`Pin expiry ${op.expiresAt} is already in the past`);
      }
      return;
    }
    case 'unpin':
      if (!reg.agents[op.agent]) throw new Error(`No agent "${op.agent}" in registry`);
      return;
    case 'activation':
      if (!op.org && !op.consumer) throw new Error('activation requires --org or --consumer');
      return;
    case 'revert':
      return;
  }
}

function mutateRegistry(
  next: ModelRegistry,
  op: ModelOperation,
  at: Date,
  receipt: ModelOperationReceipt,
  ctx: RegistryContext,
): { from: unknown; to: unknown } {
  switch (op.kind) {
    case 'switch': {
      const from = { role: op.role, tier: next.roles[op.role].tier };
      next.roles[op.role] = { ...next.roles[op.role], tier: op.tier };
      const cleared: string[] = [];
      if (op.clearPins) {
        for (const [name, assignment] of Object.entries(next.agents)) {
          if (assignment.role === op.role && assignment.pin) {
            cleared.push(name);
            assignment.pin = null;
          }
        }
      }
      // Explicit switches opt the affected consumers into validated routing
      // immediately (contract §5 "Explicit switch during shadow").
      for (const agent of receipt.affected_consumers) {
        if (!next.activation.consumers[agent]) next.activation.consumers[agent] = 'enforced';
      }
      return { from, to: { role: op.role, tier: op.tier, cleared_pins: cleared } };
    }
    case 'pin': {
      const from = next.agents[op.agent].pin;
      const pin: ModelPin = {
        entry_id: op.entry_id,
        kind: 'explicit',
        reason: op.reason,
        actor: op.actor,
        created_at: at.toISOString(),
        expires_at: op.expiresAt,
        ...(op.fallback?.length ? { fallback: op.fallback } : {}),
      };
      next.agents[op.agent].pin = pin;
      if (!next.activation.consumers[op.agent]) next.activation.consumers[op.agent] = 'enforced';
      return { from, to: pin };
    }
    case 'unpin': {
      const from = next.agents[op.agent].pin;
      next.agents[op.agent].pin = null;
      return { from, to: null };
    }
    case 'activation': {
      if (op.org) {
        const from = next.activation.org_default;
        next.activation.org_default = op.mode;
        return { from: { org_default: from }, to: { org_default: op.mode } };
      }
      const from = next.activation.consumers[op.consumer!] ?? next.activation.org_default;
      next.activation.consumers[op.consumer!] = op.mode;
      return { from: { consumer: op.consumer, mode: from }, to: { consumer: op.consumer, mode: op.mode } };
    }
    case 'revert': {
      const target = findOperationEvents(op.operation_id, ctx).find((e) => e.state === 'desired_written');
      if (!target) throw new Error(`No desired_written event for operation ${op.operation_id}`);
      const detail = (target.detail ?? {}) as { from?: unknown; to?: unknown };
      applyRevertDetail(next, detail.from, at, op.actor, op.reason);
      return { from: detail.to ?? null, to: detail.from ?? null };
    }
  }
}

/** Restore the `from` snapshot recorded on the operation being reverted. */
function applyRevertDetail(
  next: ModelRegistry,
  from: unknown,
  at: Date,
  actor: string,
  reason: string,
): void {
  if (!from || typeof from !== 'object') throw new Error('Operation has no revertible prior state');
  const f = from as Record<string, unknown>;
  if (typeof f.role === 'string' && typeof f.tier === 'string') {
    if (!next.roles[f.role]) throw new Error(`Role "${f.role}" no longer exists`);
    next.roles[f.role] = { ...next.roles[f.role], tier: f.tier };
    return;
  }
  if (typeof f.org_default === 'string') {
    next.activation.org_default = f.org_default as ModelActivationMode;
    return;
  }
  if (typeof f.consumer === 'string' && typeof f.mode === 'string') {
    next.activation.consumers[f.consumer] = f.mode as ModelActivationMode;
    return;
  }
  if (typeof f.entry_id === 'string') {
    // Reverting to a previous pin. Find the agent it belonged to by entry match
    // is ambiguous, so pins carry their agent in the receipt `to`; the CLI passes
    // `--agent` for that case. Guard rather than guess.
    throw new Error('Reverting a pin requires `cortextos model pin/unpin --agent`; refusing to guess the target');
  }
  void at; void actor; void reason;
  throw new Error('Unrecognized prior state; refusing to revert blindly');
}

export function findOperationEvents(operationId: string, ctx: RegistryContext = {}): ModelEventRecord[] {
  const paths = resolveRegistryPaths(ctx);
  if (!existsSync(paths.eventsDir)) return [];
  return readdirSync(paths.eventsDir)
    .filter((f) => f.includes(operationId) && f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(paths.eventsDir, f), 'utf-8')) as ModelEventRecord;
      } catch {
        return null;
      }
    })
    .filter((e): e is ModelEventRecord => e !== null);
}

// ---------------------------------------------------------------------------
// Bootstrap migration (contract §5)
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  /** Directory actually scanned for `<agent>/config.json` (root diagnosis). */
  agents_dir: string;
  scanned: string[];
  legacy_pins: { agent: string; entry_id: string; expires_at: string }[];
  proposed_invalid: { agent: string; entry_id: string | null; model: string; runtime: string; reason: string; task_id?: string }[];
  unmatched: { agent: string; model: string; reason: string }[];
  registry_revision: number;
}

export interface BootstrapOptions extends RegistryContext {
  actor?: string;
  dryRun?: boolean;
  /** Injected in tests. Returns the created task id. */
  createHumanTask?: (title: string, description: string) => string | null;
}

/**
 * Import each agent config's literal `model` as a registry pin.
 *
 * Valid pairs become `legacy-migration` pins with a 30-day expiry. Invalid
 * pairs (the canonical case: trillion-coder pairing an Anthropic model id with
 * the codex runtime) become non-dispatchable `proposed-invalid` pins plus a
 * `[HUMAN]` task. Agent config.json is never written.
 */
export function migrateBootstrap(opts: BootstrapOptions = {}): BootstrapResult {
  const ctx: RegistryContext = opts;
  const at = nowOf(ctx);
  const reg = loadRegistry(ctx);
  const actor = opts.actor || 'jarvis';
  const result: BootstrapResult = {
    agents_dir: agentsDir(ctx),
    scanned: [],
    legacy_pins: [],
    proposed_invalid: [],
    unmatched: [],
    registry_revision: reg.revision,
  };

  const expiresAt = new Date(at.getTime() + LEGACY_PIN_DAYS * 86400_000).toISOString();

  for (const agent of Object.keys(reg.agents)) {
    const cfg = readAgentConfig(agent, ctx);
    if (!cfg || !cfg.model) continue;
    result.scanned.push(agent);
    const runtime = cfg.runtime || 'claude-code';

    // Candidate entries whose model id matches the literal.
    const matches = Object.entries(reg.entries).filter(([, e]) => e.model_id === cfg.model);
    if (matches.length === 0) {
      result.unmatched.push({ agent, model: cfg.model, reason: 'no registry entry has this model_id' });
      continue;
    }

    const valid = matches.find(([id]) => validateCandidate(reg, id, {
      role: reg.roles[reg.agents[agent].role] ?? null,
      agentRuntime: runtime,
    }).length === 0);

    if (valid) {
      const [entryId] = valid;
      reg.agents[agent].pin = {
        entry_id: entryId,
        kind: 'legacy-migration',
        reason: `Imported from ${agent}/config.json literal model "${cfg.model}" during bootstrap`,
        actor,
        created_at: at.toISOString(),
        expires_at: expiresAt,
      };
      result.legacy_pins.push({ agent, entry_id: entryId, expires_at: expiresAt });
      continue;
    }

    // Invalid pair — record WHY, pin as proposed-invalid, raise a human item.
    const [entryId] = matches[0];
    const why = validateCandidate(reg, entryId, {
      role: reg.roles[reg.agents[agent].role] ?? null,
      agentRuntime: runtime,
    })
      .map((e) => e.message)
      .join('; ');
    reg.agents[agent].pin = {
      entry_id: entryId,
      kind: 'proposed-invalid',
      reason: `Legacy pair is invalid and cannot dispatch: ${why}`,
      actor,
      created_at: at.toISOString(),
      expires_at: expiresAt,
    };
    const item = {
      agent,
      entry_id: entryId,
      model: cfg.model,
      runtime,
      reason: why,
    } as BootstrapResult['proposed_invalid'][number];

    if (!opts.dryRun) {
      const taskId = (opts.createHumanTask ?? defaultHumanTaskCreator(ctx))(
        `[HUMAN] Model routing: invalid legacy pair for ${agent}`,
        `Agent "${agent}" declares runtime "${runtime}" with literal model "${cfg.model}". ` +
          `That pair cannot dispatch: ${why}\n\n` +
          `A non-dispatchable proposed-invalid pin was recorded on entry "${entryId}". ` +
          `Decide the real route and apply it with:\n` +
          `  cortextos model pin --agent ${agent} --entry <entry_id> --reason "..." --expires-at <ISO>\n` +
          `or clear the pin and let the role tier apply:\n` +
          `  cortextos model unpin --agent ${agent} --reason "..."`,
      );
      if (taskId) item.task_id = taskId;
    }
    result.proposed_invalid.push(item);
  }

  // A scan that found no agent config changed nothing: writing here would bump
  // the revision (and journal an event) for a no-op, which is exactly what a
  // misresolved root used to do silently.
  if (!opts.dryRun && result.scanned.length > 0) {
    reg.updated_by = actor;
    const written = saveRegistryCAS(reg, result.registry_revision, ctx);
    result.registry_revision = written.revision;
    appendEvent(
      {
        operation_id: newId('op'),
        state: 'applied',
        kind: 'pin',
        actor,
        reason: 'bootstrap: imported legacy agent config models as pins',
        at: isoOf(ctx),
        registry_revision: written.revision,
        detail: {
          legacy_pins: result.legacy_pins,
          proposed_invalid: result.proposed_invalid,
          unmatched: result.unmatched,
        },
      },
      ctx,
    );
  }

  return result;
}

function defaultHumanTaskCreator(ctx: RegistryContext): (title: string, description: string) => string | null {
  return (title, description) => {
    try {
      // Lazy require keeps the task module (and its fs layout assumptions) out
      // of the hot path for pure resolve() callers.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createTask } = require('./task.js') as typeof import('./task.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolvePaths } = require('../utils/paths.js') as typeof import('../utils/paths.js');
      const org = ctx.org || process.env.CTX_ORG || DEFAULT_ORG;
      const instanceId = ctx.instanceId || process.env.CTX_INSTANCE_ID || 'default';
      const paths = resolvePaths('jarvis', instanceId, org);
      if (ctx.ctxRoot) {
        paths.taskDir = join(ctx.ctxRoot, 'orgs', org, 'tasks');
      }
      return createTask(paths, 'jarvis', org, title, {
        description,
        assignee: 'scott',
        priority: 'high',
        project: 'model-routing',
      });
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Read-only summary for the dashboard (`GET /api/model-routing`)
// ---------------------------------------------------------------------------

export function registrySummary(ctx: RegistryContext = {}, limit = 20): {
  registry: Pick<ModelRegistry, 'schema_version' | 'revision' | 'updated_at' | 'updated_by' | 'activation' | 'adapters' | 'entries' | 'tiers' | 'org_default_tier' | 'roles' | 'agents' | 'callsites'>;
  events: ModelEventRecord[];
  attempts: ModelAttemptRecord[];
} {
  const reg = loadRegistry(ctx);
  // Every field here is already secret-free: entries carry auth source NAMES
  // (`env:OPENAI_API_KEY`), never values.
  return { registry: reg, events: listEvents(ctx, limit), attempts: listAttempts(ctx, limit) };
}

export function ensureRegistryDirs(ctx: RegistryContext = {}): RegistryPaths {
  const paths = resolveRegistryPaths(ctx);
  mkdirSync(paths.attemptsDir, { recursive: true });
  return paths;
}
