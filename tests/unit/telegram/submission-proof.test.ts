/**
 * V5-1 / R4-1 / R4-5 — submission proof from Claude Code's own session record.
 *
 * Fixtures are RECORDED (tests/fixtures/telegram/claude-session-entries.
 * recorded-2026-09-30.json — real JSONL entries, long bodies truncated). The
 * real entries predate the `⟦u:<id>⟧` token, so where a test needs a token in a
 * recorded prompt it is inserted into the recorded header line exactly where
 * the new formatter emits it — every provenance field stays as recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, truncateSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ClaudeTranscriptScanner,
  bootMarkerFromPrompt,
  bootTurnEnded,
  classifyEntry,
  claudeProjectDirFor,
  findSubmission,
  normalizePtyText,
  parseTranscriptBuffer,
  telegramToken,
} from '../../../src/telegram/submission-proof';
import { sanitizeForPtyInjection } from '../../../src/utils/validate';

const FIX = join(__dirname, '..', '..', 'fixtures', 'telegram');
const recorded = JSON.parse(readFileSync(join(FIX, 'claude-session-entries.recorded-2026-09-30.json'), 'utf-8')).entries as Record<string, any>;
const E = (k: string) => JSON.parse(JSON.stringify(recorded[k]));
const line = (o: unknown) => JSON.stringify(o) + '\n';

const ID = 462809160;
const TOKEN = telegramToken(ID);
const PHOTO_HEADER = '=== TELEGRAM PHOTO from Scott (chat_id:8727328514) ===';

/** Recorded line 98 (the genuine 12:47:12Z prompt) with the token where the new formatter puts it. */
function genuineWithToken(): any {
  const e = E('genuine_prompt_photo_b64c01d7_line98');
  expect(e.message.content).toContain(PHOTO_HEADER);
  e.message.content = e.message.content.replace(PHOTO_HEADER, `=== TELEGRAM PHOTO from Scott ${TOKEN} (chat_id:8727328514) ===`);
  return e;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zztest-proof-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the token', () => {
  it('is unique per update and survives sanitizeForPtyInjection', () => {
    expect(TOKEN).toBe('\u27E6u:462809160\u27E7');
    expect(telegramToken(462809161)).not.toBe(TOKEN);
    expect(sanitizeForPtyInjection(`x ${TOKEN} y`)).toContain(TOKEN);
  });
});

describe('R4-1 provenance on RECORDED entries', () => {
  it('line 98 (12:47:12Z) is a genuine submitted prompt', () => {
    const c = classifyEntry(E('genuine_prompt_photo_b64c01d7_line98'));
    expect(c).toMatchObject({ kind: 'prompt', genuine: true, uuid: '095a4402-f12e-450a-9033-b06f42fd179f' });
  });

  it('lines 84 and 89 (tool results) and 123 (compaction summary) prove nothing', () => {
    expect(classifyEntry(E('tool_result_b64c01d7_line84'))).toBeNull();
    expect(classifyEntry(E('tool_result_b64c01d7_line89'))).toBeNull();
    expect(classifyEntry(E('compact_summary_b64c01d7_line123'))).toBeNull();
  });

  it('a task notification (origin task-notification) is not a human prompt', () => {
    expect(classifyEntry(E('task_notification_user_b7476096'))).toBeNull();
  });

  it('sidechain / meta / missing provenance fields => not proof (never guess)', () => {
    for (const mutate of [
      (e: any) => { e.isSidechain = true; },
      (e: any) => { e.isMeta = true; },
      (e: any) => { e.isCompactSummary = true; },
      (e: any) => { e.isVisibleInTranscriptOnly = true; },
      (e: any) => { delete e.origin; },
      (e: any) => { delete e.turnOrigin; },
      (e: any) => { delete e.promptSource; },
      (e: any) => { e.toolUseResult = {}; },
      (e: any) => { e.sourceToolAssistantUUID = 'x'; },
      (e: any) => { e.message.content = [{ type: 'tool_result', content: TOKEN }]; },
    ]) {
      const e = genuineWithToken();
      mutate(e);
      expect(classifyEntry(e)).toBeNull();
    }
  });

  it('a queued_command attachment (mid-turn submission) with human origin is consumption', () => {
    const c = classifyEntry(E('queued_command_telegram_b7476096'));
    expect(c).toMatchObject({ kind: 'queued_command', genuine: true });
    const bad = E('queued_command_telegram_b7476096');
    bad.attachment.origin = { kind: 'task-notification' };
    expect(classifyEntry(bad)).toBeNull();
  });

  it('an enqueue queue-operation is submission evidence only', () => {
    expect(classifyEntry(E('enqueue_telegram_b7476096'))).toMatchObject({ kind: 'enqueue', genuine: false });
  });

  it('turn_duration and stop_hook_summary are turn ends', () => {
    expect(classifyEntry(E('turn_duration_b64c01d7_line96'))).toMatchObject({ kind: 'turn_end' });
    expect(classifyEntry(E('stop_hook_summary_b64c01d7_line95'))).toMatchObject({ kind: 'turn_end' });
  });
});

