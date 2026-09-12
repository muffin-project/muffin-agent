import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SandboxProbe } from '../core/sandbox/probe.js';
import {
  askLocalOrApi,
  askModelChoice,
  chooseProvider,
  describeModelChoice,
  describeProviderChoice,
  describeSandboxProbe,
  describeSupervisor,
  inferProvider,
  isOpenRouterKey,
  keyHint,
  localModelChoices,
  looksLikeTelegramToken,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_FAMILIES,
  probeLocalRuntime,
} from './onboarding.js';

/** A writable/readable pair that claims to be a TTY, so the prompts engage — same fixture as cli/prompt.test.ts. */
function fakeTty(): { input: NodeJS.ReadStream; output: NodeJS.WriteStream } {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream;
  return { input, output };
}

/**
 * A local OpenAI-compatible server, real but loopback-only — the owner's own
 * rule for this probe ("mai rete vera"). Answers any GET with an OpenAI
 * `/models` body; a caller that wants "nothing listening" or "never answers"
 * builds those cases directly instead of using this helper.
 */
function fakeModelsServer(models: string[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id, object: 'model' })) }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('provider inference from key shape', () => {
  it('reads an OpenRouter key as the openai-compat gateway', () => {
    expect(isOpenRouterKey('sk-or-v1-abc123')).toBe(true);
    expect(inferProvider('sk-or-v1-abc123')).toBe('openai-compat');
  });

  it('reads an Anthropic key as anthropic direct', () => {
    expect(isOpenRouterKey('sk-ant-api03-xyz')).toBe(false);
    expect(inferProvider('sk-ant-api03-xyz')).toBe('anthropic');
  });

  it('does not guess an unknown prefix, leaving the default to the caller', () => {
    expect(inferProvider('xoxb-not-a-model-key')).toBeUndefined();
    expect(inferProvider(undefined)).toBeUndefined();
  });
});

describe('telegram bot token detection', () => {
  it('flags a telegram bot token shape (the real mistake that hit onboarding)', () => {
    expect(looksLikeTelegramToken('8712345678:AAExampleBotTokenLooksLikeThis_abcdef')).toBe(true);
  });

  it('does not flag real model keys or empties', () => {
    expect(looksLikeTelegramToken('sk-or-v1-abc')).toBe(false);
    expect(looksLikeTelegramToken('sk-ant-api03-xyz')).toBe(false);
    expect(looksLikeTelegramToken(undefined)).toBe(false);
  });
});

describe('key hint', () => {
  it('points an OpenRouter user at the keys page', () => {
    expect(keyHint('openai-compat', undefined)).toContain('openrouter.ai/keys');
    expect(keyHint(undefined, OPENROUTER_BASE_URL)).toContain('openrouter.ai/keys');
  });

  it('points an Anthropic user at the console', () => {
    expect(keyHint('anthropic', undefined)).toContain('console.anthropic.com');
  });

  it('offers both routes when the provider is not yet known', () => {
    const hint = keyHint(undefined, undefined);
    expect(hint).toContain('sk-or-');
    expect(hint).toContain('sk-ant-');
  });
});

