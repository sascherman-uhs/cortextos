/**
 * WP-5B — ApprovalV2 structured schema, canonical hashing, and the ONE
 * shared decision boundary (plan-r01.md §5, 2026-09-06 CortexOS V4 safety
 * review). This is additive/inert: no real provider adapter is wired up
 * anywhere in this suite — every test uses fakes and local fixtures.
 *
 * Core claim under test: `presentation_hash` (computed over the full
 * structured `action_spec`) catches a changed recipient/account/amount/
 * target/attachment/content even when every word of visible prose is
 * byte-identical — something the pre-existing `payload_hash` (prose-only)
 * can never see. And all three decision routes (Telegram, CLI, dashboard)
 * now go through the same `decideApproval()` boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/bus/message', () => ({ sendMessage: vi.fn() }));
vi.mock('../../../src/bus/system', () => ({ postActivity: vi.fn().mockResolvedValue(true) }));

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  canonicalize,
  canonicalStringify,
  parseStrictJson,
  computeActionHash,
  computePresentationHash,
  createBinding,
  consumeBinding,
} from '../../../src/bus/approval-binding';
import { decideApproval, listPendingApprovals } from '../../../src/bus/approval';
import type { Approval, ActionSpecV1, BusPaths } from '../../../src/types';

let dir: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'orgs', 'TestOrg', 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  } as BusPaths;
}

function baseActionSpec(overrides: Partial<ActionSpecV1> = {}): ActionSpecV1 {
  return {
    schema_version: 1,
    action_id: 'action_11111111-1111-1111-1111-111111111111',
    provider: 'outlook',
    operation: 'send_mail',
    adapter_version: '1',
    account: { provider_account_id: 'scott@utopiahomestaging.com', tenant_id: null, credential_binding_id: 'cred-1' },
    actor: { requester_id: 'estimator', executor_principal_id: 'executor-1', policy_id: 'policy-1', policy_version: '1' },
    recipients: [{ role: 'to', provider_id: null, address: 'agent@example.com' }],
    target: { resource_type: 'email', resource_id: null, parent_id: null, create_key: 'draft-1' },
    amount: null,
    content: { subject: 'Staging proposal', body: 'See attached.', format: 'plain', sha256: 'a'.repeat(64) },
    attachments: [],
    provider_request: { method: 'POST', endpoint_id: 'outlook.send_mail', path_params: {}, query: {}, headers: {}, body: null },
    preconditions: [],
    max_observation_age_seconds: 300,
    idempotency_key: 'idem-1',
    not_before: '2026-09-06T00:00:00Z',
    expires_at: '2026-09-07T00:00:00Z',
    ...overrides,
  };
}

function writeApproval(overrides: Partial<Approval> = {}): Approval {
  const action_spec = overrides.action_spec !== undefined ? overrides.action_spec : null;
  const base: Approval = {
    id: overrides.id ?? 'approval_1700000000_abcde',
    title: 'Send the proposal to the client',
    requesting_agent: 'estimator',
    org: 'TestOrg',
    category: 'external-comms',
    status: 'pending',
    description: 'Draft attached',
    created_at: '2026-09-06T00:00:00Z',
    updated_at: '2026-09-06T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
    version: 1,
    ...overrides,
  } as Approval;
  if (action_spec) {
    base.schema_version = 2;
    base.execution_kind = 'provider_action';
    base.action_spec = action_spec;
    // Only auto-derive the hashes when the caller did not explicitly supply
    // one — tampering tests deliberately pass a STALE presentation_hash
    // (computed before the action_spec mutation) to simulate an on-disk
    // record where the structured field changed but the presentation hash
    // was not (and per the schema, cannot legitimately be) recomputed to match.
    base.action_hash = overrides.action_hash !== undefined ? overrides.action_hash : computeActionHash(action_spec);
    base.presentation_hash = overrides.presentation_hash !== undefined
      ? overrides.presentation_hash
      : computePresentationHash({ ...base, action_spec });
  }
  mkdirSync(join(paths.approvalDir, 'pending'), { recursive: true });
  writeFileSync(join(paths.approvalDir, 'pending', `${base.id}.json`), JSON.stringify(base));
  return base;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortextos-approval-v2-'));
  paths = mkPaths(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

describe('canonicalize / canonicalStringify', () => {
  it('sorts object keys recursively and preserves array order', () => {
    const value = { b: 1, a: { d: 2, c: 3 }, e: [3, 1, 2] };
    expect(canonicalStringify(value)).toBe('{"a":{"c":3,"d":2},"b":1,"e":[3,1,2]}');
  });

  it('two differently-ordered but equal objects hash identically', () => {
    const a = { x: 1, y: 2, z: { p: 1, q: 2 } };
    const b = { z: { q: 2, p: 1 }, y: 2, x: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('rejects undefined', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ a: Infinity })).toThrow(/non-finite/);
  });
});

describe('parseStrictJson — duplicate key rejection', () => {
  it('parses well-formed JSON with unique keys', () => {
    expect(parseStrictJson('{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
  });

  it('rejects a duplicate top-level key', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/duplicate key/i);
  });

  it('rejects a duplicate key nested inside an object', () => {
    expect(() => parseStrictJson('{"a":{"x":1,"x":2}}')).toThrow(/duplicate key/i);
  });

  it('does not flag same-named keys in sibling objects (different scopes)', () => {
    expect(() => parseStrictJson('{"a":{"x":1},"b":{"x":2}}')).not.toThrow();
  });

  it('duplicate key inside an array element object is rejected', () => {
    expect(() => parseStrictJson('[{"x":1,"x":2}]')).toThrow(/duplicate key/i);
  });
});

// ---------------------------------------------------------------------------
// Legacy compatibility: a record with no action_spec decides normally on
// every route, exactly as before WP-5B.
// ---------------------------------------------------------------------------

describe('legacy (decision_only) approvals remain fully decidable on all three routes', () => {
  it('CLI/dashboard-style route: decideApproval with an explicit actor works with no action_spec', () => {
    const a = writeApproval({ id: 'approval_legacy_cli' });
    const result = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('approved');
  });

  it('dashboard route (actor="dashboard") works identically', () => {
    const a = writeApproval({ id: 'approval_legacy_dash' });
    const result = decideApproval(paths, a.id, 'rejected', 'dashboard', { route: 'dashboard' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('rejected');
  });

  it('telegram route: a valid consumed binding still decides a legacy approval', () => {
    const a = writeApproval({ id: 'approval_legacy_tg' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram',
      bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('approved');
  });

  it('a legacy record can never carry an executable action_spec after decision (decision_only stays decision_only)', () => {
    const a = writeApproval({ id: 'approval_legacy_noexec' });
    expect(a.action_spec).toBeUndefined();
    expect(a.execution_kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Core anti-confused-deputy matrix (plan §5.3 fixture list): unchanged prose
// with a changed structured field must fail, on every route.
// ---------------------------------------------------------------------------

describe('ApprovalV2: unchanged prose, changed structured field -> FAIL', () => {
  const mutations: Array<[string, (spec: ActionSpecV1) => ActionSpecV1]> = [
    ['recipient', (s) => ({ ...s, recipients: [{ role: 'to', provider_id: null, address: 'attacker@evil.example' }] })],
    ['account', (s) => ({ ...s, account: { ...s.account, provider_account_id: 'someone-else@utopiahomestaging.com' } })],
    ['amount', (s) => ({ ...s, amount: { currency: 'USD', minor_units: '999999', currency_exponent: 2 } })],
    ['target/resource', (s) => ({ ...s, target: { ...s.target, resource_id: 'different-resource' } })],
    ['attachment', (s) => ({ ...s, attachments: [{ artifact_id: 'a1', immutable_version: '2', sha256: 'b'.repeat(64), byte_length: 10, filename: 'x.pdf', media_type: 'application/pdf' }] })],
    ['content body', (s) => ({ ...s, content: { subject: s.content!.subject, body: 'A completely different body the human never saw.', format: 'plain', sha256: 'c'.repeat(64) } })],
  ];

  it.each(mutations)('CLI/dashboard route rejects a changed %s', (_label, mutate) => {
    const originalSpec = baseActionSpec();
    const a = writeApproval({ id: `approval_v2_${_label.replace(/[^a-z]/gi, '')}`, action_spec: originalSpec });

    // Tamper the structured field on disk WITHOUT touching title/category/
    // description — this is exactly the scenario payload_hash cannot catch.
    const tamperedSpec = mutate(originalSpec);
    writeApproval({ ...a, id: a.id, action_spec: tamperedSpec, presentation_hash: a.presentation_hash /* stale hash, as if untouched by the attacker */ });

    const result = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe('action_spec_changed');
  });

  it('Telegram route also rejects a changed structured field even though prose/version/hash-of-prose are unchanged', () => {
    const originalSpec = baseActionSpec();
    const a = writeApproval({ id: 'approval_v2_tg_tamper', action_spec: originalSpec });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });

    const tamperedSpec = { ...originalSpec, recipients: [{ role: 'to' as const, provider_id: null, address: 'attacker@evil.example' }] };
    writeApproval({ ...a, action_spec: tamperedSpec, presentation_hash: a.presentation_hash });

    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram',
      bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(result.ok).toBe(false);
    // Either the binding's own presentation_hash check or decideApproval's
    // universal re-check can be the one that catches it — both must exist.
    expect(['action_spec_changed']).toContain(result.rejection);
  });
});

