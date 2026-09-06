/**
 * OS-02 accountable-work contract — TypeScript half.
 *
 * The rules themselves live in `tests/fixtures/task-transition-contract.json`,
 * byte-identical in uhsJARVIS where the Python half loads the same file. This
 * module is the logic that reads them: which transitions are legal, what proof
 * each one costs, and how the native CortexOS status vocabulary maps onto the
 * canonical one.
 *
 * Two rules this file exists to make unavoidable:
 *
 *  - A model saying "done", a zero exit code, and an HTTP 200 are not evidence.
 *    Leaving `doing` requires an artifact; reaching `done` requires the stated
 *    acceptance checks to have recorded results, and — for code, external
 *    writes and high-impact work — a verifier who is not the author.
 *  - The canonical vocabulary is a PROJECTION. Nothing here rewrites a native
 *    status enum. `toNative` exists precisely so the new vocabulary can be
 *    spoken at the boundary while the store keeps its own words (plan §3).
 */

import { TRANSITION_CONTRACT } from './transition-contract.generated.js';

export type CanonicalState =
  | 'backlog' | 'ready' | 'doing' | 'verify'
  | 'waiting' | 'done' | 'cancelled' | 'failed_terminal';

export type RunStatus = 'started' | 'succeeded' | 'failed' | 'abandoned';
export type WorkType = 'work' | 'obligation' | 'improvement';
export type ImpactClass = 'low_impact_deterministic' | 'code' | 'external' | 'high_impact';

export interface TransitionContract {
  contract_version: number;
  canonical_states: CanonicalState[];
  terminal_states: CanonicalState[];
  waiting_subtypes: string[];
  run_statuses: RunStatus[];
  allowed_transitions: Record<string, CanonicalState[]>;
  requirements: Record<string, Record<string, unknown>>;
  impact_classes: ImpactClass[];
  work_types: WorkType[];
  native_to_canonical: Record<string, Record<string, CanonicalState>>;
  canonical_to_native: Record<string, Record<string, string>>;
  legacy_completion_label: string;
  cases?: unknown[];
}

/** The work record a transition is being judged against. */
export interface ContractItem {
  outcome?: string;
  type?: WorkType;
  impact_class?: ImpactClass;
  author?: string;
  agent_role_id?: string;
  human_accountable_id?: string;
  acceptance_criteria?: unknown[];
  dependency_ids?: string[];
}

/** What the caller offers as proof. */
export interface Evidence {
  artifact?: unknown;
  artifacts?: unknown;
  result?: unknown;
  pr?: unknown;
  release?: unknown;
  receipt?: unknown;
  run_id?: unknown;
  acceptance_results?: { check?: unknown; passed?: unknown }[];
  verifier?: string;
  verification_method?: string;
  reason?: string;
  disposition?: string;
  actor?: string;
  [k: string]: unknown;
}

export interface CheckResult {
  ok: boolean;
  error?: string;
  detail?: string;
  /** Re-asserting the current state. Legal and idempotent, not an error. */
  noop?: boolean;
}

const EVIDENCE_ANY = ['artifact', 'artifacts', 'result', 'pr', 'release', 'receipt', 'run_id'] as const;

export function loadContract(): TransitionContract {
  return TRANSITION_CONTRACT;
}

/**
 * Project a native status onto the canonical vocabulary. An unmapped status
 * becomes `waiting`, never a happy state — an unrecognised status is exactly
 * where coercing to "pending" or "done" loses work.
 */
export function toCanonical(
  source: string,
  nativeStatus: string | null | undefined,
  contract = loadContract(),
): CanonicalState {
  const table = contract.native_to_canonical[source] ?? {};
  return table[String(nativeStatus ?? '').trim().toLowerCase()] ?? 'waiting';
}

/** Map a canonical state back to a word the given store actually accepts. */
export function toNative(
  source: string,
  canonical: CanonicalState,
  contract = loadContract(),
): string | undefined {
  return contract.canonical_to_native[source]?.[canonical];
}

function acceptance(item: ContractItem): unknown[] {
  const raw = item.acceptance_criteria;
  return Array.isArray(raw) ? raw : [];
}

function hasOwner(item: ContractItem): boolean {
  return Boolean(item.agent_role_id || item.human_accountable_id);
}

/**
 * Validate one canonical transition. Pure: no I/O, no clock, no store.
 * Every branch mirrors a numbered rule in plan §3/§4 — see the fixture's
 * `requirements` block for the sentence each one enforces.
 */
