// === OS-03 — layout decisions, as data ===
//
// New file; never overwritten by upstream merges.
//
// The plan is explicit that six columns must not be squeezed onto a phone
// (§3) and that 390px and 1366px are both tested widths (§11). Making the
// decision a pure function of width means the test asserts the same rule the
// browser applies, instead of a screenshot asserting nothing.
// === END header ===

export type BoardPresentation = 'list' | 'board';

export interface LayoutDecision {
  presentation: BoardPresentation;
  /** How many board columns are visible side by side. */
  visibleColumns: number;
  /** Phone: one lane at a time, chosen deliberately by the reader. */
  laneSwitcher: boolean;
  /** Desktop: the board and the list are both available. */
  listViewAvailable: boolean;
  /** Desktop: swimlanes grouped by project. */
  swimlanes: boolean;
  /** Reason, so a surprising layout is explainable rather than mysterious. */
  reason: string;
}

/** Tailwind's md/xl breakpoints, named once. */
export const PHONE_MAX = 767;
export const LAPTOP_MIN = 1280;

export function layoutFor(width: number): LayoutDecision {
  if (width <= PHONE_MAX) {
    return {
      presentation: 'list',
      visibleColumns: 0,
      laneSwitcher: true,
      listViewAvailable: true,
      swimlanes: false,
      reason:
        'At phone width the board opens as a readable list with lane counts and a lane switcher. Six columns at this width are unreadable, so they are not offered.',
    };
  }
  if (width < LAPTOP_MIN) {
    return {
      presentation: 'board',
      visibleColumns: 3,
      laneSwitcher: false,
      listViewAvailable: true,
      swimlanes: false,
      reason:
        'At tablet width the board shows three columns at a time and scrolls horizontally inside its own container.',
    };
  }
  return {
    presentation: 'board',
    visibleColumns: 5,
    laneSwitcher: false,
    listViewAvailable: true,
    swimlanes: true,
    reason:
      'At laptop width and above all five columns fit, with the Waiting lane beside them, project swimlanes and keyboard search.',
  };
}

/**
 * Grid classes for the board container. Kept here rather than inline so the
 * layout test asserts the exact classes the component renders.
 */
export function boardGridClass(): string {
  return 'grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5';
}

/** The phone list is the DEFAULT, not a fallback: it is what renders when no
 *  width-dependent class applies. */
export function laneListClass(): string {
  return 'flex flex-col gap-2 md:hidden';
}
