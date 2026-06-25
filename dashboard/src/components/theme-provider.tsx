'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

// next-themes (0.4.6, unmaintained since Mar 2025) injects its anti-FOUC blocker
// via React.createElement('script', ...). React 19.2 added a dev-only warning for
// <script> tags seen during a *client* render — but the script ran correctly during
// SSR, so the warning is a false positive. It never appears in production builds.
// Silence only that exact message in development; everything else passes through.
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  const w = window as typeof window & { __nextThemesScriptWarnPatched?: boolean };
  if (!w.__nextThemesScriptWarnPatched) {
    w.__nextThemesScriptWarnPatched = true;
    const original = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('Encountered a script tag while rendering React component')) {
        return;
      }
      original(...args);
    };
  }
}

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