describe('chooseProvider — the decision cmdInit used to make in two different places', () => {
  it('an explicit --provider always wins, and never auto-fills a base URL', () => {
    // Regression for the bug ADR-0036 named: `firstRun()` → `cmdInit([])` →
    // `runInit` used to see `options.provider ?? 'anthropic'` with nothing
    // upstream ever having looked at the key — this is the function that now
    // owns that decision, called exactly where the bug lived.
    const choice = chooseProvider('anthropic', 'sk-or-v1-should-be-ignored', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'explicit' });
  });

  it('an explicit --provider openai-compat still needs an explicit --base-url', () => {
    // Preserves the original asymmetry: only *inference* auto-fills the
    // OpenRouter URL. An owner who names the provider by hand is trusted to
    // name a non-default endpoint by hand too.
    const choice = chooseProvider('openai-compat', 'sk-or-v1-abc', undefined);
    expect(choice.baseUrl).toBeUndefined();
  });

  it('infers openai-compat from an OpenRouter key and fills its base URL', () => {
    const choice = chooseProvider(undefined, 'sk-or-v1-abc123', undefined);
    expect(choice).toEqual({ provider: 'openai-compat', baseUrl: OPENROUTER_BASE_URL, reason: 'inferred' });
  });

  it('an explicit --base-url overrides the inferred OpenRouter default', () => {
    const choice = chooseProvider(undefined, 'sk-or-v1-abc123', 'https://my-proxy.example.com/v1');
    expect(choice).toEqual({
      provider: 'openai-compat',
      baseUrl: 'https://my-proxy.example.com/v1',
      reason: 'inferred',
    });
  });

  it('infers anthropic from an Anthropic key, with no base URL to fill', () => {
    const choice = chooseProvider(undefined, 'sk-ant-api03-xyz', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'inferred' });
  });

  it('falls back to anthropic when there is a key but its prefix is unknown', () => {
    const choice = chooseProvider(undefined, 'xoxb-not-a-model-key', undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'default' });
  });

  it('falls back to anthropic when there is no key at all yet', () => {
    const choice = chooseProvider(undefined, undefined, undefined);
    expect(choice).toEqual({ provider: 'anthropic', baseUrl: undefined, reason: 'default' });
  });

  it('inference works the same whether the key is fresh or already stored — the fix ADR-0039 wired for the persisted key', () => {
    // `cmdInit` computes the same `keyForInference` regardless of source; this
    // is the property that made the fix apply to both paths without a second
    // branch of logic.
    const fresh = chooseProvider(undefined, 'sk-or-v1-fresh', undefined);
    const stored = chooseProvider(undefined, 'sk-or-v1-stored-and-reread-from-disk', undefined);
    expect(fresh.provider).toBe('openai-compat');
    expect(stored.provider).toBe('openai-compat');
  });
});

describe('describeProviderChoice — say what was inferred, never decide silently', () => {
  it('announces an explicit provider', () => {
    const line = describeProviderChoice({ provider: 'anthropic', baseUrl: undefined, reason: 'explicit' }, 'sk-ant-x');
    expect(line).toContain('anthropic');
    expect(line).toContain('--provider');
  });

  it('announces an inferred openai-compat provider with its base URL, and shows only the prefix of the key', () => {
    const choice = { provider: 'openai-compat' as const, baseUrl: OPENROUTER_BASE_URL, reason: 'inferred' as const };
    const line = describeProviderChoice(choice, 'sk-or-v1-the-real-secret-must-not-appear');
    expect(line).toContain('openai-compat');
    expect(line).toContain(OPENROUTER_BASE_URL);
    expect(line).toContain('dedotto');
    expect(line).not.toContain('the-real-secret-must-not-appear');
  });

  it('announces an inferred anthropic provider', () => {
    const choice = { provider: 'anthropic' as const, baseUrl: undefined, reason: 'inferred' as const };
    expect(describeProviderChoice(choice, 'sk-ant-x')).toContain('dedotto');
  });

  it('names the unrecognised key as the reason for the default, distinct from having no key at all', () => {
    const choice = { provider: 'anthropic' as const, baseUrl: undefined, reason: 'default' as const };
    const withKey = describeProviderChoice(choice, 'xoxb-unknown-shape');
    const withoutKey = describeProviderChoice(choice, undefined);
    expect(withKey).not.toBe(withoutKey);
    expect(withKey).toMatch(/non è sk-or|non.*dedurre|default/);
    expect(withoutKey).toContain('nessuna chiave');
  });

  it('announces a local runtime the same way it announces an inferred key — no key, still said out loud', () => {
    const choice = { provider: 'openai-compat' as const, baseUrl: 'http://127.0.0.1:11434/v1', reason: 'local' as const };
    const line = describeProviderChoice(choice, undefined);
    expect(line).toContain('openai-compat');
    expect(line).toContain('http://127.0.0.1:11434/v1');
    expect(line).toMatch(/locale/);
  });
});

describe('describeSupervisor — named before offerGateway asks, not just implied by it', () => {
  it('names launchd on darwin', () => {
    expect(describeSupervisor('darwin')).toContain('launchd');
  });

  it('names systemd everywhere else — matches planUnit routing every non-darwin platform to systemd', () => {
    expect(describeSupervisor('linux')).toContain('systemd');
  });
});

