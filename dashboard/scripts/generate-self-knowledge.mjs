#!/usr/bin/env node
// === JARVIS MOD #90 — machine-generated self-knowledge document ===
//
// Emits public/jarvis-self-knowledge.md: what JARVIS IS and CAN DO, on this
// machine, at this revision. Everything below is EXTRACTED from source. Nothing
// is hand-written here except the section headings and the honesty rules.
//
// Why extraction and not prose: a hand-written capability doc is correct on the
// day it is written and quietly wrong forever after. Tools get added to
// jarvis-prompt.ts, lanes get added to fast-lanes.ts, agents get toggled in
// enabled-agents.json — and a paragraph describing them does not notice. Every
// fact in the output has exactly one source file, and check-self-knowledge-drift
// fails when the file and the doc disagree.
//
// HONESTY RULE: if a source file is missing or its shape has changed enough that
// the parser finds nothing, the section says so ("unknown — <reason>"). It never
// falls back to a remembered value. A stale-but-plausible capability list is the
// exact failure this document exists to prevent.
//
// DETERMINISM: no wall-clock timestamp. The only volatile line is the source
// revision SHA, which the drift checker normalizes away — otherwise every
// unrelated commit would report drift.
//
// Usage:  node scripts/generate-self-knowledge.mjs
//         SELF_KNOWLEDGE_OUT=/tmp/x.md node scripts/generate-self-knowledge.mjs
// === END header ===

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DASHBOARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SELF_KNOWLEDGE_OUT || path.join(DASHBOARD, 'public', 'jarvis-self-knowledge.md');

const SRC = {
  prompt: 'src/lib/realtime/jarvis-prompt.ts',
  lanes: 'src/lib/realtime/fast-lanes.ts',
  fastReply: 'src/lib/fastpath/fast-reply.ts',
  signoff: 'src/lib/voice/signoff.ts',
  snapshot: 'src/lib/fastpath/live-snapshot.ts',
  window: 'src/lib/fastpath/conversation-window.ts',
  tts: 'src/app/api/uhs/tts/route.ts',
  stt: 'src/app/api/uhs/stt/route.ts',
  session: 'src/app/api/uhs/realtime/session/route.ts',
};

const FLEET_CONFIG =
  process.env.CTX_ENABLED_AGENTS ||
  path.join(os.homedir(), '.cortextos', 'default', 'config', 'enabled-agents.json');

// --- reading -----------------------------------------------------------------

/** Read a source file relative to the dashboard root. null when absent. */
function read(rel) {
  try {
    return fs.readFileSync(path.join(DASHBOARD, rel), 'utf8');
  } catch {
    return null;
  }
}

/** A section whose source is gone says so, in the document, in place. */
function missing(rel) {
  return `> **unknown** — \`${rel}\` was not found at generation time, so this section could not be extracted.`;
}

/** Nothing matched: the file exists but its shape moved out from under the parser. */
function unparsed(rel, what) {
  return `> **unknown** — \`${rel}\` exists but no ${what} could be parsed from it. The parser in \`scripts/generate-self-knowledge.mjs\` needs updating.`;
}

/**
 * Flatten a TypeScript string-concatenation expression to its text.
 * Tool descriptions are written as `'a ' + "b's c" + 'd'` across many lines;
 * this returns `a b's c d` and drops the quoting.
 */
