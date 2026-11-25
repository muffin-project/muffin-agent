import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredProvider } from '../agent/providers/configured.js';
import { inferenceChain, loadConfig } from '../core/config/config.js';
import { cmdFallback } from './fallback.js';
import { runInit } from './init.js';

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-fallback-cli-'));
  runInit({ home, provider: 'openai-compat', apiKey: 'unused-synthetic-key' });
  const lines: string[] = [];
  return {
    home,
    lines,
    run: (...argv: string[]) => cmdFallback(home, argv, { out: (l) => lines.push(l) }),
  };
}

describe('muffin fallback', () => {
  it('adds catalog links in order, per lane, without typing endpoints or secret names', () => {
    const { home, lines, run } = fresh();
    expect(run('add', 'xai', 'grok-4.7')).toBe(0);
    expect(run('add', 'openrouter', 'openrouter/free')).toBe(0);
    expect(run('add', 'openrouter', 'openrouter/free', '--light')).toBe(0);
    const config = loadConfig(home);
    expect(inferenceChain(config, 'main').map((l) => [l.provider.baseUrl, l.model])).toEqual([
      [config.provider.baseUrl, config.models.main],
      ['https://api.x.ai/v1', 'grok-4.7'],
      ['https://openrouter.ai/api/v1', 'openrouter/free'],
    ]);
    expect(config.fallbacks?.main?.[0]?.provider.apiKeyRef).toBe('secret://xai_api_key');
    expect(config.fallbacks?.light).toHaveLength(1);
    expect(lines.join('\n')).toContain('manca la credenziale: muffin secret set xai_api_key');
    expect(lines.join('\n')).toContain('la spesa conta nei tetti di budget');
  });

  it('a second account of the same provider is its own link', () => {
    const { home, run } = fresh();
    expect(run('add', 'openrouter', 'some/model', '--account', 'work')).toBe(0);
    expect(loadConfig(home).fallbacks?.main?.[0]?.provider.apiKeyRef).toBe(
      'secret://openrouter_api_key_work',
    );
  });

  it('lists the chain with position, label and missing credentials', () => {
    const { lines, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    lines.length = 0;
    expect(run()).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/main:\n {2}1\. .* — attivo/);
    expect(text).toContain(
      '2. xAI API · grok-4.7 — credenziale mancante → muffin secret set xai_api_key',
    );
  });

  it('removes by provider or by printed position; position 1 belongs to `muffin model`', () => {
    const { home, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    run('add', 'openrouter', 'openrouter/free');
    expect(run('remove', '1')).toBe(2);
    expect(run('remove', 'xai')).toBe(0);
    expect(loadConfig(home).fallbacks?.main?.map((l) => l.model)).toEqual(['openrouter/free']);
    expect(run('remove', '2')).toBe(0);
    expect(loadConfig(home).fallbacks).toBeUndefined();
  });

  it('refuses unknown providers and duplicates without writing', () => {
    const { home, run } = fresh();
    expect(run('add', 'nope', 'x')).toBe(2);
    run('add', 'xai', 'grok-4.7');
    expect(run('add', 'xai', 'grok-4.7')).toBe(0);
    expect(loadConfig(home).fallbacks?.main).toHaveLength(1);
  });

  it('a fallback with no secret yet does not stop the lane from being built', () => {
    const { home, run } = fresh();
    run('add', 'xai', 'grok-4.7');
    writeFileSync(join(home, 'secrets', 'unrelated'), 'x', { mode: 0o600 });
    expect(() => configuredProvider(loadConfig(home), home, undefined, 'main')).not.toThrow();
  });
});
