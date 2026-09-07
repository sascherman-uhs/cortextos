// === JARVIS MOD #106 — unit lock for the knowledge lanes ====================
// Live behavior is covered by the probe smoke (see LOCAL_MODS #106). These lock
// the decision logic that nothing else can catch: which words a SPOKEN question
// actually searches on, which passage of a note gets read back, and how a
// work-list task is matched and reported. Each encodes a failure the critics
// found on 2026-08-08: a 34.7-second ask_jarvis round trip to read a markdown
// file, and a vault search that could see 38 of 418 files.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bestPassage,
  noteTitle,
  normalizeSpokenNumbers,
  rgArgsFor,
  scoreTask,
  searchTerms,
  spokenDate,
  spokenTitle,
  termHitsIn,
  termStem,
} from '../fast-lanes';
import { isDeniedDir, listAllNotes, listVaultTopDirs, resolveVaultPath } from '../../vault';

/** Terms are objects now (pattern + match mode); most assertions want the text. */
const patterns = (q: string) => searchTerms(q).map((t) => t.pattern);
const term = (pattern: string, mode: 'fixed' | 'word' | 'regex' = 'fixed') => ({ pattern, mode });

describe('searchTerms — a spoken question is not a search query', () => {
  it('keeps the section number, which IS the question', () => {
    expect(patterns('what does section 7.2 of the staging contract say')).toContain('7.2');
  });
  it('drops stopwords and filler verbs', () => {
    const p = patterns('what does section 7.2 of the staging contract say');
    expect(p).not.toContain('what');
    expect(p).not.toContain('does');
    expect(p).not.toContain('say');
    expect(p).toContain('contract');
    expect(p).toContain('stag'); // stemmed: "staging" must also find "stage"
  });
  it('keeps numeric tokens and short content words, drops short function words', () => {
    const p = patterns('is the 10 day notice in the contract');
    expect(p).toContain('10');
    expect(p).toContain('day'); // MOD #106b: three-letter CONTENT words survive
    expect(p).not.toContain('the');
  });
  it('caps the fan-out so one rambling sentence is not twenty processes', () => {
    const long = 'remind me about pricing policy contracts inventory scheduling vendors invoices reports';
    expect(searchTerms(long).length).toBeLessThanOrEqual(6);
  });
  it('deduplicates repeated words', () => {
    expect(patterns('contract contract contract policy').filter((t) => t === 'contract')).toHaveLength(1);
  });
  it('an all-stopword question yields no terms rather than matching everything', () => {
    expect(searchTerms('what does that say')).toEqual([]);
  });
  it('short content words match as WHOLE words, never as substrings', () => {
    // The live failure: "pet policy" found §3.7 because "pet" is inside
    // "competitor" and "carpet". The contract has no pet clause at all.
    const pet = searchTerms('pet policy in the staging contract').find((t) => t.pattern === 'pet');
    expect(pet?.mode).toBe('word');
    expect(termHitsIn('the carpet and the competitor', term('pet', 'word'))).toBe(false);
    expect(termHitsIn('no pet is permitted', term('pet', 'word'))).toBe(true);
  });
  it('long words are stemmed so "price" finds "pricing"', () => {
    expect(termStem('pricing')).toBe('pric');
    expect(patterns('minimum price for a vacant staging')).toContain('pric');
    // Separators must be normalised to spaces first — "_" is a word character,
    // so a word-start stem never matches inside "reference_uhs_pricing…".
    expect(termHitsIn('reference uhs pricing figures md', term('pric'))).toBe(true);
    expect(termHitsIn('the reprice adjustment', term('pric'))).toBe(false);
  });
  it('numbers tolerate the thousands comma', () => {
    // "2500" must find "$2,500" — the canonical pricing file writes the comma,
    // and without this the term looked absent and forced a decline.
    expect(termHitsIn('Minimum staging investment: $2,500 vacant', term('2500', 'regex'))).toBe(true);
    expect(rgArgsFor(term('2500', 'regex')).join(' ')).toContain('2,?500');
  });
});

describe('normalizeSpokenNumbers — the voice model speaks numbers as words', () => {
  it('turns a spoken section number into digits', () => {
    expect(normalizeSpokenNumbers('what does section seven point two say')).toContain('7.2');
  });
  it('turns "section seven" into "section 7"', () => {
    expect(normalizeSpokenNumbers('read me section seven')).toContain('section 7');
  });
  it('turns a bare number word into digits', () => {
    expect(normalizeSpokenNumbers('the ten day notice')).toContain('10 day');
  });
  it('leaves ordinary words alone', () => {
    expect(normalizeSpokenNumbers('the paint policy')).toBe('the paint policy');
  });
  it('the spoken and written phrasings produce the same search term', () => {
    expect(patterns('what does section seven point two say')).toContain('7.2');
    expect(patterns('what does section 7.2 say')).toContain('7.2');
  });
});

