/**
 * Explicit model selection per runtime adapter.
 *
 * These assert the half of the routing contract that the registry cannot prove
 * on its own: that an enforced resolution actually reaches the adapter, and
 * that SHADOW mode leaves the legacy dispatch byte-for-byte unchanged.
 */
import { describe, it, expect } from 'vitest';
import { AgentPTY } from '../../../src/pty/agent-pty.js';
import { KimiPTY } from '../../../src/pty/kimi-pty.js';
import { CodexAppServerPTY } from '../../../src/pty/codex-app-server-pty.js';
import type { AgentConfig, CtxEnv } from '../../../src/types/index.js';

const env: CtxEnv = {
  ctxRoot: '/tmp/ctx-root-adapters',
  frameworkRoot: '',
  instanceId: 'default',
  agentName: 'test-agent',
  org: 'uhs',
  agentDir: '/tmp/ctx-root-adapters/agent',
  projectRoot: '',
} as CtxEnv;

/** buildClaudeArgs is `protected`; a subclass is the sanctioned way in. */
class ProbePTY extends AgentPTY {
  args(mode: 'fresh' | 'continue', prompt: string): string[] {
    return this.buildClaudeArgs(mode, prompt);
  }
}

function modelArg(args: string[]): string | null {
  const i = args.indexOf('--model');
  return i === -1 ? null : args[i + 1];
}

describe('claude-code adapter (cli:--model)', () => {
  const config: AgentConfig = { model: 'claude-sonnet-4-6' };

  it('passes the legacy config model when no override is set (shadow)', () => {
    const pty = new ProbePTY(env, config);
    expect(modelArg(pty.args('fresh', 'hi'))).toBe('claude-sonnet-4-6');
  });

  it('passes the resolved model when one is set (enforced)', () => {
    const pty = new ProbePTY(env, config);
    pty.setModelOverride('claude-opus-5');
    expect(modelArg(pty.args('fresh', 'hi'))).toBe('claude-opus-5');
    expect(pty.getEffectiveModel()).toBe('claude-opus-5');
  });

  it('clears back to the legacy model when the override is removed', () => {
    const pty = new ProbePTY(env, config);
    pty.setModelOverride('claude-opus-5');
    pty.setModelOverride(null);
    expect(modelArg(pty.args('fresh', 'hi'))).toBe('claude-sonnet-4-6');
  });

  it('omits --model entirely when neither is set', () => {
    const pty = new ProbePTY(env, {});
    expect(modelArg(pty.args('fresh', 'hi'))).toBeNull();
  });
});

describe('kimi adapter (cli:--model)', () => {
  // `kimi --help` on the installed CLI documents `--model/-m TEXT`.
  const build = (pty: KimiPTY): string[] =>
    (pty as unknown as { buildKimiArgs(m: 'fresh' | 'continue', p: string): string[] }).buildKimiArgs('fresh', 'hi');

  it('does NOT pass a model in shadow, even when config.model is set', () => {
    // This adapter has always ignored config.model. Honouring it in shadow
    // would change what runs, which the contract forbids.
    const pty = new KimiPTY(env, { model: 'kimi-k2', runtime: 'kimi' });
    expect(modelArg(build(pty))).toBeNull();
    expect(pty.getEffectiveModel()).toBeUndefined();
  });

  it('passes the resolved model when enforced', () => {
    const pty = new KimiPTY(env, { model: 'kimi-k2', runtime: 'kimi' });
    pty.setModelOverride('kimi-k2');
    expect(modelArg(build(pty))).toBe('kimi-k2');
  });
});

describe('codex-app-server adapter (thread/turn model)', () => {
  const param = (pty: CodexAppServerPTY): Record<string, string> =>
    (pty as unknown as { modelParam(): Record<string, string> }).modelParam();

  it('sends no model parameter in shadow, even when config.model is set', () => {
    const pty = new CodexAppServerPTY(env, { model: 'claude-sonnet-4-6', runtime: 'codex-app-server' });
    expect(param(pty)).toEqual({});
    expect(pty.getEffectiveModel()).toBeUndefined();
  });

  it('sends { model } on thread/start, thread/resume and turn/start when enforced', () => {
    const pty = new CodexAppServerPTY(env, { runtime: 'codex-app-server' });
    pty.setModelOverride('gpt-5-codex');
    // One helper feeds all three boundaries, so proving it once proves all of
    // them; the call sites are asserted by the source-level test below.
    expect(param(pty)).toEqual({ model: 'gpt-5-codex' });
    expect(pty.getEffectiveModel()).toBe('gpt-5-codex');
  });

  it('wires the model parameter into all three protocol boundaries', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../../src/pty/codex-app-server-pty.ts', import.meta.url),
      'utf-8',
    );
    // ThreadStartParams.model, ThreadResumeParams.model (x2 resume paths) and
    // TurnStartParams.model per the generated v2 schema for codex-cli 0.153.2.
    expect(src.split('...this.modelParam(),').length - 1).toBe(4);
  });

  it('exposes the thread id so the rollout observer can bind to this session', () => {
    const pty = new CodexAppServerPTY(env, { runtime: 'codex-app-server' });
    expect(pty.getThreadId()).toBeNull();
  });
});