export function checkTransition(
  from: CanonicalState | string,
  to: CanonicalState | string,
  item: ContractItem = {},
  evidence: Evidence = {},
  context: { unsatisfied_dependencies?: string[] } = {},
  contract = loadContract(),
): CheckResult {
  const states = contract.canonical_states as string[];
  if (!states.includes(from)) return { ok: false, error: 'unknown_from_state', detail: String(from) };
  if (!states.includes(to)) return { ok: false, error: 'unknown_to_state', detail: String(to) };
  if (from === to) return { ok: true, noop: true };

  if (!(contract.allowed_transitions[from] ?? []).includes(to as CanonicalState)) {
    return { ok: false, error: 'illegal_transition', detail: `${from} -> ${to} is not in the contract` };
  }

  if (to === 'ready') {
    if (!item.outcome) return { ok: false, error: 'missing_outcome', detail: 'Ready requires a stated outcome' };
    if (!hasOwner(item)) {
      return {
        ok: false, error: 'missing_owner',
        detail: 'Ready requires agent_role_id (dispatchable work) or human_accountable_id (a decision)',
      };
    }
    if (acceptance(item).length === 0) {
      return { ok: false, error: 'missing_acceptance_criteria', detail: 'Ready requires acceptance criteria' };
    }
    const unmet = context.unsatisfied_dependencies ?? [];
    if (unmet.length) return { ok: false, error: 'unsatisfied_dependencies', detail: unmet.join(', ') };
    return { ok: true };
  }

  if (to === 'verify') {
    if (!EVIDENCE_ANY.some((k) => Boolean(evidence[k]))) {
      return {
        ok: false, error: 'missing_evidence',
        detail: 'Doing -> Verify requires an artifact or result. A claim of success is not evidence.',
      };
    }
    return { ok: true };
  }

  if (to === 'done') {
    const criteria = acceptance(item);
    const results = evidence.acceptance_results ?? [];
    const byCheck = new Map(results.map((r) => [String(r?.check), r]));
    for (const crit of criteria) {
      const r = byCheck.get(String(crit));
      if (!r) {
        return {
          ok: false, error: 'acceptance_checks_incomplete',
          detail: `no recorded result for acceptance check: ${String(crit)}`,
        };
      }
      if (!r.passed) return { ok: false, error: 'acceptance_check_failed', detail: String(crit) };
    }

    const verifier = evidence.verifier;
    if (!verifier) {
      return { ok: false, error: 'missing_verifier', detail: 'Verify -> Done requires a named verifier' };
    }

    // Default to the strictest class. An item that never declared its impact is
    // treated as high-impact, so silence buys no leniency.
    const impact = item.impact_class ?? 'high_impact';
    const needsIndependent =
      (contract.requirements.done.verifier_distinct_from_author_for as string[]).includes(impact);
    if (needsIndependent && verifier === item.author) {
      return {
        ok: false, error: 'verifier_is_author',
        detail: `${impact} work needs independent verification; ${verifier} authored it`,
      };
    }
    return { ok: true };
  }

  if (to === 'failed_terminal') {
    if ((item.type ?? 'work') === 'obligation') {
      return {
        ok: false, error: 'obligation_cannot_fail_terminal',
        detail: 'An obligation keeps its owner and due date through retry exhaustion',
      };
    }
    if (!evidence.reason) return { ok: false, error: 'missing_reason', detail: 'failed_terminal requires a reason' };
    if (!evidence.disposition) {
      return { ok: false, error: 'missing_disposition', detail: 'failed_terminal requires a disposition' };
    }
    return { ok: true };
  }

  if (to === 'cancelled') {
    if (!evidence.reason) return { ok: false, error: 'missing_reason', detail: 'Cancellation requires a reason' };
    if (!evidence.actor) return { ok: false, error: 'missing_actor', detail: 'Cancellation requires a named actor' };
    return { ok: true };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Enforcement gating
// ---------------------------------------------------------------------------

export type EnforcementMode = 'shadow' | 'enforced';
export const FLAG_NAME = 'AGENTIC_OS_TASK_CONTRACT';

/**
 * Where a transition came from.
 *
 *  - `interactive` — a human acting through a UI or an HTTP API. ALWAYS
 *    enforced. The shadow flag exists to migrate background writers one at a
 *    time; it was never a licence for a person to click past the contract.
 *  - `writer` — a background producer still being migrated. Honours the
 *    per-source shadow flag.
 *
 * The default everywhere is `interactive`: a caller that cannot prove it is a
 * migrating writer is enforced. Only the CLI (the one surface the legacy fleet
 * actually calls) declares `writer`, and the HTTP boundary never lets a client
 * choose — see dashboard/src/lib/task-transition.ts.
 */
export type TransitionOrigin = 'interactive' | 'writer';

/** Legal next states from `from`, for a refusal message that tells the person
 *  what they CAN do instead of only what they cannot. */
export function legalTransitionsFrom(
  from: CanonicalState | string,
  contract = loadContract(),
): CanonicalState[] {
  return contract.allowed_transitions[String(from)] ?? [];
}

/**
 * Effective mode for one source.
 *
 * Precedence: `AGENTIC_OS_TASK_CONTRACT__<SOURCE>`, then
 * `AGENTIC_OS_TASK_CONTRACT`, then the flags file the caller passes in, then
 * `shadow`. Anything that is not exactly `enforced` means shadow — a typo must
 * fail open, not silently start blocking every writer in the fleet.
 */
export function enforcementMode(
  source: string,
  flags?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): EnforcementMode {
  const candidates = [env[`${FLAG_NAME}__${source.toUpperCase()}`], env[FLAG_NAME]];
  for (const c of candidates) {
    if (c) return c.trim().toLowerCase() === 'enforced' ? 'enforced' : 'shadow';
  }
  const reg = (flags?.[FLAG_NAME] ?? {}) as { default?: string; sources?: Record<string, string> };
  const value = reg.sources?.[source] ?? reg.default ?? 'shadow';
  return String(value).trim().toLowerCase() === 'enforced' ? 'enforced' : 'shadow';
}

/**
 * The mode that actually applies to one transition, given where it came from.
 *
 * An interactive transition is enforced no matter what the flag says. This is
 * the distinction the shadow flag was missing: a legacy background writer gets
 * a migration window, a human's dashboard click does not. Plan §4 puts the
 * rules "in server/worker boundaries"; plan §12's hard invariant is "no
 * verified Done without proof" — a flag that let a UI skip both made the
 * invariant a suggestion.
 */
export function effectiveMode(
  source: string,
  origin: TransitionOrigin = 'interactive',
  flags?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): EnforcementMode {
  if (origin !== 'writer') return 'enforced';
  return enforcementMode(source, flags, env);
}

export class ContractViolation extends Error {
  /** What the record COULD move to from here. Carried so the refusal a person
   *  sees names the legal moves rather than only the illegal one. */
  readonly legalTransitions: CanonicalState[];

  constructor(
    readonly source: string,
    readonly result: CheckResult,
    readonly from: string,
    readonly to: string,
  ) {
    super(`[${source}] ${from} -> ${to} refused: ${result.error}${result.detail ? ` (${result.detail})` : ''}`);
    this.name = 'ContractViolation';
    this.legalTransitions = legalTransitionsFrom(from);
  }
}

/**
 * Validate, then act on the mode that applies to this source AND this origin:
 * shadow logs and lets the caller proceed, enforced throws. Shadow mode is the
 * migration strategy for background writers — a writer nobody knew about
 * surfaces as a log line before it surfaces as an outage. It is NOT available
 * to an interactive caller, which is always enforced.
 */
export function guardTransition(
  source: string,
  from: CanonicalState | string,
  to: CanonicalState | string,
  item: ContractItem = {},
  evidence: Evidence = {},
  context: { unsatisfied_dependencies?: string[] } = {},
  opts: {
    flags?: Record<string, unknown>;
    log?: (m: string) => void;
    env?: NodeJS.ProcessEnv;
    /** Defaults to `interactive` — enforced. Only a caller that can prove it is
     *  a migrating background writer passes `writer`. */
    origin?: TransitionOrigin;
  } = {},
): CheckResult {
  const result = checkTransition(from, to, item, evidence, context);
  if (result.ok) return result;
  const origin: TransitionOrigin = opts.origin ?? 'interactive';
  const mode = effectiveMode(source, origin, opts.flags, opts.env);
  const message =
    `[task-contract:${mode}:${origin}] ${source}: ${from} -> ${to} violates ${result.error}` +
    (result.detail ? ` (${result.detail})` : '');
  (opts.log ?? ((m: string) => console.warn(m)))(message);
  if (mode === 'enforced') throw new ContractViolation(source, result, String(from), String(to));
  return result;
}
