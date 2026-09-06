// === OS-03 test stub — next/link ===
// Rendering a component to static markup outside a Next request has no router,
// so the tests substitute the anchor next/link produces. Aliased in
// vitest.config.ts; not used by the application.
import * as React from 'react';

export default function Link({
  href, children, ...rest
}: { href: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement('a', { href, ...rest }, children);
}