describe('findSubmission (R4-1 per-attempt filters over a full scan)', () => {
  const started = Date.parse('2026-09-30T12:38:39.527Z'); // attempt 1 of the live incident

  it('token echoed ONLY in a tool_result => not consumed', () => {
    const tr = E('tool_result_b64c01d7_line84');
    tr.message.content[0].content = `deleted ${PHOTO_HEADER.replace('Scott', `Scott ${TOKEN}`)}`;
    tr.timestamp = '2026-09-30T12:40:00.000Z';
    writeFileSync(join(dir, 'b64c01d7.jsonl'), line(tr));
    const s = new ClaudeTranscriptScanner(dir);
    expect(findSubmission(s.scan(started), TOKEN, started)).toBeNull();
  });

  it('a genuine prompt with the token in a DIFFERENT session file => consumed', () => {
    writeFileSync(join(dir, 'aaaa-other-agent.jsonl'), line(E('tool_result_b64c01d7_line89')));
    writeFileSync(join(dir, 'b64c01d7.jsonl'), line(genuineWithToken()));
    const f = findSubmission(new ClaudeTranscriptScanner(dir).scan(started), TOKEN, started);
    expect(f).toMatchObject({ phase: 'consumed', evidence: { kind: 'prompt', uuid: '095a4402-f12e-450a-9033-b06f42fd179f' } });
  });

  it('entries older than attempt_started_at never count (copied / replayed history)', () => {
    // A new file seeded with copied history: the old entry keeps its old timestamp.
    writeFileSync(join(dir, 'new-resumed-session.jsonl'), line(genuineWithToken()));
    const after = Date.parse('2026-09-30T12:50:00.000Z');
    expect(findSubmission(new ClaudeTranscriptScanner(dir).scan(after), TOKEN, after)).toBeNull();
  });

  it('a uuid this record already counted does not count again', () => {
    writeFileSync(join(dir, 's.jsonl'), line(genuineWithToken()));
    const snap = new ClaudeTranscriptScanner(dir).scan(started);
    expect(findSubmission(snap, TOKEN, started, ['095a4402-f12e-450a-9033-b06f42fd179f'])).toBeNull();
  });

  it('a partial trailing line is ignored until it is complete', () => {
    const full = line(genuineWithToken());
    writeFileSync(join(dir, 's.jsonl'), full.slice(0, full.length - 40));
    const s = new ClaudeTranscriptScanner(dir);
    expect(findSubmission(s.scan(started), TOKEN, started)).toBeNull();
    appendFileSync(join(dir, 's.jsonl'), full.slice(full.length - 40));
    expect(findSubmission(s.scan(started), TOKEN, started)?.phase).toBe('consumed');
  });

  it('enqueue alone => submitted; a later queued_command/prompt => consumed (wins)', () => {
    const tok = telegramToken(777);
    const enq = E('enqueue_telegram_b7476096');
    enq.content = enq.content.replace('(chat_id:8727328514)', `${tok} (chat_id:8727328514)`);
    // The paste (attempt start) precedes both entries; in the recording the
    // attachment is stamped 2 ms BEFORE its enqueue row.
    const t0 = Date.parse(enq.timestamp) - 1_000;
    writeFileSync(join(dir, 's.jsonl'), line(enq));
    const s = new ClaudeTranscriptScanner(dir);
    expect(findSubmission(s.scan(t0), tok, t0)?.phase).toBe('submitted');
    const qc = E('queued_command_telegram_b7476096');
    qc.attachment.prompt = qc.attachment.prompt.replace('(chat_id:8727328514)', `${tok} (chat_id:8727328514)`);
    appendFileSync(join(dir, 's.jsonl'), line(qc));
    expect(findSubmission(s.scan(t0), tok, t0)).toMatchObject({ phase: 'consumed', evidence: { kind: 'queued_command' } });
  });

  it('a different update\'s token never proves this one', () => {
    writeFileSync(join(dir, 's.jsonl'), line(genuineWithToken()));
    expect(findSubmission(new ClaudeTranscriptScanner(dir).scan(started), telegramToken(ID + 1), started)).toBeNull();
  });
});