function flattenStringExpr(expr) {
  const parts = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    parts.push((m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' '));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** First capture group of `re` against `text`, or null. */
function grab(text, re) {
  if (!text) return null;
  const m = text.match(re);
  return m ? m[1] : null;
}

// --- section: realtime voice tool registry -----------------------------------

function toolRegistry() {
  const src = read(SRC.prompt);
  if (!src) return missing(SRC.prompt);

  const start = src.indexOf('JARVIS_REALTIME_TOOLS');
  if (start === -1) return unparsed(SRC.prompt, 'tool registry');
  const region = src.slice(start);

  // Each entry: name, then description up to `parameters:`, then the params object.
  const entryRe =
    /name:\s*'([^']+)',\s*description:\s*([\s\S]*?),\s*parameters:\s*(\{[\s\S]*?\}),\s*\},/g;

  const rows = [];
  let m;
  while ((m = entryRe.exec(region)) !== null) {
    const [, name, descExpr, paramsSrc] = m;
    const description = flattenStringExpr(descExpr);
    const props = [...paramsSrc.matchAll(/(\w+):\s*\{\s*type:\s*'(\w+)'/g)]
      .filter(([, key]) => key !== 'type')
      .map(([, key, type]) => `${key}: ${type}`);
    const required = (grab(paramsSrc, /required:\s*\[([^\]]*)\]/) || '')
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter(Boolean);
    rows.push({ name, description, props, required });
  }
  if (rows.length === 0) return unparsed(SRC.prompt, 'tool definitions');

  const out = [
    `${rows.length} tools are registered on the Realtime voice session, in this order (order is a preference signal to the model — fast lanes first, the general-purpose brain last).`,
    '',
  ];
  for (const r of rows) {
    const args =
      r.props.length === 0
        ? 'no arguments'
        : r.props.map((p) => (r.required.includes(p.split(':')[0]) ? `**${p}** (required)` : p)).join(', ');
    out.push(`### \`${r.name}\``);
    out.push(`*Arguments:* ${args}`);
    out.push('');
    out.push(r.description);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

// --- section: fast lanes -----------------------------------------------------

function fastLanes() {
  const src = read(SRC.lanes);
  if (!src) return missing(SRC.lanes);

  const lanes = [...src.matchAll(/export async function (\w+)\(([^)]*)\):\s*Promise<LaneResult>/g)].map(
    ([, name, args]) => ({ name, args: args.trim() }),
  );
  if (lanes.length === 0) return unparsed(SRC.lanes, 'lane functions');

  // The lane header states the contract every lane must honour. Extracted rather
  // than restated so the doc cannot promise a guarantee the code stopped making.
  // Rules wrap across comment lines (`//   - first` then `//     continued`), so
  // the continuation lines are folded back in — a half-sentence rule reads as a
  // rule that was quietly weakened.
  const rules = [...src.matchAll(/^\/\/\s{3}- (.+(?:\n\/\/\s{5}\S.*)*)$/gm)].map(([, r]) =>
    r.replace(/\n\/\/\s+/g, ' ').replace(/\s+/g, ' ').trim(),
  );

  const out = [
    `${lanes.length} fast lanes back the voice tools above. They answer directly from data the dashboard can already reach, in the hundreds-of-milliseconds range, instead of routing a full agent turn.`,
    '',
  ];
  for (const l of lanes) {
    out.push(`- \`${l.name}(${l.args})\` → \`LaneResult { output, ok }\``);
  }
  if (rules.length) {
    out.push('', '**Contract every lane honours** (from the module header):', '');
    for (const r of rules) out.push(`- ${r}`);
  }

  const calendarId = grab(src, /'([0-9a-f]{40,}@group\.calendar\.google\.com)'/);
  const noticeDays = grab(src, /NOTICE_DAYS_BEFORE_END\s*=\s*(\d+)/);
  const extras = [];
  if (calendarId) extras.push(`Calendar read target: the UHS calendar (\`${calendarId.slice(0, 12)}…\`), never \`primary\`.`);
  if (noticeDays) extras.push(`Notice-to-terminate is derived, never stored: contract end minus ${noticeDays} paid calendar days.`);
  if (extras.length) {
    out.push('', '**Load-bearing constants:**', '');
    for (const e of extras) out.push(`- ${e}`);
  }
  return out.join('\n');
}

// --- section: fast-path capabilities -----------------------------------------

