import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JUDGE_OUTPUT_TOKENS,
  buildJudgePrompt,
  judgeCall,
  parseCli,
  parseJudgeOutput,
  renderReport,
  renderTokenReport,
  runEval,
  summarizeVerdicts,
  type ModelTarget,
  type ReportRow,
  type RunConfig,
} from './run.js';
import { REASONING_HEADROOM, type ChatCall, type ChatResult, type Provider } from '../../agent/providers/types.js';
import { startFakeProvider } from '../acceptance/provider.js';
import { PROBES } from './probes.js';

const OUT_DIRS: string[] = [];
afterEach(() => {
  for (const dir of OUT_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-character-test-out-'));
  OUT_DIRS.push(dir);
  return dir;
}

describe('parseCli', () => {
  it('richiede provider/api-key-env/model per una corsa reale, senza --config', () => {
    expect(() => parseCli([], '/tmp/out')).toThrow(/--provider/);
    expect(() => parseCli(['--provider', 'anthropic'], '/tmp/out')).toThrow(/--api-key-env/);
    expect(() => parseCli(['--provider', 'anthropic', '--api-key-env', 'X'], '/tmp/out')).toThrow(/--model/);
    expect(() =>
      parseCli(['--provider', 'anthropic', '--api-key-env', 'X', '--model', 'claude-sonnet-5'], '/tmp/out'),
    ).toThrow(/giudice/);
  });

  it('--dry-run non richiede nessun flag: usa i due modelli di default e nessun giudice', () => {
    const config = parseCli(['--dry-run'], '/tmp/out');
    expect(config.dryRun).toBe(true);
    expect(config.judge).toBeNull();
    expect(config.models.length).toBe(2);
    expect(config.models.every((m) => m.apiKeyEnv === 'UNUSED_UNDER_DRY_RUN')).toBe(true);
  });

  it('--models accetta una lista, --provider/--api-key-env condivisi, --judge-model esplicito', () => {
    const config = parseCli(
      ['--provider', 'anthropic', '--api-key-env', 'ANTHROPIC_API_KEY', '--models', 'a,b,c', '--judge-model', 'j'],
      '/tmp/out',
    );
    expect(config.models.map((m) => m.model)).toEqual(['a', 'b', 'c']);
    expect(config.models.every((m) => m.apiKeyEnv === 'ANTHROPIC_API_KEY')).toBe(true);
    expect(config.judge?.model).toBe('j');
  });

  it('--probes filtra per id, separati da virgola', () => {
    const config = parseCli(['--dry-run', '--probes', 'casual-hey, tool-fails'], '/tmp/out');
    expect(config.probeIds).toEqual(['casual-hey', 'tool-fails']);
  });

  it('non legge mai ~/.muffin: fallisce con messaggio chiaro senza --config esplicito, e non tocca MUFFIN_HOME', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'muffin-character-guard-'));
    const prevHome = process.env['MUFFIN_HOME'];
    process.env['MUFFIN_HOME'] = emptyHome;
    try {
      expect(() => parseCli([], '/tmp/out')).toThrow();
    } finally {
      if (prevHome === undefined) delete process.env['MUFFIN_HOME'];
      else process.env['MUFFIN_HOME'] = prevHome;
      // The guard is structural (parseCli never reads MUFFIN_HOME/paths()), so the
      // directory this test pointed it at must still be exactly as empty as it started.
      const left = readdirSync(emptyHome);
      rmSync(emptyHome, { recursive: true, force: true });
      expect(left).toEqual([]);
    }
  });
});

describe('parseJudgeOutput — tollerante a output non-JSON', () => {
  it('marca ogni proprietà "unparsed" quando il giudice non risponde JSON', () => {
    const result = parseJudgeOutput('boh, non saprei come metterlo in JSON, sinceramente', ['natural', 'agentic']);
    expect(result).toEqual([
      { property: 'natural', verdict: 'unparsed', evidence: expect.any(String) },
      { property: 'agentic', verdict: 'unparsed', evidence: expect.any(String) },
    ]);
  });

  it('marca "unparsed" anche un JSON valido ma privo del campo judgements', () => {
    const result = parseJudgeOutput('{"foo": "bar"}', ['natural']);
    expect(result[0]?.verdict).toBe('unparsed');
  });

  it('legge un giudizio pass/fail/n-a valido, e cade su "unparsed" per un verdetto fuori enum', () => {
    const raw = JSON.stringify({
      judgements: [
        { property: 'natural', verdict: 'pass', evidence: 'suona come una persona vera' },
        { property: 'agentic', verdict: 'quasi', evidence: 'boh' },
      ],
    });
    const result = parseJudgeOutput(raw, ['natural', 'agentic']);
    expect(result[0]).toEqual({ property: 'natural', verdict: 'pass', evidence: 'suona come una persona vera' });
    expect(result[1]?.verdict).toBe('unparsed');
  });

  it('tollera del testo prima/dopo il blocco JSON (un giudice che non ha resistito al commento)', () => {
    const raw = `Certo, ecco il giudizio:\n${JSON.stringify({ judgements: [{ property: 'natural', verdict: 'fail', evidence: 'suona da manuale' }] })}\ngrazie!`;
    const result = parseJudgeOutput(raw, ['natural']);
    expect(result[0]).toEqual({ property: 'natural', verdict: 'fail', evidence: 'suona da manuale' });
  });
});

