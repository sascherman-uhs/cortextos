/**
 * OS-07 — secret references in agent prompts.
 *
 * An agent's cron prompt is text that ends up in a PTY and, frequently, in a
 * shell command. Vivienne's morning-briefing cron carried a literal Telegram
 * bot token inside a `curl` URL — a live credential sitting in a config file,
 * copied into every log line, transcript and backup that prompt ever touched.
 *
 * The fix is a reference, not a value. A prompt writes:
 *
 *     curl -s "https://api.telegram.org/bot${env:BOT_TOKEN}/sendDocument" ...
 *
 * and this module rewrites it, at injection time, to the shell expansion
 * `"$BOT_TOKEN"`. The agent's PTY already carries the agent `.env` (see
 * `src/pty/agent-pty.ts`, which sources `orgs/<org>/secrets.env` then the
 * agent's own `.env`), so the shell resolves it and the secret never enters
 * the prompt text, the daemon log, or the injected string.
 *
 * `findInlineBotTokens` is the guard for the other direction: a prompt that
 * still contains a raw token literal is reported — with the value redacted —
 * so the condition is visible rather than silently shipped.
 */

/** `${env:KEY}` — the only reference form. KEY is a normal env identifier. */
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Telegram bot token shape: `<digits>:<secret>`.
 *
 * No leading `\b`. The literal this exists to catch sits in
 * `https://api.telegram.org/bot<TOKEN>/sendDocument`, where the digits follow
 * the letter `t` and there is no word boundary at all. `(?<!\d)` still keeps
 * it from matching the tail of a longer digit run.
 */
const BOT_TOKEN_LITERAL = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g;

/**
 * Rewrite `${env:KEY}` references into shell expansions.
 *
 * Returns the rewritten text plus the key NAMES that were referenced, so a
 * caller can log what a prompt depends on without ever reading a value.
 */
export function resolveSecretRefs(text: string): { text: string; referencedKeys: string[] } {
  const referenced = new Set<string>();
  const rewritten = text.replace(ENV_REF, (_match, key: string) => {
    referenced.add(key);
    return `"$${key}"`;
  });
  return { text: rewritten, referencedKeys: [...referenced].sort() };
}

/**
 * Locate raw bot-token literals in text.
 *
 * Returns redacted descriptors only — offset, length and a masked preview.
 * Nothing this function returns can reconstruct the token.
 */
export function findInlineBotTokens(text: string): Array<{ index: number; length: number; masked: string }> {
  const out: Array<{ index: number; length: number; masked: string }> = [];
  BOT_TOKEN_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOT_TOKEN_LITERAL.exec(text)) !== null) {
    const value = match[0];
    const botId = value.slice(0, value.indexOf(':'));
    out.push({ index: match.index, length: value.length, masked: `${botId}:<redacted ${value.length - botId.length - 1} chars>` });
  }
  return out;
}

/** Replace every raw bot-token literal with `<redacted>`. For logs and errors. */
export function redactBotTokens(text: string): string {
  BOT_TOKEN_LITERAL.lastIndex = 0;
  return text.replace(BOT_TOKEN_LITERAL, (value) => `${value.slice(0, value.indexOf(':'))}:<redacted>`);
}

/**
 * Prepare a prompt for injection: expand references, then report any literal
 * that remains. The prompt is returned either way — this package removes the
 * credential from config via the JARVIS migration script, and this guard makes
 * a remaining one loud rather than blocking an agent's morning briefing.
 */
export function prepareAgentPrompt(text: string): {
  text: string;
  referencedKeys: string[];
  inlineTokenWarnings: string[];
} {
  const { text: expanded, referencedKeys } = resolveSecretRefs(text);
  const inlineTokenWarnings = findInlineBotTokens(expanded).map(
    (hit) =>
      `prompt contains a raw bot-token literal at offset ${hit.index} (${hit.masked}). ` +
      `Replace it with \${env:BOT_TOKEN} — run scripts/agent-os/migrate_inline_bot_token.py in uhsJARVIS.`,
  );
  return { text: expanded, referencedKeys, inlineTokenWarnings };
}
