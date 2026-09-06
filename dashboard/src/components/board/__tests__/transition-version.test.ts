/**
 * Fix6 / defect D2 (L1) — no client may post a task transition without the
 * version it rendered.
 *
 * Measured before this test existed: the work board posted `{"to":"ready"}`
 * with no `expectedVersion`. The record had moved from version 1 to version 6
 * underneath the open board; the move still applied, the record became version
 * 7, and the concurrent change was silently overwritten with no conflict shown.
 * The server had implemented optimistic concurrency correctly the whole time —
 * only the client never sent the field.
 *
 * This test reads the shipped client sources rather than mocking a call, so it
 * fails if ANY call site — existing or newly added — writes a task status
 * without the version. A guard that only covers today's call sites would not
 * have caught the one that was actually broken.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !full.includes('.pre-mod')) {
      // Server routes are the enforcer, not a caller; they legitimately read
      // expectedVersion off the request instead of sending one.
      if (full.includes(`${path.sep}app${path.sep}api${path.sep}`)) continue;
      out.push(full);
    }
  }
  return out;
}

/** The fetch call expression starting at `from`, balanced on parentheses. */
function callAt(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

const files = walk(SRC);

describe('every client write to a task carries the version it rendered', () => {
  it('finds the call sites at all (the scan itself is not silently empty)', () => {
    const withCalls = files.filter((f) => /fetch\(`\/api\/tasks\//.test(fs.readFileSync(f, 'utf-8')));
    expect(withCalls.length).toBeGreaterThan(0);
  });

  it('sends expectedVersion on every transition and status/field write', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8');
      const re = /fetch\(`\/api\/tasks\//g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const call = callAt(text, m.index + 'fetch'.length);
        const isTransition = call.includes('/transition');
        const isWrite = /method:\s*'(PATCH|PUT)'/.test(call);
        // A GET or a DELETE is not a versioned write.
        if (!isTransition && !isWrite) continue;
        // The routing rail writes only assigned_to, which the transition
        // contract does not version; every status/field write must carry it.
        if (!isTransition && !/status:|title:|description:|priority:/.test(call)) continue;
        if (!call.includes('expectedVersion')) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