describe('R4-5 full rescans, with and without the parse cache', () => {
  const started = Date.parse('2026-09-30T12:38:39.527Z');

  for (const cache of [false, true]) {
    describe(`cache ${cache ? 'ON' : 'OFF'}`, () => {
      it('same-path replacement (new inode) is re-read', () => {
        const p = join(dir, 's.jsonl');
        writeFileSync(p, line(E('tool_result_b64c01d7_line84')));
        const s = new ClaudeTranscriptScanner(dir, { cache });
        expect(findSubmission(s.scan(started), TOKEN, started)).toBeNull();
        const tmp = join(dir, 'replacement.tmp');
        writeFileSync(tmp, line(genuineWithToken()));
        renameSync(tmp, p);
        expect(findSubmission(s.scan(started), TOKEN, started)?.phase).toBe('consumed');
      });

      it('truncation is re-read (evidence that is gone is gone)', () => {
        const p = join(dir, 's.jsonl');
        writeFileSync(p, line(genuineWithToken()));
        const s = new ClaudeTranscriptScanner(dir, { cache });
        expect(findSubmission(s.scan(started), TOKEN, started)?.phase).toBe('consumed');
        truncateSync(p, 0);
        expect(findSubmission(s.scan(started), TOKEN, started)).toBeNull();
      });

      it('same-inode truncate-and-regrow: a genuine submission BEFORE the old length, tail preserved => counted', async () => {
        const p = join(dir, 's.jsonl');
        const tail = line(E('turn_duration_b64c01d7_line96'));
        const filler = line(E('tool_result_b64c01d7_line84')) + line(E('tool_result_b64c01d7_line89'));
        writeFileSync(p, filler + filler + filler + tail);
        const ino = statSync(p).ino;
        const s = new ClaudeTranscriptScanner(dir, { cache });
        expect(findSubmission(s.scan(started), TOKEN, started)).toBeNull();
        const oldLen = statSync(p).size;
        await new Promise((r) => setTimeout(r, 15)); // let mtime move
        // Same inode: truncate, then write the genuine prompt first and the old tail after it.
        truncateSync(p, 0);
        appendFileSync(p, line(genuineWithToken()) + tail);
        expect(statSync(p).ino).toBe(ino);
        const gp = line(genuineWithToken()).length;
        expect(gp).toBeLessThan(oldLen); // the submission sits BEFORE the old length — a byte cursor would have skipped it
        expect(findSubmission(s.scan(started), TOKEN, started)?.phase).toBe('consumed');
      });
    });
  }

  it('files older than the window are not read at all', () => {
    const p = join(dir, 'old.jsonl');
    writeFileSync(p, line(genuineWithToken()));
    const s = new ClaudeTranscriptScanner(dir);
    const snap = s.scan(Date.now() + 60_000);
    expect(snap.filesConsidered).toBe(0);
  });

  it('the cache reuses an unchanged file without re-reading it', () => {
    writeFileSync(join(dir, 's.jsonl'), line(genuineWithToken()));
    const s = new ClaudeTranscriptScanner(dir, { cache: true });
    expect(s.scan(started).filesRead).toBe(1);
    expect(s.scan(started).filesRead).toBe(0);
    const off = new ClaudeTranscriptScanner(dir, { cache: false });
    off.scan(started);
    expect(off.scan(started).filesRead).toBe(1);
  });
});