describe('bestPassage — a heading alone answers nothing', () => {
  const contract = [
    '# UHS Standard Home Staging Service Agreement',
    '',
    '### 7.1 Pre Installation Cancellation',
    'Deposits are non-refundable.',
    '',
    '### 7.2 Post Installation Notice to Terminate',
    '',
    '**Minimum 10 paid calendar days** advance written notice required after installation.',
    'Staging fees continue through the agreed de-stage date.',
  ].join('\n');

  it('anchors on the matching heading and carries the clause under it', () => {
    const p = bestPassage(contract, [term('7.2', 'regex'), term('contract'), term('stag')]);
    expect(p).toContain('7.2 Post Installation Notice to Terminate');
    expect(p).toContain('10 paid calendar days');
  });
  it('does not anchor on the neighbouring section', () => {
    expect(bestPassage(contract, [term('7.2', 'regex')])).not.toContain('non-refundable');
  });
  it('a matching HEADING beats a body line that merely has more words', () => {
    // Live failure 2026-08-09: "how many days notice to terminate a staging
    // contract" anchored on §2.1 Automatic Renewal — "thirty (30) days" — and
    // a model reading that passage answers thirty for a ten-day requirement.
    const doc = [
      '### 2.1 Automatic Renewal',
      'This staging contract renews monthly unless thirty (30) days written notice is given.',
      '',
      '### 7.2 Post Installation Notice to Terminate',
      'Minimum 10 paid calendar days advance written notice required.',
    ].join('\n');
    const p = bestPassage(doc, [term('notic'), term('terminat'), term('contract'), term('day', 'word')]);
    expect(p).toContain('7.2 Post Installation Notice to Terminate');
    expect(p).toContain('10 paid calendar days');
    expect(p).not.toContain('thirty');
  });
  it('a numbered term does not match its own subsections', () => {
    // Live failure 2026-08-09: "7.2" matched "7.2.2 De-Staging", and because
    // "de-staging" also contains "staging" the subsection outscored the real
    // clause — the lane answered the overtime charge when asked about notice.
    const withSub = [
      '### 7.2 Post Installation Notice to Terminate',
      'Minimum 10 paid calendar days notice.',
      '',
      '#### 7.2.2 De-Staging / Removal Scheduling',
      'Removal outside standard hours is a $700 Overtime Charge.',
    ].join('\n');
    const p = bestPassage(withSub, [term('stag'), term('7.2', 'regex')]);
    expect(p).toContain('10 paid calendar days');
    expect(p.indexOf('Post Installation')).toBeLessThan(p.indexOf('Overtime'));
  });
  it('strips markdown so nothing is spoken as punctuation', () => {
    const p = bestPassage(contract, [term('7.2', 'regex')]);
    expect(p).not.toContain('**');
    expect(p).not.toContain('###');
  });
  it('falls back to the first real line when no term matches', () => {
    expect(bestPassage(contract, [term('zzz')])).toContain('UHS Standard Home Staging');
  });
  it('never quotes YAML frontmatter at the voice model', () => {
    const memoryFile = [
      '---',
      'name: reference-staging-pricing-quickref',
      'description: UHS staging pricing quick-reference',
      'metadata:',
      '  originSessionId: fefb0625-aa63-4bdd-afa7-328e7eaebd7e',
      '---',
      '',
      'Minimum staging investment: $2,500 for vacant properties.',
    ].join('\n');
    const p = bestPassage(memoryFile, [term('pric'), term('vacant')]);
    expect(p).toContain('$2,500');
    expect(p).not.toContain('originSessionId');
    expect(p).not.toContain('name:');
  });
  it('truncates rather than handing the voice a whole document', () => {
    const long = `# T\n${'word '.repeat(500)}`;
    expect(bestPassage(long, [term('word')]).length).toBeLessThanOrEqual(421);
  });
});

describe('spokenDate — the year is only silent when it is this one', () => {
  const thisYear = new Date().getFullYear();
  it('omits the year for a date in the current year', () => {
    expect(spokenDate(`${thisYear}-09-12`)).toBe('September 12');
  });
  it('says the year for anything else', () => {
    // Live failure: a 2021 project spoken as "removed November 13 and paid
    // through October 8" sounds like a live contract with contradictory dates.
    expect(spokenDate('2021-11-13')).toBe('November 13, 2021');
  });
  it('still anchors bare dates at local noon (no off-by-one)', () => {
    expect(spokenDate(`${thisYear}-07-21`)).toBe('July 21');
  });
});

