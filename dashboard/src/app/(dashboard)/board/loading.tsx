// === OS-03 — board loading state ===
// A loading board is announced, not just greyed out: a silent skeleton reads
// to a screen reader as an empty board.
export default function BoardLoading() {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="board-loading">
      <p role="status" className="text-sm text-muted-foreground">
        Loading the work board…
      </p>
      <div className="grid animate-pulse grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-64 rounded-xl bg-muted/30" />
        ))}
      </div>
    </div>
  );
}
