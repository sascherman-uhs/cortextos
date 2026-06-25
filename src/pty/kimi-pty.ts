import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

const BOOTSTRAP_PATTERN = '[kimi] ready';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * PTY wrapper for Kimi CLI print mode.
 *
 * Kimi's daemon-safe interface is one-shot (`kimi --print --prompt ...`), so
 * this adapter stays logically alive and launches a fresh print invocation for
 * each submitted prompt. Successful child exits are normal; non-zero startup
 * exits are surfaced through the daemon's onExit path.
 */
export class KimiPTY {
  private currentPty: IPty | null = null;
  private alive = false;
  private executing = false;
  private hasSession = false;
  private writeBuffer = '';
  private turnQueue: string[] = [];
  private spawnFn: SpawnFn | null = null;
  private outputBuffer: OutputBuffer;
  private cwd: string;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;

  constructor(private env: CtxEnv, private config: AgentConfig, logPath?: string) {
    this.cwd = config.working_directory || env.agentDir || process.cwd();
    this.outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.alive) {
      throw new Error('KimiPTY already spawned. Kill first.');
    }

    this.alive = true;
    this.hasSession = mode === 'continue';
    this.outputBuffer.push(`${BOOTSTRAP_PATTERN}\n`);

    if (prompt.trim()) {
      this.queueTurn(prompt, true);
    }
  }

  write(data: string): void {
    if (!this.alive) {
      throw new Error('PTY not spawned');
    }

    if (data === '\r') {
      const content = this.writeBuffer
        .replaceAll(PASTE_START, '')
        .replaceAll(PASTE_END, '')
        .trim();
      this.writeBuffer = '';
      if (content) {
        this.queueTurn(content, false);
      }
      return;
    }

    this.writeBuffer += data;
  }

  kill(): void {
    this.alive = false;
    this.turnQueue = [];
    this.writeBuffer = '';
    const pty = this.currentPty;
    this.currentPty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore shutdown races.
      }
    } else {
      this.onExitHandler?.(0, undefined);
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  getPid(): number | null {
    return this.currentPty?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  isBootstrapped(): boolean {
    return this.alive;
  }

  private queueTurn(prompt: string, isStartup: boolean): void {
    this.turnQueue.push(prompt);
    if (!this.executing) {
      this.runNextTurn(isStartup).catch((err) => {
        this.outputBuffer.push(`[kimi] turn failed: ${err}\n`);
        if (isStartup) this.failStartup();
      });
    }
  }

  private async runNextTurn(firstIsStartup: boolean): Promise<void> {
    if (this.executing || !this.alive) return;
    const prompt = this.turnQueue.shift();
    if (!prompt) return;

    this.executing = true;
    const isStartup = firstIsStartup;
    const mode: 'fresh' | 'continue' = this.hasSession ? 'continue' : 'fresh';

    try {
      await this.runKimi(mode, prompt, isStartup);
    } finally {
      this.executing = false;
      if (this.turnQueue.length > 0 && this.alive) {
        this.runNextTurn(false).catch((err) => {
          this.outputBuffer.push(`[kimi] queued turn failed: ${err}\n`);
        });
      }
    }
  }

  private async runKimi(mode: 'fresh' | 'continue', prompt: string, isStartup: boolean): Promise<void> {
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }

    const child = this.spawnFn!('kimi', this.buildKimiArgs(mode, prompt), {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: this.cwd,
      env: this.buildEnv(),
    });
    this.currentPty = child;

    await new Promise<void>((resolve) => {
      child.onData((data: string) => {
        this.outputBuffer.push(data);
      });

      child.onExit(({ exitCode, signal }) => {
        if (this.currentPty === child) {
          this.currentPty = null;
        }

        if (exitCode === 0) {
          this.hasSession = true;
          resolve();
          return;
        }

        this.outputBuffer.push(`[kimi] exited with code ${exitCode} signal ${signal}\n`);
        if (isStartup) {
          this.failStartup(exitCode, signal);
        }
        resolve();
      });
    });
  }

  private buildKimiArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--work-dir',
      this.cwd,
      '--prompt',
      prompt,
      '--afk',
    ];

    if (mode === 'continue') {
      args.push('--continue');
    }

    return args;
  }

  private failStartup(exitCode = 1, signal?: number): void {
    this.alive = false;
    this.turnQueue = [];
    this.currentPty = null;
    this.onExitHandler?.(exitCode, signal);
  }

  private buildEnv(): Record<string, string> {
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    this.loadEnvFile(join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env'), ptyEnv);
    this.loadEnvFile(join(this.env.agentDir, '.env'), ptyEnv);

    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    if (this.config.timezone) {
      ptyEnv['CTX_TIMEZONE'] = this.config.timezone;
      ptyEnv['TZ'] = this.config.timezone;
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }

    return ptyEnv;
  }

  private loadEnvFile(path: string, target: Record<string, string>): void {
    if (!existsSync(path)) return;
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        target[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
  }

  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH']) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    return env;
  }
}
