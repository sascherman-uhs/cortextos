'use client';

export function AboutFooter() {
  return (
    <p className="px-4 py-2 font-mono text-[11px] leading-4 text-muted-foreground/60">
      build {process.env.NEXT_PUBLIC_BUILD_SHA}
      <br />
      {process.env.NEXT_PUBLIC_BUILD_TIME} · web
    </p>
  );
}
