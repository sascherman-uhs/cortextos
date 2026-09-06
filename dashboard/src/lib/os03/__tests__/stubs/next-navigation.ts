// Test stub for `next/navigation`.
//
// The work board calls useRouter().refresh() when the server refuses a move as
// a conflict — the board is out of date and must be re-read. `useRouter` reads
// the App Router context and throws outside a mounted router, which would break
// every static-markup render test. This stub gives the render a no-op router so
// the tests keep exercising the component the app actually ships.

export function useRouter() {
  return {
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

export function usePathname() {
  return '/';
}

export function useSearchParams() {
  return new URLSearchParams();
}
