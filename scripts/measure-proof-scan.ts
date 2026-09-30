/**
 * scripts/measure-proof-scan.ts — R4-5 measurement: how long does one
 * submission-proof scan of a real Claude project dir take?
 *
 * READ-ONLY: it lists, stats and reads *.jsonl files; it writes nothing.
 *
 *   npx tsx scripts/measure-proof-scan.ts [--dir <project dir>] [--iterations 40] [--interval-ms 5000]
 *
 * For each lookback window (an attempt that started 1 min / 10 min / 1 h /
 * 24 h ago — a record awaits proof for at most 24 h) it runs N scans spaced
 * `--interval-ms` apart (default 5 s, the production cadence — so live files
 * really do change between scans) with the parse cache OFF and ON, and prints
 * p50 / p95 / max. The plan's rule: if the no-cache p95 exceeds 250 ms, ship
 * the (dev, ino, size, mtime_ns) cache.
 */
import { homedir } from 'os';
import { join } from 'path';
import { ClaudeTranscriptScanner } from '../src/telegram/submission-proof.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const dir = arg(
  'dir',
  join(homedir(), '.claude', 'projects', '-Users-sascherman-Utopia-Home-Staging-Dropbox-UHS-Collective-uhsJARVIS'),
);
const iterations = Number(arg('iterations', '40'));
const intervalMs = Number(arg('interval-ms', '5000'));

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
}

async function main(): Promise<void> {
  console.log(`dir: ${dir}\niterations: ${iterations} per case, ${intervalMs} ms apart\n`);
  const windows: Array<[string, number]> = [
    ['1 min', 60_000],
    ['10 min', 600_000],
    ['1 h', 3_600_000],
    ['24 h', 86_400_000],
  ];
  for (const [label, back] of windows) {
    for (const cache of [false, true]) {
      const s = new ClaudeTranscriptScanner(dir, { cache });
      const ds: number[] = [];
      let files = 0;
      let read = 0;
      for (let i = 0; i < iterations; i++) {
        const snap = s.scan(Date.now() - back);
        ds.push(snap.durationMs);
        files = snap.filesConsidered;
        read += snap.filesRead;
        if (i < iterations - 1) await new Promise((r) => setTimeout(r, intervalMs));
      }
      console.log(
        `${label.padEnd(6)} cache=${cache ? 'on ' : 'off'} files=${String(files).padStart(3)} ` +
          `reads/scan=${(read / iterations).toFixed(1).padStart(5)}  p50=${pct(ds, 0.5).toFixed(1)}ms ` +
          `p95=${pct(ds, 0.95).toFixed(1)}ms max=${Math.max(...ds).toFixed(1)}ms`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