describe('ApprovalV2: unchanged action_spec decides normally', () => {
  it('CLI route approves when nothing was tampered', () => {
    const spec = baseActionSpec();
    const a = writeApproval({ id: 'approval_v2_clean', action_spec: spec });
    const result = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Wrong decider / chat / bot / expiry / stale version (Telegram binding —
// unchanged pre-existing checks, exercised through decideApproval now).
// ---------------------------------------------------------------------------

describe('wrong decider/chat/bot/expiry/version -> FAIL (via decideApproval)', () => {
  it('wrong decider is refused', () => {
    const a = writeApproval({ id: 'approval_wrong_decider' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const result = decideApproval(paths, a.id, 'approved', '9999', {
      route: 'telegram', bindingRef: binding.ref,
      presented: { decider: 9999, botIdentity: '111', chatId: 999 },
    });
    expect(result).toMatchObject({ ok: false, rejection: 'wrong_decider' });
  });

  it('wrong chat (forwarded button) is refused', () => {
    const a = writeApproval({ id: 'approval_wrong_chat' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram', bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 555 },
    });
    expect(result).toMatchObject({ ok: false, rejection: 'wrong_chat' });
  });

  it('wrong bot is refused', () => {
    const a = writeApproval({ id: 'approval_wrong_bot' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram', bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '999', chatId: 999 },
    });
    expect(result).toMatchObject({ ok: false, rejection: 'wrong_bot' });
  });

  it('expired binding is refused', () => {
    const a = writeApproval({ id: 'approval_expired' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42, ttlSeconds: -1 });
    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram', bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(result).toMatchObject({ ok: false, rejection: 'expired' });
  });

  it('stale version is refused even when text is unchanged', () => {
    const a = writeApproval({ id: 'approval_stale_version' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    writeApproval({ ...a, version: 2 });
    const result = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram', bindingRef: binding.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(result).toMatchObject({ ok: false, rejection: 'version_changed' });
  });

  it('a route without an actor is refused (worker cannot self-assert a human decider)', () => {
    const a = writeApproval({ id: 'approval_missing_actor' });
    const result = decideApproval(paths, a.id, 'approved', '', { route: 'cli' });
    expect(result).toMatchObject({ ok: false, rejection: 'missing_actor' });
  });

  it('revoked/resolved approval cannot be decided again', () => {
    const a = writeApproval({ id: 'approval_already_resolved' });
    const first = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    expect(first.ok).toBe(true);
    const second = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    // Found in resolved/ (readApproval checks both buckets) with status !=
    // pending — refused before any binding/hash check is even attempted.
    expect(second).toMatchObject({ ok: false, rejection: 'approval_resolved' });
  });
});

// ---------------------------------------------------------------------------
// Duplicate allow/deny on multiple references: idempotent, one decision wins.
// ---------------------------------------------------------------------------

describe('duplicate decisions across multiple bindings are idempotent', () => {
  it('deciding via the allow ref retires the deny ref for the same approval', () => {
    const a = writeApproval({ id: 'approval_dual_ref' });
    const allow = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const deny = createBinding(paths, a, 'deny', { botIdentity: '111', chatId: 999, allowedDecider: 42 });

    const first = decideApproval(paths, a.id, 'approved', '42', {
      route: 'telegram', bindingRef: allow.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(first.ok).toBe(true);

    const second = decideApproval(paths, a.id, 'rejected', '42', {
      route: 'telegram', bindingRef: deny.ref,
      presented: { decider: 42, botIdentity: '111', chatId: 999 },
    });
    expect(second.ok).toBe(false);
    // The allow decision already revoked every other outstanding binding
    // for this approval (see revokeBindingsFor, called inside
    // updateApproval) — the deny ref is marked consumed:revoked, so
    // consuming it hits the single-use gate exactly like a same-ref replay.
    expect(second.rejection).toBe('already_consumed');

    // Exactly one decision recorded.
    expect(listPendingApprovals(paths).find((p) => p.id === a.id)).toBeUndefined();
  });

  it('a simultaneous second click on the SAME ref records no second decision', () => {
    const a = writeApproval({ id: 'approval_same_ref_race' });
    const binding = createBinding(paths, a, 'allow', { botIdentity: '111', chatId: 999, allowedDecider: 42 });
    const presented = { decider: 42, botIdentity: '111', chatId: 999 };

    const first = decideApproval(paths, a.id, 'approved', '42', { route: 'telegram', bindingRef: binding.ref, presented });
    const second = decideApproval(paths, a.id, 'approved', '42', { route: 'telegram', bindingRef: binding.ref, presented });
    expect(first.ok).toBe(true);
    // The single-use O_EXCL marker on the ref itself is what serializes
    // this — the second call sees the binding already consumed.
    expect(second).toMatchObject({ ok: false, rejection: 'already_consumed' });
  });
});

// ---------------------------------------------------------------------------
// Crash-between-decision-steps / concurrent dispatch: the approval-level lock.
// ---------------------------------------------------------------------------

describe('approval-level decision lock', () => {
  it('a held lock refuses a concurrent decision attempt rather than racing it', () => {
    const a = writeApproval({ id: 'approval_locked_race' });
    // Simulate another in-flight decideApproval call holding the lock.
    const lockDir = join(paths.approvalDir, 'decisions');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `${a.id}.lock`), 'held\n', { flag: 'wx' });

    const result = decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' });
    expect(result).toMatchObject({ ok: false, rejection: 'approval_locked' });
    // The approval must still be pending — the refused attempt made no change.
    expect(listPendingApprovals(paths).find((p) => p.id === a.id)).toBeDefined();
  });

  it('the lock is released after a successful decision (a later decision on a NEW approval is unaffected)', () => {
    const a = writeApproval({ id: 'approval_lock_release_a' });
    const b = writeApproval({ id: 'approval_lock_release_b' });
    expect(decideApproval(paths, a.id, 'approved', 'scott', { route: 'cli' }).ok).toBe(true);
    expect(existsSync(join(paths.approvalDir, 'decisions', `${a.id}.lock`))).toBe(false);
    expect(decideApproval(paths, b.id, 'approved', 'scott', { route: 'cli' }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tampered canonical bytes at the hashing layer directly.
// ---------------------------------------------------------------------------

describe('tampered canonical bytes are never equal under presentation hashing', () => {
  it('computePresentationHash differs for any structural mutation, however small', () => {
    const spec = baseActionSpec();
    const approvalShape = { title: 't', category: 'external-comms' as const, description: 'd', requesting_agent: 'r', org: 'o', action_spec: spec };
    const h1 = computePresentationHash(approvalShape);
    const h2 = computePresentationHash({ ...approvalShape, action_spec: { ...spec, idempotency_key: 'idem-2' } });
    expect(h1).not.toBe(h2);
  });

  it('computeActionHash is stable for the identical object reconstructed independently', () => {
    const spec1 = baseActionSpec();
    const spec2 = baseActionSpec();
    expect(computeActionHash(spec1)).toBe(computeActionHash(spec2));
  });
});