describe('buildJudgePrompt — mai il system prompt di Muffin', () => {
  it('include solo la trascrizione e le definizioni di rubrica del probe, dichiara esplicitamente di non avere il prompt', () => {
    const probe = PROBES.find((p) => p.id === 'weak-technical-choice');
    if (!probe) throw new Error('fixture: probe weak-technical-choice non trovato');
    const { system, user } = buildJudgePrompt(probe, 'owner: ciao\n\nagente: ciao a te');
    expect(system).toMatch(/non hai il prompt di sistema/i);
    expect(user).toContain('owner: ciao');
    for (const property of probe.properties) expect(user).toContain(property);
  });
});

/**
 * La quarta corsia che chiede JSON e non legge prosa — le prime tre stanno in
 * `core/memory/corsie-senza-reasoning.test.ts`, e questa era rimasta indietro.
 *
 * Misura sull'installazione dell'owner del 27/08, `qwen/qwen3.8-27b` giudice di
 * sé stesso sulla trascrizione di `memory-relevant`, 6 giri per variante: col
 * tetto secco di 1024 e nessun `thinking`, uscita 652–1024 token e
 * `stop=max_tokens` in 3 giri su 6 (due con `content` vuoto, uno troncato a metà
 * JSON); con `thinking: 'off'` e il margine, uscita 147–294 token e zero giri
 * persi.
 */
describe('il giudice non paga un reasoning che nessuno legge', () => {
  it('la ChatCall del giudice chiede di non ragionare e si lascia il margine', () => {
    const call = judgeCall('j1', { system: 's', user: 'u' });
    expect(call.thinking).toBe('off');
    // Il margine, non solo lo spegnimento: `thinking: 'off'` viaggia solo dove
    // l'endpoint capisce il campo (openrouter.ai), e un giudice dietro Ollama o
    // un giudice Anthropic resta senza. Vedi `REASONING_HEADROOM`.
    expect(call.maxOutputTokens).toBe(JUDGE_OUTPUT_TOKENS);
    expect(call.maxOutputTokens).toBeGreaterThanOrEqual(1024 + REASONING_HEADROOM);
  });

  it('la corsa vera passa proprio quella ChatCall al giudice, e conserva la sua risposta grezza', async () => {
    class GiudiceRegistra implements Provider {
      readonly kind = 'openai-compat' as const;
      readonly seen: ChatCall[] = [];
      async chat(request: ChatCall): Promise<ChatResult> {
        this.seen.push(request);
        return {
          text: '{"judgements":[{"property":"natural","verdict":"pass","evidence":"ok"}]}',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'j1',
        };
      }
    }
    const giudice = new GiudiceRegistra();
    const fake = await startFakeProvider({ main: [{ text: 'Ehi.' }] });
    process.env.MUFFIN_CHARACTER_EVAL_FAKE_KEY = 'sk-character-eval-fake';
    const outDir = scratchOutDir();
    try {
      await runEval(
        {
          models: [{ label: 'm1', provider: 'openai-compat', baseUrl: fake.baseUrl, model: 'm1', apiKeyEnv: 'MUFFIN_CHARACTER_EVAL_FAKE_KEY' }],
          judge: { label: 'j1', provider: 'openai-compat', baseUrl: fake.baseUrl, model: 'j1', apiKeyEnv: 'MUFFIN_CHARACTER_EVAL_FAKE_KEY' },
          dryRun: false,
          probeIds: ['casual-hey'],
          outDir,
        },
        { judgeProvider: giudice },
      );
    } finally {
      await fake.close();
      delete process.env.MUFFIN_CHARACTER_EVAL_FAKE_KEY;
    }
    expect(giudice.seen).toHaveLength(1);
    expect(giudice.seen[0]?.thinking).toBe('off');
    expect(giudice.seen[0]?.maxOutputTokens).toBe(JUDGE_OUTPUT_TOKENS);

    // La prova del proprio fallimento non si butta: la risposta grezza sta
    // accanto al verdetto, con lo `stopReason` che è il campo con cui la causa
    // dei 30 `unparsed` del 27/08 si è lasciata nominare.
    const runDir = join(outDir, readdirSync(outDir)[0]!, 'm1');
    const grezzo = JSON.parse(readFileSync(join(runDir, 'casual-hey.judge.raw.json'), 'utf8')) as {
      raw: string;
      stopReason: string;
      usage: { outputTokens: number };
    };
    expect(grezzo.raw).toContain('judgements');
    expect(grezzo.stopReason).toBe('end');
    expect(grezzo.usage.outputTokens).toBe(4);
  }, 60_000);
});

