'use client';

// === OS-03 — board error state ===
// An unreadable board is never an empty board. This says which it is.
export default function BoardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive bg-destructive/10 p-4">
      <h1 className="text-base font-semibold">The work board could not be loaded</h1>
      <p className="text-sm">
        Nothing on this page is a picture of your work right now — this is a failure to
        read, not an empty board.
      </p>
      <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
      <button type="button" onClick={reset} className="text-sm underline underline-offset-2">
        Try again
      </button>
    </div>
  );
}