describe('describeSandboxProbe — the probe said in full during init, not only in doctor', () => {
  it('is a single ok line when the probe held', () => {
    const probe: SandboxProbe = { available: true, mechanism: 'seatbelt' };
    const line = describeSandboxProbe(probe);
    expect(line).toContain('✓');
    expect(line).toContain('seatbelt');
  });

  it('prints the reason and the full remedy on failure — not a summary', () => {
    const probe: SandboxProbe = {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'binary_missing',
      detail: 'bwrap: ENOENT',
      remedy: 'install bubblewrap and socat',
    };
    const line = describeSandboxProbe(probe);
    expect(line).toContain('bwrap: ENOENT');
    expect(line).toContain('install bubblewrap and socat');
  });

  it('userns_denied prints the AppArmor remedy in full, plus a note that init will not run sudo for you', () => {
    // ADR-0018's field note, verbatim: this fix "va nell'installer, non nella
    // documentazione che nessuno legge" — the regression this test guards is
    // the remedy going missing from init and only ever showing up in doctor.
    const probe: SandboxProbe = {
      available: false,
      mechanism: 'bubblewrap',
      reason: 'userns_denied',
      detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
      remedy:
        'unprivileged user namespaces are restricted (Ubuntu 24.04+ default). ' +
        'Add an AppArmor profile for bwrap granting `userns` and reload it with apparmor_parser -r; ' +
        'lowering kernel.apparmor_restrict_unprivileged_userns works too but disarms the protection host-wide',
    };
    const line = describeSandboxProbe(probe);
    expect(line).toContain('apparmor_parser -r');
    expect(line).toContain('kernel.apparmor_restrict_unprivileged_userns');
    expect(line.toLowerCase()).toContain('sudo');
    expect(line).toContain('init non lo esegue da solo');
  });
});

