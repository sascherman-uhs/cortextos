/**
 * OS-03 — the two widths plan §11 names: a 390px phone and a 1366px laptop.
 *
 * Asserting the layout DECISION rather than a screenshot means the test checks
 * the same rule the browser applies. The phone rule is the one that matters:
 * six columns must never be squeezed onto a phone.
 */

import { describe, it, expect } from 'vitest';
import { boardGridClass, laneListClass, layoutFor, LAPTOP_MIN, PHONE_MAX } from '../layout';

describe('390px phone', () => {
  const l = layoutFor(390);

  it('opens as a readable list, not a board', () => {
    expect(l.presentation).toBe('list');
    expect(l.visibleColumns).toBe(0);
  });

  it('offers a deliberate lane switcher with counts, not six squeezed columns', () => {
    expect(l.laneSwitcher).toBe(true);
    expect(l.swimlanes).toBe(false);
    expect(l.reason).toMatch(/six columns/i);
  });
});

describe('1366px laptop', () => {
  const l = layoutFor(1366);

  it('shows all five columns with swimlanes and the list still available', () => {
    expect(l.presentation).toBe('board');
    expect(l.visibleColumns).toBe(5);
    expect(l.swimlanes).toBe(true);
    expect(l.listViewAvailable).toBe(true);
    expect(l.laneSwitcher).toBe(false);
  });
});

describe('the boundaries themselves', () => {
  it('switches to a board exactly one pixel past the phone maximum', () => {
    expect(layoutFor(PHONE_MAX).presentation).toBe('list');
    expect(layoutFor(PHONE_MAX + 1).presentation).toBe('board');
  });

  it('reaches full five-column layout at the laptop minimum', () => {
    expect(layoutFor(LAPTOP_MIN - 1).visibleColumns).toBe(3);
    expect(layoutFor(LAPTOP_MIN).visibleColumns).toBe(5);
  });
});

describe('the classes the components actually render', () => {
  it('grows the grid from one column to five across the same breakpoints', () => {
    const cls = boardGridClass();
    expect(cls).toContain('grid-cols-1');
    expect(cls).toContain('md:grid-cols-3');
    expect(cls).toContain('xl:grid-cols-5');
  });

  it('makes the phone list the default and hides it above the phone breakpoint', () => {
    expect(laneListClass()).toContain('md:hidden');
  });
});