function fastPath() {
  const reply = read(SRC.fastReply);
  const sign = read(SRC.signoff);
  const snap = read(SRC.snapshot);
  const win = read(SRC.window);
  if (!reply && !sign && !snap && !win) return missing(Object.values(SRC).join(', '));

  const rows = [];
  const add = (name, value, source) => {
    if (value != null) rows.push(`| ${name} | \`${value}\` | \`${source}\` |`);
  };

  add('Fast-path model', grab(reply, /DEFAULT_MODEL\s*=\s*process\.env\.\w+\s*\|\|\s*'([^']+)'/), SRC.fastReply);
  add('Fast-path timeout (ms)', grab(reply, /TIMEOUT_MS\s*=\s*parseInt\(process\.env\.\w+\s*\|\|\s*'(\d+)'/), SRC.fastReply);
  add('Fast-path max tokens', grab(reply, /MAX_TOKENS\s*=\s*(\d+)/), SRC.fastReply);
  add('Escalation token', grab(reply, /ESCALATE_TOKEN\s*=\s*'([^']+)'/), SRC.fastReply);
  add('Goodbye: max words', grab(sign, /MAX_SIGNOFF_WORDS\s*=\s*(\d+)/), SRC.signoff);
  add('Live-counts cache TTL (ms)', grab(snap, /SNAPSHOT_TTL_MS\s*=\s*([\d_]+)/), SRC.snapshot);
  add('Conversation window (turns)', grab(win, /buildWindow\([^)]*maxTurns\s*=\s*(\d+)/), SRC.window);

  const signoffLines = sign ? (sign.match(/SIGNOFF_LINES\s*=\s*\[([\s\S]*?)\]/)?.[1].match(/'/g)?.length ?? 0) / 2 : null;
  if (signoffLines) rows.push(`| Canned sign-off lines | \`${signoffLines}\` | \`${SRC.signoff}\` |`);

  if (rows.length === 0) return unparsed(SRC.fastReply, 'fast-path constants');

  const out = [
    'The fast path is a no-tools conversational lane that answers cheap turns without spinning up a full agent. Three behaviours matter:',
    '',
    `- **Escalation** — the model emits the escalate token when a turn needs the real brain; the turn is then handed to the full agent (\`${SRC.fastReply}\`).`,
    `- **Goodbye detection** — a deterministic, model-free sign-off detector closes the voice window and speaks a canned line, because asking a model "was that a goodbye?" costs exactly what the goodbye was supposed to save (\`${SRC.signoff}\`).`,
    `- **Live-counts snapshot** — real staging/contract counts are injected into the *uncached* system block every turn, from the same predicate as the dashboard tile and the voice tools, so the fast path cannot invent a number (\`${SRC.snapshot}\`).`,
    '',
    '| Setting | Value | Source |',
    '| --- | --- | --- |',
    ...rows,
  ];
  return out.join('\n');
}

// --- section: agent fleet ----------------------------------------------------

function fleet() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FLEET_CONFIG, 'utf8'));
  } catch {
    return `> **unknown** — the fleet roster at \`${FLEET_CONFIG}\` could not be read at generation time. This document was generated on a machine without a CortexOS runtime, or the path moved.`;
  }
  const names = Object.keys(raw).sort();
  if (names.length === 0) return `> **unknown** — \`${FLEET_CONFIG}\` parsed but declared no agents.`;

  const enabled = names.filter((n) => raw[n]?.enabled);
  const out = [
    `${enabled.length} of ${names.length} agents enabled, read from \`${FLEET_CONFIG}\` at generation time.`,
    '',
    '| Agent | Enabled | Status | Org |',
    '| --- | --- | --- | --- |',
  ];
  for (const n of names) {
    const a = raw[n] ?? {};
    out.push(`| \`${n}\` | ${a.enabled ? 'yes' : 'no'} | ${a.status ?? '—'} | ${a.org ?? '—'} |`);
  }
  return out.join('\n');
}

// --- section: API surface ----------------------------------------------------