describe('R4-4 boot readiness from the session record', () => {
  const bootText = E('boot_prompt_b64c01d7_line8').message.content as string;
  const marker = bootMarkerFromPrompt(bootText)!;

  it('the recorded boot prompt carries a unique marker', () => {
    expect(marker).toBe('Current UTC time: 2026-09-30T12:36:53.749Z');
  });

  it('boot prompt then a turn end (recorded lines 8 → 96) => ready', () => {
    writeFileSync(join(dir, 's.jsonl'), line(E('boot_prompt_b64c01d7_line8')) + line(E('tool_result_b64c01d7_line84')) + line(E('turn_duration_b64c01d7_line96')));
    const r = bootTurnEnded(new ClaudeTranscriptScanner(dir).scan(0), marker);
    expect(r.ready).toBe(true);
    expect(new Date(r.turnEndTs!).toISOString()).toBe('2026-09-30T12:38:21.469Z');
  });

  it('boot prompt without a turn end yet => held', () => {
    writeFileSync(join(dir, 's.jsonl'), line(E('boot_prompt_b64c01d7_line8')) + line(E('tool_result_b64c01d7_line84')));
    expect(bootTurnEnded(new ClaudeTranscriptScanner(dir).scan(0), marker)).toMatchObject({ ready: false });
  });

  it('a previous generation\'s boot + turn end never releases this generation', () => {
    writeFileSync(join(dir, 's.jsonl'), line(E('boot_prompt_b64c01d7_line8')) + line(E('turn_duration_b64c01d7_line96')));
    expect(bootTurnEnded(new ClaudeTranscriptScanner(dir).scan(0), 'Current UTC time: 2026-09-30T13:00:00.000Z').ready).toBe(false);
  });

  it('a turn end BEFORE the boot prompt does not count', () => {
    const early = E('turn_duration_b64c01d7_line96');
    early.timestamp = '2026-09-30T12:36:00.000Z';
    writeFileSync(join(dir, 's.jsonl'), line(early) + line(E('boot_prompt_b64c01d7_line8')));
    expect(bootTurnEnded(new ClaudeTranscriptScanner(dir).scan(0), marker).ready).toBe(false);
  });
});

describe('PTY text is a hint only (A1 normalization)', () => {
  it('the recorded 05:38 frames show a COLLAPSED paste: neither the header nor any token is in the PTY output', () => {
    const raw = readFileSync(join(FIX, 'stdout-collapsed-paste-462809160.recorded-2026-09-30.txt')).toString('utf-8');
    const n = normalizePtyText(raw);
    expect(n).toContain('[Pastedtext#1+9lines]');
    expect(n).not.toContain(normalizePtyText(PHOTO_HEADER));
    expect(n).not.toContain(normalizePtyText(TOKEN));
  });

  it('matches a token split by ANSI sequences, cursor moves and wrapping', () => {
    const rendered = `\x1b]0;title\x07❯ === TELEGRAM\x1b[1Cfrom \x1b[38;5;12m⟦u:4628\x1b[0m\r\n09160⟧ (chat_id:1)`;
    expect(normalizePtyText(rendered)).toContain(normalizePtyText(TOKEN));
  });
});

describe('parseTranscriptBuffer', () => {
  it('only keeps prompts carrying a token or a boot marker, but counts every genuine prompt', () => {
    const plain = genuineWithToken();
    plain.message.content = 'hello';
    plain.uuid = 'u-plain';
    const buf = Buffer.from(line(plain) + line(genuineWithToken()));
    const p = parseTranscriptBuffer(buf, 'f');
    expect(p.genuineCount).toBe(2);
    expect(p.evidence.map((e) => e.uuid)).toEqual(['095a4402-f12e-450a-9033-b06f42fd179f']);
  });
});

describe('claudeProjectDirFor', () => {
  it('slugs the real uhsJARVIS cwd to the real project dir name', () => {
    expect(claudeProjectDirFor('/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS', '/p')).toBe(
      '/p/-Users-sascherman-Utopia-Home-Staging-Dropbox-UHS-Collective-uhsJARVIS',
    );
  });
});
