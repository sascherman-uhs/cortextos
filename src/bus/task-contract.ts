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
  /** Multi-hop routes an interactive caller may ask for in one gesture. The
   *  legs are executed and audited individually; this only says which chains
   *  are a legitimate single intent (plan §3 keeps the state graph as-is). */
  interactive_paths?: Record<string, Record<string, CanonicalState[]>>;
  legacy_grandfather?: {
    waivable_violations: string[];
    never_waivable: string[];
    fields: string[];
    done_requires_evidence_without_criteria?: boolean;
  };
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
  /**
   * Stamped by the create path of a contract-aware writer. Its ABSENCE is the
   * structural marker of legacy work: a record that predates the contract
   * carries none of the contract's required fields because nothing ever asked
   * it for them. Never a date comparison — "created before X" would grandfather
   * new work written by an unmigrated producer, and would strand genuinely old
   * work whose timestamp is missing or wrong.
   */
  contract_version?: number | null;
  /** True once a human advanced this item under a recorded waiver. It stays
   *  true forever: the completion gate reads it to refuse a criteria-free Done. */
  legacy_grandfathered?: boolean;
}

/** A human's explicit waiver of the fields legacy work never had. */
export interface GrandfatherRequest {
  /** The person taking responsibility. Never a program name. */
  actor?: string;
  reason?: string;
}

export interface TransitionContext {
  unsatisfied_dependencies?: string[];
  /** Present only when a human explicitly chose the waive path in the UI. */
  grandfather?: GrandfatherRequest;
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
  /** Contract fields this record does not have. Drives the inline "supply them
   *  now" form rather than a dead end. */
  missing?: string[];
  /** The record predates the contract and is missing required fields. */
  legacy?: boolean;
  /** This particular refusal is one a human may waive on a legacy record. */
  waivable?: boolean;
  /** The transition was permitted only because a human waived `waived`. */
  grandfathered?: boolean;
  waived?: string[];
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
 * Which contract-required fields this record does not carry.
 *
 * `owner` is one entry, not two: the contract asks for an agent role OR a
 * human decider, and satisfying either satisfies the requirement.
 */
export function missingContractFields(item: ContractItem): string[] {
  const missing: string[] = [];
  if (!item.outcome) missing.push('outcome');
  if (!hasOwner(item)) missing.push('owner');
  if (acceptance(item).length === 0) missing.push('acceptance_criteria');
  return missing;
}

/**
 * Was this record created UNDER the contract?
 *
 * The `contract_version` stamp is written by the create path of a contract-aware
 * writer. Anything without it was written by something that never knew the
 * required fields existed. This is the whole legacy test, and it is structural:
 * no timestamp, no id range, no row count.
 */
export function isContractNative(item: ContractItem): boolean {
  return typeof item.contract_version === 'number' && item.contract_version >= 1;
}

/**
 * Eligible for the legacy path: not created under the contract AND actually
 * missing something the contract requires.
 *
 * A contract-era record is never eligible however incomplete it is — that is
 * plan §4's "enable required fields for new work first" read the strict way
 * round. A pre-contract record that happens to carry every field is not
 * eligible either, because it does not need to be: it passes on the merits.
 */
export function isLegacyItem(item: ContractItem): boolean {
  return !isContractNative(item) && missingContractFields(item).length > 0;
}

/** Violations a human may waive on a legacy record, from the fixture. */
function waivableViolations(contract: TransitionContract): string[] {
  return contract.legacy_grandfather?.waivable_violations ?? [];
}

/**
 * The legs an interactive request from `from` to `to` decomposes into.
 *
 * A person clicking Start on a backlog card is asking for one thing, but the
 * contract's only route out of backlog runs through `ready` — the same way
 * finishing work runs through `verify`. Returning the chain lets the boundary
 * execute and audit every leg on its own terms instead of either refusing the
 * gesture or inventing a shortcut edge. Returns null when there is no route.
 */
export function resolveInteractivePath(
  from: CanonicalState | string,
  to: CanonicalState | string,
  contract = loadContract(),
): CanonicalState[] | null {
  if (from === to) return [];
  if ((contract.allowed_transitions[String(from)] ?? []).includes(to as CanonicalState)) {
    return [to as CanonicalState];
  }
  const chain = contract.interactive_paths?.[String(from)]?.[String(to)];
  if (!chain || chain.length === 0) return null;
  // Every declared chain is re-verified against the state graph rather than
  // trusted: a typo in the fixture must not mint an edge that does not exist.
  let cursor = String(from);
  for (const hop of chain) {
    if (!(contract.allowed_transitions[cursor] ?? []).includes(hop)) return null;
    cursor = hop;
  }
  return cursor === to ? [...chain] : null;
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
  context: TransitionContext = {},
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
    // Dependencies first, deliberately. An open dependency is a fact about the
    // world, not a gap in an old record, so it must be judged before anything
    // can be waived — otherwise a waiver could dispatch work whose inputs do
    // not exist yet.
    const unmet = context.unsatisfied_dependencies ?? [];
    if (unmet.length) return { ok: false, error: 'unsatisfied_dependencies', detail: unmet.join(', ') };

    const missing = missingContractFields(item);
    if (missing.length === 0) return { ok: true };

    const violation =
      missing.includes('outcome') ? 'missing_outcome'
      : missing.includes('owner') ? 'missing_owner'
      : 'missing_acceptance_criteria';
    const detail =
      violation === 'missing_outcome' ? 'Ready requires a stated outcome'
      : violation === 'missing_owner'
        ? 'Ready requires agent_role_id (dispatchable work) or human_accountable_id (a decision)'
        : 'Ready requires acceptance criteria';

    const legacy = isLegacyItem(item);
    const waivable = legacy && missing.every((f) =>
      waivableViolations(contract).includes(f === 'owner' ? 'missing_owner' : `missing_${f}`));

    const gf = context.grandfather;
    if (gf) {
      // A waiver is a named person's decision, on the record. An unnamed or
      // unexplained one is not a decision, it is a shrug.
      if (!gf.actor) {
        return {
          ok: false, error: 'missing_grandfather_actor', missing, legacy, waivable,
          detail: 'Advancing legacy work without its required fields has to be attributed to a person',
        };
      }
      if (!gf.reason) {
        return {
          ok: false, error: 'missing_grandfather_reason', missing, legacy, waivable,
          detail: 'Advancing legacy work without its required fields has to record why',
        };
      }
      if (!legacy) {
        // New work. The waiver is the wrong tool and saying so is the point:
        // the fix is to write the acceptance criteria, not to route around them.
        return {
          ok: false, error: violation, detail:
            `${detail}. This task was created under the work contract, so its required fields cannot be waived.`,
          missing, legacy: false, waivable: false,
        };
      }
      if (!waivable) return { ok: false, error: violation, detail, missing, legacy, waivable: false };
      return { ok: true, grandfathered: true, waived: [...missing] };
    }

    return { ok: false, error: violation, detail, missing, legacy, waivable };
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

    // A record with no acceptance criteria would otherwise clear the loop above
    // vacuously — which is exactly the shape of every legacy task, and of every
    // task advanced under a waiver. Grandfathering buys entry into the working
    // states; it never buys the proof gate (plan §12: no verified Done without
    // proof). With nothing to check, there must at least be something to show.
    if (criteria.length === 0 && !EVIDENCE_ANY.some((k) => Boolean(evidence[k]))) {
      return {
        ok: false, error: 'missing_evidence',
        detail:
          'This task has no acceptance criteria, so Done requires an artifact or result to show for it. '
          + 'An empty checklist is not a passed checklist.',
      };
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
  context: TransitionContext = {},
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