function apiSurface() {
  const root = path.join(DASHBOARD, 'src', 'app', 'api', 'uhs');
  if (!fs.existsSync(root)) return missing('src/app/api/uhs');

  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'route.ts') {
        const body = fs.readFileSync(full, 'utf8');
        const methods = [...body.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
        const url = '/' + path.relative(path.join(DASHBOARD, 'src', 'app'), dir).split(path.sep).join('/');
        routes.push({ url, methods });
      }
    }
  };
  walk(root);
  if (routes.length === 0) return unparsed('src/app/api/uhs', 'route handlers');

  const out = [
    `${routes.length} HTTP routes under \`/api/uhs\`. Methods are the handlers actually exported by each \`route.ts\`; anything not listed returns 405.`,
    '',
    '| Route | Methods |',
    '| --- | --- |',
  ];
  for (const r of routes) {
    out.push(`| \`${r.url}\` | ${r.methods.length ? r.methods.join(', ') : '—'} |`);
  }
  return out.join('\n');
}

// --- section: voice stack ----------------------------------------------------

function voiceStack() {
  const tts = read(SRC.tts);
  const stt = read(SRC.stt);
  if (!tts && !stt) return missing(`${SRC.tts}, ${SRC.stt}`);

  const out = [];

  out.push('**Speech out (TTS)** — `' + SRC.tts + '`');
  out.push('');
  if (!tts) {
    out.push(missing(SRC.tts));
  } else {
    // Tier comments are the authored fallback chain; a tier removed from the code
    // removes its line here.
    const tiers = [...tts.matchAll(/^\/\/\s*(Tier \d+ — [^\n]*(?:\n\/\/\s{3}[^\n]*)*)/gm)].map(([, t]) =>
      t.replace(/\n\/\/\s{3}/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    if (tiers.length === 0) out.push(unparsed(SRC.tts, 'tier chain'));
    else for (const t of tiers) out.push(`- ${t}`);
  }

  out.push('', '**Speech in (STT)** — `' + SRC.stt + '`', '');
  if (!stt) {
    out.push(missing(SRC.stt));
  } else {
    const dg = grab(stt, /api\.deepgram\.com\/v1\/listen\?model=([\w-]+)/);
    // The model path is a template literal, so read the literal default rather
    // than the variable name — "resolved from modelPath" tells a reader nothing.
    const whisperModel = grab(stt, /WHISPER_CPP_MODEL\s*\?\?\s*\n?\s*`([^`]+)`/);
    const killSwitch = grab(stt, /(CTX_\w+_DISABLE)/);
    if (dg) out.push(`- Tier 1 — Deepgram \`${dg}\` (cloud). Key from env or the macOS Keychain, resolved at request time.`);
    if (killSwitch) out.push(`- Kill switch — \`${killSwitch}=1\` skips tier 1 and falls straight through.`);
    out.push(
      whisperModel
        ? `- Tier 2 — local \`whisper-cli\` (Metal-accelerated), model \`${whisperModel.replace('${process.env.HOME}', '~')}\`, overridable with \`WHISPER_CPP_MODEL\`. Runs offline; any tier-1 failure or absent key lands here.`
        : unparsed(SRC.stt, 'a local fallback engine'),
    );
  }

  // Read the EFFECTIVE values off the session route — the endpoint that actually
  // mints the session — not the exported constants in jarvis-prompt.ts. Those
  // constants are currently referenced by nothing and disagree with the route,
  // which is precisely the kind of drift a hand-written doc would repeat.
  const session = read(SRC.session);
  out.push('', '**Realtime voice session** — `' + SRC.session + '`', '');
  if (!session) {
    out.push(missing(SRC.session));
  } else {
    const model = grab(session, /OPENAI_REALTIME_MODEL\s*\?\?\s*'([^']+)'/);
    const voice = grab(session, /OPENAI_REALTIME_VOICE\s*\?\?\s*'([^']+)'/);
    const silence = grab(session, /silence_duration_ms:\s*(\d+)/);
    const transcribe = grab(session, /transcription:\s*\{\s*model:\s*'([^']+)'/);
    out.push(model ? `- Model: \`${model}\` (env \`OPENAI_REALTIME_MODEL\`)` : unparsed(SRC.session, 'a model default'));
    if (voice) out.push(`- Voice: \`${voice}\` (env \`OPENAI_REALTIME_VOICE\`)`);
    if (silence) out.push(`- Turn detection: server VAD, ${silence}ms of silence ends a turn.`);
    if (transcribe) out.push(`- Input transcription: \`${transcribe}\`.`);
  }
  return out.join('\n');
}

