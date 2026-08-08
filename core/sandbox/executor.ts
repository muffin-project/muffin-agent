import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { probeSandbox, type SandboxProbe } from './probe.js';

/**
 * The one door to sandboxed execution.
 *
 * `@anthropic-ai/sandbox-runtime` is a 0.0.x pinned exact, and this module is
 * the boundary ADR-0026 requires around it: the srt config is constructed here
 * field by field — never passed through from anywhere — because srt silently
 * ignores unknown config keys (upstream #434), and a typo'd `denyWriteTypo`
 * would otherwise become an empty deny list that still reports success.
 *
 * Every guarantee this module relies on has a test that executes a real
 * containment (executor.test.ts); trusting the README instead of a probe is
 * how the previous sandbox was a no-op for two months.
 */

export type ExecRequest = {
  /** The command line, run non-interactively (no PTY — upstream #419 cluster). */
  command: string;
  /** Absolute. Where the command runs; also anchors srt profile generation. */
  cwd: string;
  /** Absolute directories writable for THIS invocation only. */
  writeScope: readonly string[];
  /**
   * Domains reachable through the egress proxy for this invocation. Default
   * none: with an empty allowlist and no ask-callback registered, srt denies
   * every host.
   */
  allowHosts?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
/** Per stream, head+tail around a marker; matches what peers keep inline. */
export const EXEC_MAX_OUTPUT_CHARS = 30_000;
/** Hard buffering cap per stream so a firehose cannot eat the process heap. */
const BUFFER_HARD_CAP = 200_000;

/** Paths the sandbox must never touch, whatever the per-call scope says. */
export type ExecGuards = {
  /** RoT, config, secrets — denied in write always (threat model §3-bis). */
  denyWrite: readonly string[];
  /** Secrets — denied in read: a child that reads the key has already won. */
  denyRead: readonly string[];
};

export class SandboxExecutor {
  private initPromise: Promise<void> | null = null;
  private cachedProbe: SandboxProbe | null = null;
  private scratchDir: string | null = null;

  constructor(
    private readonly guards: ExecGuards,
    /** Injectable so a test can exercise the unavailable path on any machine. */
    private readonly probe: () => SandboxProbe = probeSandbox,
  ) {}

  /** Cached: the answer cannot change while the process runs. */
  status(): SandboxProbe {
    this.cachedProbe ??= this.probe();
    return this.cachedProbe;
  }

  /**
   * Session scratch space: writable in every invocation, survives across
   * commands of the same session so `cmd1 > f && cmd2 < f` workflows hold.
   */
  private scratch(): string {
    this.scratchDir ??= mkdtempSync(join(tmpdir(), 'muffin-exec-'));
    return this.scratchDir;
  }

  private async ensureInit(): Promise<void> {
    this.initPromise ??= (async () => {
      const status = this.status();
      if (!status.available) {
        this.initPromise = null;
        throw new Error(`sandbox unavailable: ${status.reason} — ${status.remedy}`);
      }
      await SandboxManager.initialize(this.baseConfig());
    })();
    return this.initPromise;
  }

  /**
   * Base config. Explicit keys only, and the guards are repeated in every
   * per-call config below: srt merges customConfig per-field, and relying on
   * that merge to preserve a deny list is one ambiguity too many for the part
   * that holds the Root of Trust.
   */
  private baseConfig(): SandboxRuntimeConfig {
    return {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        // v1 skips the optional apply-seccomp layer: two open bugs break it on
        // Ubuntu 24.04 (#428, #429) for reasons orthogonal to the userns fix.
        // Declared limit: Unix-socket hardening is off on Linux.
        ...(process.platform === 'linux' ? { allowAllUnixSockets: true } : {}),
      },
      filesystem: {
        denyRead: [...this.guards.denyRead],
        allowWrite: [],
        denyWrite: [...this.guards.denyWrite],
      },
    };
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    await this.ensureInit();
    const scratch = this.scratch();
    const timeoutMs = Math.min(req.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS);

    const perCall: Partial<SandboxRuntimeConfig> = {
      network: {
        allowedDomains: [...(req.allowHosts ?? [])],
        deniedDomains: [],
        ...(process.platform === 'linux' ? { allowAllUnixSockets: true } : {}),
      },
      filesystem: {
        denyRead: [...this.guards.denyRead],
        allowWrite: [...req.writeScope, scratch],
        denyWrite: [...this.guards.denyWrite],
      },
    };

    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      req.command,
      undefined,
      perCall,
      req.signal,
      req.cwd,
    );

    const started = Date.now();
    try {
      return await this.spawnCollect(wrapped.argv, this.childEnv(wrapped.env, scratch), req, timeoutMs, started);
    } finally {
      // Linux leaves ghost mount-point files for deny paths that did not exist;
      // upstream documents this as the embedder's job after every command.
      SandboxManager.cleanupAfterCommand();
    }
  }

  /**
   * The child's environment is rebuilt, not inherited: the host process holds
   * the model API key in env, and a deny-read on the secrets *file* protects
   * nothing if the key rides in via environ. Keep a small base allowlist plus
   * whatever srt added or changed (its proxy plumbing) — a secret already in
   * the host env is by definition unchanged, so it never crosses.
   */
  private childEnv(srtEnv: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']) {
      if (process.env[key] !== undefined) out[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(srtEnv)) {
      if (value !== undefined && process.env[key] !== value) out[key] = value;
    }
    out['TMPDIR'] = scratch;
    return out;
  }

  private spawnCollect(
    argv: string[],
    env: NodeJS.ProcessEnv,
    req: ExecRequest,
    timeoutMs: number,
    started: number,
  ): Promise<ExecResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: req.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(req.signal ? { signal: req.signal } : {}),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < BUFFER_HARD_CAP) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < BUFFER_HARD_CAP) stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => rejectPromise(error));
      child.on('close', (code, signal) => {
        const durationMs = Date.now() - started;
        const timedOut = signal === 'SIGKILL' && durationMs >= timeoutMs;
        const so = clip(stdout);
        const se = clip(stderr);
        resolvePromise({
          code,
          stdout: so.text,
          stderr: se.text,
          truncated: so.truncated || se.truncated,
          timedOut,
          durationMs,
        });
      });
    });
  }

  /** Best effort, safe to call more than once. */
  async close(): Promise<void> {
    if (this.scratchDir) {
      try {
        rmSync(this.scratchDir, { recursive: true, force: true });
      } catch {
        // scratch under tmpdir: the OS reclaims it if we could not
      }
      this.scratchDir = null;
    }
    if (this.initPromise) {
      this.initPromise = null;
      await SandboxManager.reset();
    }
  }
}

/**
 * Head-and-tail, weighted toward the tail: errors and results live at the end
 * of output, and a cut that keeps only the beginning hides exactly the part
 * the model needs. The cut is announced in the text — an unannounced cut reads
 * as a complete result, which is this project's canonical failure.
 */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXEC_MAX_OUTPUT_CHARS) return { text, truncated: false };
  const head = text.slice(0, 10_000);
  const tail = text.slice(-20_000);
  const omitted = text.length - head.length - tail.length;
  return {
    text: `${head}\n…[output troncato: ~${omitted} caratteri omessi]…\n${tail}`,
    truncated: true,
  };
}

/** Exposed for the shell tool: srt annotates denials so the model sees why. */
export function annotateSandboxFailures(command: string, stderr: string): string {
  try {
    return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
  } catch {
    return stderr;
  }
}
