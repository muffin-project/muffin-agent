import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerificationResult } from '../agent/providers/verify.js';
import { runInit } from './init.js';
import { runDoctor, type Check } from './doctor.js';

/**
 * Wiring falsifiers for #523 (J/K + doctor half of M).
 *
 * - J: plain `doctor` never performs network inference (stays offline/no-cost
 *   even when a probe is injectable).
 * - K: `doctor --online` uses the SAME primitive onboarding will use — the
 *   injected `verifyInference` — and renders its verdict, not its own.
 * - M (doctor half): rendered checks never carry secret material.
 */

const CANARY = 'CANARY-DOCTOR-4d2c1b8a0f7e';

function home(secret = 'sk-never-called'): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-doctor-online-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: secret });
  return dir;
}

afterEach(() => vi.unstubAllEnvs());

const inference = async (dir: string, options: Parameters<typeof runDoctor>[1]): Promise<Check | undefined> =>
  (await runDoctor(dir, options)).checks.find((c) => c.name === 'inference');

function working(): VerificationResult {
  return {
    status: 'working',
    provider: 'openai-compat',
    requestedModel: 'openrouter/free',
    resolvedModel: 'qwen/qwen3-235b-a22b-2507',
    capability: { completion: 'pass', toolCall: 'pass' },
    diagnostic: 'openrouter/free answered the probe tool call as qwen/qwen3-235b-a22b-2507',
    observedAt: new Date(0).toISOString(),
    durationMs: 123,
  };
}

describe('doctor offline stays offline (J)', () => {
  it('never calls the inference probe without --online', async () => {
    const dir = home();
    try {
      let calls = 0;
      const report = await runDoctor(dir, {
        verifyInference: async () => {
          calls += 1;
          return working();
        },
      });
      expect(calls).toBe(0);
      expect(report.checks.some((c) => c.name === 'inference')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('performs no inference by default (no probe wired, no network)', async () => {
    const dir = home();
    try {
      const report = await runDoctor(dir);
      expect(report.checks.some((c) => c.name === 'inference')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor --online renders the shared primitive (K)', () => {
  it('calls the primitive exactly once and reports the observed working route', async () => {
    const dir = home();
    try {
      let calls = 0;
      const check = await inference(dir, {
        online: true,
        verifyInference: async () => {
          calls += 1;
          return working();
        },
      });
      expect(calls).toBe(1);
      expect(check?.level).toBe('ok');
      expect(check?.detail).toContain('openrouter/free');
      expect(check?.detail).toContain('qwen/qwen3-235b-a22b-2507');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders incompatible as incompatible, never as reachable', async () => {
    const dir = home();
    try {
      const check = await inference(dir, {
        online: true,
        verifyInference: async () => ({
          ...working(),
          status: 'incompatible',
          capability: { completion: 'pass', toolCall: 'fail' },
          diagnostic: 'route answered in prose without the required probe tool call',
          remedy: 'pick a route that supports tool calls',
        }),
      });
      expect(check?.level).toBe('fail');
      expect(check?.detail).toContain('incompatible');
      expect(check?.detail.toLowerCase()).not.toContain('reachab');
      expect(check?.remedy).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders auth failures as fail with an actionable remedy', async () => {
    const dir = home();
    try {
      const check = await inference(dir, {
        online: true,
        verifyInference: async () => ({
          status: 'auth_failed',
          provider: 'openai-compat',
          requestedModel: 'openrouter/some-model',
          capability: { completion: 'fail', toolCall: 'fail' },
          diagnostic: 'endpoint rejected the credential (401) for openrouter/some-model',
          remedy: 'check the stored key (never printed) and rotate it with `muffin secret set`',
          observedAt: new Date(0).toISOString(),
          durationMs: 45,
        }),
      });
      expect(check?.level).toBe('fail');
      expect(check?.detail).toContain('auth_failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor --online never leaks secrets (M)', () => {
  it('no rendered check carries the stored canary, whatever the probe verdict', async () => {
    const dir = home(CANARY);
    try {
      for (const verdict of ['working', 'auth_failed', 'provider_error'] as const) {
        const report = await runDoctor(dir, {
          online: true,
          verifyInference: async () => ({
            ...working(),
            status: verdict,
            diagnostic: `probe verdict ${verdict}`,
          }),
        });
        expect(JSON.stringify(report)).not.toContain(CANARY);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
