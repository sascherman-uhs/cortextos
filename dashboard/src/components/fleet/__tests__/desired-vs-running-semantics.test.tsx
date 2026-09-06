/**
 * fix9 / item 1 — two rows with the same visible shape must not carry opposite
 * labels with nothing on screen explaining why.
 *
 * Observed live, both rows real:
 *   jarvis-inventory   sonnet → haiku    badged "verified"
 *   trillion-coder     codex  → gpt-5.5  badged "mismatch"
 *
 * Both badges were CORRECT. The badge is computed against `expected_model_id`,
 * which in shadow activation is the agent's legacy config model — what genuinely
 * runs — not the resolved model. So haiku running where haiku is expected is
 * verified, and gpt-5.5 running where nothing asked for gpt-5.5 is a mismatch.
 * The defect was that the badge sat beside a resolved→running arrow and read as
 * a verdict on THAT comparison.
 *
 * These tests pin the fix: three separately-stated facts per row, each naming
 * its own baseline, so the shadow row does not look like an error and the
 * trillion-coder row still stands out as the real problem.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeActivationBanner, describeDesiredVsRunning } from '../model-routing-view';
import { ResolvedRouteCell, RunningModelCell } from '../routing-badges';
import type { Resolution } from '@/lib/model-routing';

/** jarvis-inventory after its legacy pin was cleared: shadow, running the model
 *  its own config names, while the registry proposes a different one. */
const inventory: Resolution = {
  registry_revision: 105,
  activation: 'shadow',
  requested: { source: 'role', tier: 'standard' },
  candidates: ['sonnet'],
  selected: {
    entry_id: 'sonnet',
    model_id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    runtime_adapter: 'claude-code',
    billing_mode: 'subscription_quota',
    cost_class: 3,
  },
  validation: { ok: true, errors: [], warnings: [] },
  legacy_effective: { model_id: 'claude-haiku-4-5-20251001' },
  expected_model_id: 'claude-haiku-4-5-20251001',
  observed: {
    model_id: 'claude-haiku-4-5-20251001',
    source: 'claude-transcript',
    confidence: 'verified',
    binding: 'session-id',
  },
};

/** trillion-coder: the Codex runtime is running a model nobody configured. */
const trillion: Resolution = {
  registry_revision: 105,
  activation: 'shadow',
  requested: { source: 'pin', entry_id: 'codex' },
  candidates: ['codex'],
  selected: {
    entry_id: 'codex',
    model_id: 'gpt-5-codex',
    provider: 'openai',
    runtime_adapter: 'codex',
    billing_mode: 'subscription_quota',
    cost_class: 2,
  },
  validation: { ok: true, errors: [], warnings: [] },
  legacy_effective: { model_id: 'gpt-5-codex' },
  expected_model_id: 'gpt-5-codex',
  observed: {
    model_id: 'gpt-5.5',
    source: 'codex-transcript',
    confidence: 'verified',
    binding: 'session-id',
  },
};

describe('the jarvis-inventory shape — shadow divergence is the intended state', () => {
  const d = describeDesiredVsRunning(inventory);

  it('states all three facts separately', () => {
    expect(d.resolved).toBe('claude-sonnet-4-6');
    expect(d.running).toBe('claude-haiku-4-5-20251001');
    expect(d.expected).toBe('claude-haiku-4-5-20251001');
  });

  it('names the baseline the verdict is measured against', () => {
    expect(d.expectedFrom).toBe('agent-config');
    expect(d.expectedFromLabel).toBe("this agent's own config");
  });

  it('says the resolved route is not applied rather than implying it runs', () => {
    expect(d.resolvedApplied).toBe(false);
    expect(d.resolvedNote).toBe('not applied in shadow');
    expect(d.shadowDivergence).toBe(true);
  });

  it('reads as a healthy row, not an error', () => {
    expect(d.expectationLabel).toBe('running as expected');
    expect(d.tone).toBe('success');
    expect(d.drift).toBe(false);
  });

  it('renders the divergence visibly, without dressing it as a fault', () => {
    const html =
      renderToStaticMarkup(<ResolvedRouteCell resolution={inventory} />) +
      renderToStaticMarkup(<RunningModelCell resolution={inventory} />);
    expect(html).toContain('claude-sonnet-4-6');
    expect(html).toContain('not applied in shadow');
    expect(html).toContain('claude-haiku-4-5-20251001');
    expect(html).toContain('running as expected');
    expect(html).toContain("from this agent&#x27;s own config");
    expect(html).not.toContain('mismatch');
  });
});

describe('the trillion-coder shape — a model nobody configured', () => {
  const d = describeDesiredVsRunning(trillion);

  it('still reads as the real problem it is', () => {
    expect(d.expectationLabel).toBe('not the expected model');
    expect(d.tone).toBe('error');
    expect(d.drift).toBe(true);
    expect(d.confidence).toBe('mismatch');
  });

  it('names what was expected, from where, and what to do', () => {
    expect(d.expected).toBe('gpt-5-codex');
    expect(d.expectedFrom).toBe('agent-config');
    expect(d.hint).toContain('gpt-5.5 is running');
    expect(d.hint).toContain('Nothing configured asks for gpt-5.5');
    expect(d.hint).toContain('investigate its runtime adapter');
  });

  it('is not confused with the shadow-divergence row', () => {
    expect(d.shadowDivergence).toBe(false);
    expect(describeDesiredVsRunning(inventory).expectationLabel).not.toBe(d.expectationLabel);
  });

  it('renders the running model beside an explicit not-expected verdict', () => {
    const html = renderToStaticMarkup(<RunningModelCell resolution={trillion} />);
    expect(html).toContain('gpt-5.5');
    expect(html).toContain('not the expected model');
    expect(html).toContain('expected gpt-5-codex');
  });
});

describe('enforced activation', () => {
  const enforced: Resolution = {
    ...inventory,
    activation: 'enforced',
    expected_model_id: 'claude-sonnet-4-6',
    observed: { model_id: 'claude-sonnet-4-6', source: 'claude-transcript', confidence: 'verified' },
  };

  it('measures the verdict against the registry route, and says so', () => {
    const d = describeDesiredVsRunning(enforced);
    expect(d.expectedFrom).toBe('registry');
    expect(d.expectedFromLabel).toBe('the registry route');
    expect(d.resolvedApplied).toBe(true);
    expect(d.resolvedNote).toBeNull();
    expect(d.shadowDivergence).toBe(false);
  });
});

describe('the activation explanation above the table', () => {
  it('explains shadow without assuming the reader knows the word', () => {
    const b = describeActivationBanner([inventory, trillion]);
    expect(b.mode).toBe('shadow');
    expect(b.text).toContain('does not change what runs');
    expect(b.text).toContain('is expected here');
  });

  it('says the resolved model is the expected one when routing is enforced', () => {
    const b = describeActivationBanner([{ ...inventory, activation: 'enforced' }]);
    expect(b.mode).toBe('enforced');
    expect(b.text).toContain('passed to the runtime');
  });

  it('does not claim one mode when the rows disagree', () => {
    const b = describeActivationBanner([inventory, { ...trillion, activation: 'enforced' }]);
    expect(b.mode).toBe('mixed');
    expect(b.text).toContain('MIX of activation modes');
  });

  it('degrades to shadow when no row has loaded yet', () => {
    expect(describeActivationBanner([null, undefined]).mode).toBe('shadow');
  });
});