describe('probeLocalRuntime — real loopback server, never the network', () => {
  it('finds a runtime and lists its models', async () => {
    const fake = await fakeModelsServer(['qwen3-local', 'llama3.2']);
    try {
      const probe = await probeLocalRuntime(fake.baseUrl);
      expect(probe).toEqual({ available: true, baseUrl: fake.baseUrl, models: ['qwen3-local', 'llama3.2'] });
    } finally {
      await fake.close();
    }
  });

  it('reads as unavailable when nothing is listening — "fallito = semplicemente non proposto"', async () => {
    // A port just closed: nothing answers, and the failure must not throw —
    // it is meant to be silently absorbed into "not proposed".
    const fake = await fakeModelsServer([]);
    const { baseUrl } = fake;
    await fake.close();
    const probe = await probeLocalRuntime(baseUrl, 500);
    expect(probe).toEqual({ available: false, baseUrl });
  });

  it('times out quickly instead of hanging init on a server that never answers', async () => {
    const server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
    try {
      const started = Date.now();
      const probe = await probeLocalRuntime(baseUrl, 200);
      expect(probe).toEqual({ available: false, baseUrl });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('askLocalOrApi — the local-or-API question, asked only once a probe found something', () => {
  it('an empty answer (Enter) accepts the local runtime — it was just detected and costs nothing', async () => {
    const { input, output } = fakeTty();
    const pending = askLocalOrApi({ available: true, baseUrl: 'http://127.0.0.1:11434/v1', models: ['a'] }, input, output);
    input.write('\n');
    await expect(pending).resolves.toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', models: ['a'] });
  });

  it('"y" also accepts, same convention offerGateway already uses for its Y/n', async () => {
    const { input, output } = fakeTty();
    const pending = askLocalOrApi({ available: true, baseUrl: 'http://127.0.0.1:11434/v1', models: [] }, input, output);
    input.write('y\n');
    await expect(pending).resolves.toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', models: [] });
  });

  it('"n" declines — the caller falls through to the ordinary API-key prompt', async () => {
    const { input, output } = fakeTty();
    const pending = askLocalOrApi({ available: true, baseUrl: 'http://127.0.0.1:11434/v1', models: [] }, input, output);
    input.write('n\n');
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('askModelChoice — one numbered menu, reused for OpenRouter families and a local model list', () => {
  it('an empty answer accepts the first entry — the proposed default', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice(OPENROUTER_MODEL_FAMILIES, 'header', input, output);
    input.write('\n');
    await expect(pending).resolves.toEqual({ main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.7-flash' });
  });

  it('a listed number picks that family — API con famiglia scelta', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice(OPENROUTER_MODEL_FAMILIES, 'header', input, output);
    input.write('3\n'); // GPT
    await expect(pending).resolves.toEqual({ main: 'openai/gpt-5.6-terra', light: 'openai/gpt-5-nano' });
  });

  it('can choose the OpenRouter Free router by number', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice(OPENROUTER_MODEL_FAMILIES, 'header', input, output);
    input.write('5\n');
    await expect(pending).resolves.toEqual({ main: 'openrouter/free', light: 'openrouter/free' });
  });

  it('unrecognised text is taken as a model id typed by hand — "altro" is not a second prompt', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice(OPENROUTER_MODEL_FAMILIES, 'header', input, output);
    input.write('my-org/my-custom-model\n');
    await expect(pending).resolves.toEqual({ main: 'my-org/my-custom-model', light: 'my-org/my-custom-model' });
  });

  it('a number outside the list is treated the same way — as typed text, not an error', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice(OPENROUTER_MODEL_FAMILIES, 'header', input, output);
    input.write('99\n');
    await expect(pending).resolves.toEqual({ main: '99', light: '99' });
  });

  it('a local runtime with models listed numbers them, one id serving both main and light', async () => {
    const { input, output } = fakeTty();
    const choices = localModelChoices(['qwen3-local', 'llama3.2']);
    const pending = askModelChoice(choices, 'header', input, output);
    input.write('2\n');
    await expect(pending).resolves.toEqual({ main: 'llama3.2', light: 'llama3.2' });
  });

  it('an empty model list (runtime up, nothing pulled) asks directly instead of printing an empty menu', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice([], 'header', input, output);
    input.write('my-model\n');
    await expect(pending).resolves.toEqual({ main: 'my-model', light: 'my-model' });
  });

  it('an empty answer against an empty model list keeps the compiled default — nothing to accept', async () => {
    const { input, output } = fakeTty();
    const pending = askModelChoice([], 'header', input, output);
    input.write('\n');
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('OPENROUTER_MODEL_FAMILIES — the owner\'s verbatim default first', () => {
  it('Qwen is first, with the exact ids the owner is actually running', () => {
    expect(OPENROUTER_MODEL_FAMILIES[0]).toEqual({
      label: 'Qwen',
      main: 'qwen/qwen3.8-27b',
      light: 'qwen/qwen3.7-flash',
    });
  });

  it('offers the existing families plus the provider router as an explicit opt-in', () => {
    expect(OPENROUTER_MODEL_FAMILIES.length).toBe(5);
    expect(OPENROUTER_MODEL_FAMILIES.find((f) => f.label === 'OpenRouter Free')).toEqual({
      label: 'OpenRouter Free',
      main: 'openrouter/free',
      light: 'openrouter/free',
    });
  });

  it('Anthropic mirrors defaultModels\' own compat pair — picking it changes nothing silently', () => {
    const anthropic = OPENROUTER_MODEL_FAMILIES.find((f) => f.label === 'Anthropic');
    expect(anthropic).toEqual({ label: 'Anthropic', main: 'anthropic/claude-sonnet-5', light: 'anthropic/claude-haiku-4.5' });
  });
});

describe('describeModelChoice — what defaultModels resolved to, said the way describeProviderChoice already does', () => {
  it('names an explicit flag', () => {
    const line = describeModelChoice('a', 'b', 'explicit');
    expect(line).toContain('--model');
  });

  it('names a model just chosen interactively', () => {
    expect(describeModelChoice('a', 'b', 'chosen')).toContain('scelti ora');
  });

  it('names the compiled default even headless — the print is unconditional', () => {
    const line = describeModelChoice('claude-sonnet-5', 'claude-haiku-4-5-20251001', 'default');
    expect(line).toContain('claude-sonnet-5');
    expect(line).toContain('default compilato');
  });
});
