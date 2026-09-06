/**
 * OS-07 — credential cleanup: a cron prompt references a key, it never
 * carries a value.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSecretRefs,
  findInlineBotTokens,
  redactBotTokens,
  prepareAgentPrompt,
} from '../../../src/utils/secret-refs.js';

/** Token-shaped, obviously fake. Nothing here is a live credential. */
const SENTINEL = '111111111:ZZTEST-TOKEN-SENTINEL-aaaaaaaaaaaaaaaaaaaaa';

describe('secret references in agent prompts', () => {
  it('rewrites ${env:KEY} into a shell expansion and reports the key NAME only', () => {
    const prompt = 'curl -s "https://api.telegram.org/bot${env:BOT_TOKEN}/sendDocument" -F chat_id=123';
    const { text, referencedKeys } = resolveSecretRefs(prompt);
    expect(text).toBe('curl -s "https://api.telegram.org/bot"$BOT_TOKEN"/sendDocument" -F chat_id=123');
    expect(referencedKeys).toEqual(['BOT_TOKEN']);
    expect(text).not.toContain('ZZTEST-TOKEN-SENTINEL');
  });

  it('leaves a prompt with no references untouched', () => {
    const prompt = 'Write the morning briefing and post it.';
    expect(resolveSecretRefs(prompt)).toEqual({ text: prompt, referencedKeys: [] });
  });

  it('finds a raw token literal and describes it without revealing it', () => {
    const hits = findInlineBotTokens(`curl https://api.telegram.org/bot${SENTINEL}/sendDocument`);
    expect(hits).toHaveLength(1);
    expect(hits[0].masked).toBe('111111111:<redacted 43 chars>');
    expect(JSON.stringify(hits)).not.toContain('ZZTEST-TOKEN-SENTINEL');
  });

  it('redacts token literals for logs', () => {
    const redacted = redactBotTokens(`prefix ${SENTINEL} suffix`);
    expect(redacted).toBe('prefix 111111111:<redacted> suffix');
    expect(redacted).not.toContain('ZZTEST-TOKEN-SENTINEL');
  });

  it('prepares a prompt: expands references and warns about a remaining literal', () => {
    const prepared = prepareAgentPrompt(`use ${SENTINEL} and \${env:CHAT_ID}`);
    expect(prepared.referencedKeys).toEqual(['CHAT_ID']);
    expect(prepared.inlineTokenWarnings).toHaveLength(1);
    expect(prepared.inlineTokenWarnings[0]).toContain('migrate_inline_bot_token.py');
    expect(prepared.inlineTokenWarnings.join(' ')).not.toContain('ZZTEST-TOKEN-SENTINEL');
  });

  it('a migrated prompt produces no warning at all', () => {
    const prepared = prepareAgentPrompt('curl "https://api.telegram.org/bot${env:BOT_TOKEN}/sendDocument"');
    expect(prepared.inlineTokenWarnings).toEqual([]);
    expect(prepared.text).toContain('"$BOT_TOKEN"');
  });
});