// --- section: standing facts (from the live system prompt) -------------------

function standingFacts() {
  const src = read(SRC.prompt);
  if (!src) return missing(SRC.prompt);
  const block = grab(src, /STANDING FACTS[^\n]*\n([\s\S]*?)\n\n/);
  if (!block) return unparsed(SRC.prompt, 'a STANDING FACTS block');
  return block.trim();
}

// --- provenance --------------------------------------------------------------

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: DASHBOARD, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown (not a git checkout)';
  }
}

// --- assembly ----------------------------------------------------------------

const doc = `# JARVIS — Self-Knowledge

**This file is generated. Do not hand-edit it.** Run \`npm run self-knowledge\` in \`dashboard/\`;
\`npm run self-knowledge:check\` fails when this file and the code disagree.

Generated by \`dashboard/scripts/generate-self-knowledge.mjs\` from source revision \`${gitSha()}\`.

Every statement below was extracted from a named source file at generation time. Where a source
was missing or its shape had changed, the section says **unknown** rather than guessing — a
plausible-but-stale capability list is the specific failure this document exists to prevent.

---

## What JARVIS is

JARVIS is the operations intelligence for Utopia Home Staging, a luxury home staging company in
Las Vegas, Nevada. It runs as a CortexOS agent fleet plus this Next.js dashboard, which hosts the
voice interface (the "Cosmos" PWA), the operational tiles, and the HTTP surface the agents call.

Standing facts it may speak without a lookup, verbatim from the live voice system prompt:

> ${standingFacts().split('\n').join('\n> ')}

---

## Voice tools

${toolRegistry()}

---

## Fast lanes

${fastLanes()}

---

## Fast-path capabilities

${fastPath()}

---

## Agent fleet

${fleet()}

---

## HTTP surface

${apiSurface()}

---

## Voice stack

${voiceStack()}

---

## Regenerating

\`\`\`bash
cd dashboard
npm run self-knowledge        # rewrite public/jarvis-self-knowledge.md
npm run self-knowledge:check  # exit 1 if the doc has drifted from the code
\`\`\`

The check ignores the source-revision line, so an unrelated commit does not report drift; any
other difference does. Wiring the check into CI or a pre-commit hook is deliberately NOT done
here — hooks affect every committer and that is Scott's call.
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, doc);
console.log(`wrote ${OUT} (${doc.split('\n').length} lines)`);

// --- llms.txt ----------------------------------------------------------------
// A pointer, not a copy. Anything stated twice drifts, so this file names the
// surfaces and sends the reader to the generated doc for every actual fact.
const LLMS_OUT = process.env.LLMS_TXT_OUT || path.join(DASHBOARD, 'public', 'llms.txt');
const llms = `# JARVIS — Utopia Home Staging operations dashboard

> The CortexOS dashboard for Utopia Home Staging (Las Vegas, NV): the voice
> interface, the operational tiles, and the HTTP surface the JARVIS agent fleet
> calls. This file is generated — do not hand-edit.

## What to read

- [Self-knowledge](/jarvis-self-knowledge.md): the generated, always-current
  description of what JARVIS is and can do — voice tools and their arguments,
  fast lanes, fast-path behaviour, the agent fleet, every \`/api/uhs\` route, and
  the speech-in/speech-out stacks. Regenerated from source; a drift checker
  fails when it disagrees with the code.

## Notes

- Every fact in the self-knowledge doc is extracted from a named source file.
  Sections that could not be extracted say **unknown** rather than guessing.
- This is an internal operations tool, not a public product. Routes under
  \`/api/uhs\` are session-authenticated.
`;
fs.writeFileSync(LLMS_OUT, llms);
console.log(`wrote ${LLMS_OUT} (${llms.split('\n').length} lines)`);