describe('una misura persa non è un giudizio', () => {
  const rows = (verdicts: readonly ReportRow['verdict'][]): ReportRow[] =>
    verdicts.map((verdict, i) => ({ model: 'm1', probe: `p${i}`, property: 'natural' as const, verdict, evidence: '' }));

  it('conta `unparsed` a parte da `n/a`, e solo `unparsed` fa fallire la corsa', () => {
    const solo_na = summarizeVerdicts(rows(['pass', 'n/a', 'n/a']));
    expect(solo_na.byModel.get('m1')).toMatchObject({ pass: 1, fail: 0, na: 2, unparsed: 0, total: 3 });
    expect(solo_na.failed).toBe(false);

    const con_perse = summarizeVerdicts(rows(['pass', 'n/a', 'unparsed']));
    expect(con_perse.byModel.get('m1')).toMatchObject({ pass: 1, na: 1, unparsed: 1, total: 3 });
    expect(con_perse.unparsed).toBe(1);
    expect(con_perse.failed).toBe(true);
  });

  it('il report grida le misure perse invece di sommarle agli n/a', () => {
    const models: ModelTarget[] = [{ label: 'm1', provider: 'anthropic', model: 'm1', apiKeyEnv: 'X' }];
    const judge: ModelTarget = { label: 'j1', provider: 'anthropic', model: 'j1', apiKeyEnv: 'X' };
    const report = renderReport(rows(['pass', 'n/a', 'unparsed']), models, judge);
    // La forma che la sintesi del 27/08 aveva e che leggeva come un successo.
    expect(report).not.toContain('n/a o non-parsato');
    expect(report).toContain('CORSA NON RIUSCITA');
    expect(report).toContain('2/3 misure giudicate');
    expect(report).toContain('1 misure perse su 3');
    expect(report).toContain('1 misure PERSE');

    const pulito = renderReport(rows(['pass', 'n/a']), models, judge);
    expect(pulito).not.toContain('CORSA NON RIUSCITA');
    expect(pulito).toContain('Nessuna misura persa');
  });
});

describe('report rendering', () => {
  const models: ModelTarget[] = [{ label: 'm1', provider: 'anthropic', model: 'm1', apiKeyEnv: 'X' }];
  const judge: ModelTarget = { label: 'j1', provider: 'anthropic', model: 'j1', apiKeyEnv: 'X' };

  it('renderReport include una colonna "Revisione umana" vuota per riga', () => {
    const report = renderReport(
      [{ model: 'm1', probe: 'casual-hey', property: 'natural', verdict: 'pass', evidence: 'ok' }],
      models,
      judge,
    );
    expect(report).toContain('Revisione umana');
    expect(report).toMatch(/\| casual-hey \| natural \| m1 \| pass \| ok \|\s*\|/);
  });

  it('renderTokenReport dichiara la stima grezza e non menziona verdetti', () => {
    const report = renderTokenReport([{ model: 'm1', probe: 'casual-hey', systemTokens: 100, turnTokens: 10, calls: 1 }], models);
    expect(report).toContain('stima');
    expect(report).not.toContain('pass');
  });
});

describe('runEval --dry-run', () => {
  it('produce il report senza nessuna chiamata reale, coprendo ogni primitiva di contesto', async () => {
    const config: RunConfig = {
      models: [{ label: 'dry-model', provider: 'anthropic', model: 'dry-model', apiKeyEnv: 'UNUSED_UNDER_DRY_RUN' }],
      judge: null,
      dryRun: true,
      // One probe per real context primitive (memory, seeded turns, fake tool, crashed turn) plus a bare one.
      probeIds: ['casual-hey', 'memory-relevant', 'muffin-was-wrong', 'tool-fails', 'crash-uncertain-outcome'],
      outDir: scratchOutDir(),
    };
    const { reportPath, report } = await runEval(config);
    expect(readFileSync(reportPath, 'utf8')).toBe(report);
    expect(report).toContain('stima dry-run');
    expect(report).toContain('dry-model');
    // Per-probe transcripts landed on disk, one per probe under the model's own dir.
    const modelDir = join(join(reportPath, '..'), 'dry-model');
    const files = readdirSync(modelDir).sort();
    expect(files).toEqual(['casual-hey.md', 'crash-uncertain-outcome.md', 'memory-relevant.md', 'muffin-was-wrong.md', 'tool-fails.md']);
    // The crash probe's template placeholder was substituted with a real describeInterrupted() line.
    const crashTranscript = readFileSync(join(modelDir, 'crash-uncertain-outcome.md'), 'utf8');
    expect(crashTranscript).not.toContain('{{CRASH_NOTE}}');
    expect(crashTranscript).toMatch(/il processo che lo eseguiva non c'è più/);
  }, 30_000);

  it('rifiuta un filtro --probes che non corrisponde a nessun id', async () => {
    const config: RunConfig = {
      models: [{ label: 'dry-model', provider: 'anthropic', model: 'dry-model', apiKeyEnv: 'UNUSED_UNDER_DRY_RUN' }],
      judge: null,
      dryRun: true,
      probeIds: ['non-esiste'],
      outDir: scratchOutDir(),
    };
    await expect(runEval(config)).rejects.toThrow(/nessun probe/);
  });
});