describe('spokenTitle — calendar titles are written for a screen', () => {
  it('unslugs a hyphenated blog title', () => {
    expect(spokenTitle('Blog Scheduled — Week-32-Great-Listing-Photos')).toBe(
      'Blog Scheduled Week 32 Great Listing Photos',
    );
  });
  it('drops the room-count code and keeps the address', () => {
    expect(spokenTitle('TS (III/—) - Turtle Head Peak Dr 2837, Ross A Fabrizio')).toBe(
      'TS, Turtle Head Peak Dr 2837, Ross A Fabrizio',
    );
  });
  it('drops a short parenthetical aside', () => {
    expect(spokenTitle('Blog (final edits applied)')).toBe('Blog');
  });
  it('still strips emoji and pipe separators', () => {
    expect(spokenTitle('✅ CS - Boca Raton | Kim')).toBe('CS, Boca Raton, Kim');
  });
  it('never returns an empty string', () => {
    expect(spokenTitle('   ')).toBe('Untitled');
  });
});

describe('noteTitle — spoken, never a filename', () => {
  it('prefers the H1', () => {
    expect(noteTitle('/x/feedback_paint_policy.md', '# Paint Policy\n\nbody')).toBe('Paint Policy');
  });
  it('de-slugifies the filename when there is no H1', () => {
    expect(noteTitle('/x/feedback_paint_policy.md', 'no heading here')).toBe('paint policy');
  });
  it('drops the memory-file type prefix', () => {
    expect(noteTitle('/x/reference_uhs_pricing_figures.md', 'body')).toBe('uhs pricing figures');
  });
});

describe('scoreTask — one work-list task from a few spoken words', () => {
  const task = {
    id: 'T014',
    title: 'Calendar sync for inventory',
    description: 'Bridge uhsEstimate schedule into UHSInvMgmt',
    status: 'incomplete',
  };
  it('matches a whole phrase strongly', () => {
    expect(scoreTask(task, 'calendar sync')).toBeGreaterThan(100);
  });
  it('matches the task id exactly', () => {
    expect(scoreTask(task, 'T014')).toBeGreaterThan(200);
  });
  it('scores an unrelated query at zero', () => {
    expect(scoreTask(task, 'gift certificates')).toBe(0);
  });
  it('an empty query never matches', () => {
    expect(scoreTask(task, '')).toBe(0);
  });
});

// --- vault whitelist → deny list --------------------------------------------
// The defect: PARA_DIRS listed 13 directory names, the UHS vault has 26, and
// insights/ (278 files) was in neither the whitelist nor anyone's mind.
describe('vault walk — the whole vault, minus the junk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mod106-'));
  afterEach(() => {
    /* dir reused across tests; removed at process exit by the OS */
  });

  fs.mkdirSync(path.join(tmp, 'insights'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'business', 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'README.md'), '# root note');
  fs.writeFileSync(path.join(tmp, 'insights', 'a.md'), '# insight');
  fs.writeFileSync(path.join(tmp, 'business', 'contracts', 'c.md'), '# contract');
  fs.writeFileSync(path.join(tmp, '.obsidian', 'workspace.md'), 'junk');
  fs.writeFileSync(path.join(tmp, 'attachments', 'scan.md'), 'junk');

  it('finds notes in directories no whitelist ever mentioned', () => {
    const rel = listAllNotes(tmp).map((n) => n.relPath);
    expect(rel).toContain('insights/a.md');
    expect(rel).toContain(path.join('business', 'contracts', 'c.md'));
  });
  it('includes root-level notes', () => {
    expect(listAllNotes(tmp).map((n) => n.relPath)).toContain('README.md');
  });
  it('excludes the deny-listed and hidden directories', () => {
    const rel = listAllNotes(tmp).map((n) => n.relPath);
    expect(rel.some((r) => r.includes('.obsidian'))).toBe(false);
    expect(rel.some((r) => r.includes('attachments'))).toBe(false);
  });
  it('top-level dirs are discovered, not declared', () => {
    expect(listVaultTopDirs(tmp)).toEqual(['business', 'insights']);
  });
  it('isDeniedDir covers dotdirs and junk names', () => {
    expect(isDeniedDir('.obsidian')).toBe(true);
    expect(isDeniedDir('node_modules')).toBe(true);
    expect(isDeniedDir('insights')).toBe(false);
  });

  // The security boundary must survive the whitelist removal.
  it('resolveVaultPath still refuses traversal', () => {
    expect(resolveVaultPath(tmp, '../../etc/passwd')).toBeNull();
    expect(resolveVaultPath(tmp, 'insights/../../escape.md')).toBeNull();
  });
  it('resolveVaultPath still refuses hidden and denied paths', () => {
    expect(resolveVaultPath(tmp, '.obsidian/workspace.md')).toBeNull();
    expect(resolveVaultPath(tmp, 'attachments/scan.md')).toBeNull();
  });
  it('resolveVaultPath now allows a note outside the old PARA whitelist', () => {
    expect(resolveVaultPath(tmp, 'insights/a.md')).toBe(path.join(tmp, 'insights', 'a.md'));
  });
});
