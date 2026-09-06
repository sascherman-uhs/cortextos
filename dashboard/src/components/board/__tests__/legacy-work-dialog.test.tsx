/**
 * fix5 — what a person actually sees when they click Start on one of the 1,863
 * tasks that predate the work contract.
 *
 * The bug this replaces was a refusal that named a rule ("backlog -> doing is
 * not in the contract") and offered nothing. These tests are about the offer.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegacyWorkDialog, type LegacyPrompt } from '../legacy-work-dialog';

const prompt: LegacyPrompt = {
  taskId: 'supa_7',
  title: 'Renew the Colanthe contract',
  to: 'doing',
  toLabel: 'Doing',
  missing: ['owner', 'acceptance_criteria'],
  waivable: true,
  message: 'This move was refused by the work contract. This task is missing owner and acceptance_criteria.',
  suggestedOutcome: 'Renew the Colanthe contract',
};

const render = (p: LegacyPrompt) =>
  renderToStaticMarkup(
    <LegacyWorkDialog prompt={p} busy={false} onSubmit={() => {}} onCancel={() => {}} />,
  );

describe('the legacy-work dialog', () => {
  const html = render(prompt);

  it('says what is missing in words a person can act on', () => {
    expect(html).toContain('This task predates the work contract');
    expect(html).toContain('who is accountable');
    expect(html).toContain('how anyone will know it worked');
  });

  it('shows the server’s own sentence rather than softening it', () => {
    expect(html).toContain('missing owner and acceptance_criteria');
  });

  it('asks only for the fields that are actually missing', () => {
    expect(html).toContain('data-testid="legacy-owner"');
    expect(html).toContain('data-testid="legacy-criteria"');
    // `outcome` was not in `missing` — the title already serves as it, and
    // asking for it again would be asking a person to retype the task.
    expect(html).not.toContain('data-testid="legacy-outcome"');
  });

  it('leads with filling it in and keeps waiving as the secondary option', () => {
    const supplyAt = html.indexOf('legacy-mode-supply');
    const waiveAt = html.indexOf('legacy-mode-waive');
    expect(supplyAt).toBeGreaterThan(-1);
    expect(waiveAt).toBeGreaterThan(supplyAt);
  });

  it('never pre-fills acceptance criteria with something plausible', () => {
    // Invented criteria would pass the Ready gate and then be ticked off at
    // completion, which is how a proof gate becomes a formality.
    expect(html).toMatch(/data-testid="legacy-criteria"[^>]*>\s*<\/textarea>/);
  });

  it('offers no waiver at all when the server said these gaps are not waivable', () => {
    const strict = render({ ...prompt, waivable: false });
    expect(strict).not.toContain('legacy-mode-waive');
  });

  it('says plainly that a waiver is recorded against the person', () => {
    const waiveHtml = render(prompt);
    expect(waiveHtml).toContain('stops being legacy work');
  });

  it('offers leaving the task alone as a first-class choice', () => {
    expect(html).toContain('Leave it where it is');
  });
});
