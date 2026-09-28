import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
  REASONING_HEADROOM,
} from '../../agent/providers/types.js';
import { startFakeProvider } from '../acceptance/provider.js';
import { shellNonDisponibileQui } from '../acceptance/sandbox-host.js';
import { PROBES } from './probes.js';
import {
  type AskEvent,
  buildJudgePrompt,
  JUDGE_OUTPUT_TOKENS,
  judgeCall,
  type ModelTarget,
  parseCli,
  parseJudgeOutput,
  type ReportRow,
  type RunConfig,
  renderReport,
  renderTokenReport,
  runEval,
  summarizeVerdicts,
  type ToolCallEvent,
} from './run.js';

const itWithShell = it.skipIf(shellNonDisponibileQui() !== null);

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
    expect(() => parseCli(['--provider', 'anthropic', '--api-key-env', 'X'], '/tmp/out')).toThrow(
      /--model/,
    );
    expect(() =>
      parseCli(
        ['--provider', 'anthropic', '--api-key-env', 'X', '--model', 'claude-sonnet-5'],
        '/tmp/out',
      ),
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
      [
        '--provider',
        'anthropic',
        '--api-key-env',
        'ANTHROPIC_API_KEY',
        '--models',
        'a,b,c',
        '--judge-model',
        'j',
      ],
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
    const result = parseJudgeOutput('boh, non saprei come metterlo in JSON, sinceramente', [
      'natural',
      'agentic',
    ]);
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
    expect(result[0]).toEqual({
      property: 'natural',
      verdict: 'pass',
      evidence: 'suona come una persona vera',
    });
    expect(result[1]?.verdict).toBe('unparsed');
  });

  it('tollera del testo prima/dopo il blocco JSON (un giudice che non ha resistito al commento)', () => {
    const raw = `Certo, ecco il giudizio:\n${JSON.stringify({ judgements: [{ property: 'natural', verdict: 'fail', evidence: 'suona da manuale' }] })}\ngrazie!`;
    const result = parseJudgeOutput(raw, ['natural']);
    expect(result[0]).toEqual({
      property: 'natural',
      verdict: 'fail',
      evidence: 'suona da manuale',
    });
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
          models: [
            {
              label: 'm1',
              provider: 'openai-compat',
              baseUrl: fake.baseUrl,
              model: 'm1',
              apiKeyEnv: 'MUFFIN_CHARACTER_EVAL_FAKE_KEY',
            },
          ],
          judge: {
            label: 'j1',
            provider: 'openai-compat',
            baseUrl: fake.baseUrl,
            model: 'j1',
            apiKeyEnv: 'MUFFIN_CHARACTER_EVAL_FAKE_KEY',
          },
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

describe('D13: --fake-approve non ferma il turno su un ask, e registra cosa ha chiesto', () => {
  /** Sempre `pass`: questi due test provano l'approvatore, non il giudice. */
  class GiudiceIndifferente implements Provider {
    readonly kind = 'openai-compat' as const;
    async chat(): Promise<ChatResult> {
      return {
        text: '{"judgements":[{"property":"agentic","verdict":"pass","evidence":"n/d"}]}',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'j1',
      };
    }
  }

  const scriptedAsk = [
    {
      tool: {
        name: 'shell_run_write',
        args: { command: 'echo ciao-dal-sandbox', description: 'prova D13' },
      },
    },
    { text: 'QUESTA RISPOSTA NON DEVE MAI COMPARIRE SENZA UN Sì' },
  ];

  itWithShell("senza --fake-approve: il turno si ferma sull'ask, e non scrive asks.json", async () => {
    const fake = await startFakeProvider({ main: scriptedAsk });
    process.env.MUFFIN_CHARACTER_D13_KEY = 'sk-character-eval-fake';
    const outDir = scratchOutDir();
    try {
      await runEval(
        {
          models: [
            {
              label: 'm1',
              provider: 'openai-compat',
              baseUrl: fake.baseUrl,
              model: 'm1',
              apiKeyEnv: 'MUFFIN_CHARACTER_D13_KEY',
            },
          ],
          judge: {
            label: 'j1',
            provider: 'openai-compat',
            baseUrl: fake.baseUrl,
            model: 'j1',
            apiKeyEnv: 'MUFFIN_CHARACTER_D13_KEY',
          },
          dryRun: false,
          probeIds: ['multistep-technical-task'],
          outDir,
        },
        { judgeProvider: new GiudiceIndifferente() },
      );
    } finally {
      await fake.close();
      delete process.env.MUFFIN_CHARACTER_D13_KEY;
    }
    const runDir = join(outDir, readdirSync(outDir)[0]!, 'm1');
    const transcript = readFileSync(join(runDir, 'multistep-technical-task.md'), 'utf8');
    expect(transcript).toContain('Serve la tua approvazione');
    expect(transcript).not.toContain('NON DEVE MAI COMPARIRE');
    expect(readdirSync(runDir)).not.toContain('asks.json');

    // Il registro D15 (`turns.effects`) registra ciò che è **avvenuto**, mai
    // una domanda senza risposta: un ask che nessuno approva non arriva a
    // scrivere l'intento (`agent/loop/tool-call.ts`), quindi qui è vuoto —
    // la controprova dell'assertion sotto, sullo stesso comando approvato.
    const toolCalls = JSON.parse(
      readFileSync(join(runDir, 'tool-calls.json'), 'utf8'),
    ) as ToolCallEvent[];
    expect(toolCalls).toEqual([]);
  }, 60_000);

  itWithShell("con --fake-approve: il turno passa oltre l'ask, ed esiste un asks.json con quello che ha chiesto", async () => {
    const fake = await startFakeProvider({ main: scriptedAsk });
    process.env.MUFFIN_CHARACTER_D13_KEY = 'sk-character-eval-fake';
    const outDir = scratchOutDir();
    try {
      await runEval(
        {
          models: [
            {
              label: 'm1',
              provider: 'openai-compat',
              baseUrl: fake.baseUrl,
              model: 'm1',
              apiKeyEnv: 'MUFFIN_CHARACTER_D13_KEY',
            },
          ],
          judge: {
            label: 'j1',
            provider: 'openai-compat',
            baseUrl: fake.baseUrl,
            model: 'j1',
            apiKeyEnv: 'MUFFIN_CHARACTER_D13_KEY',
          },
          dryRun: false,
          probeIds: ['multistep-technical-task'],
          outDir,
          fakeApprove: true,
        },
        { judgeProvider: new GiudiceIndifferente() },
      );
    } finally {
      await fake.close();
      delete process.env.MUFFIN_CHARACTER_D13_KEY;
    }
    const runDir = join(outDir, readdirSync(outDir)[0]!, 'm1');
    const transcript = readFileSync(join(runDir, 'multistep-technical-task.md'), 'utf8');
    expect(transcript).not.toContain('Serve la tua approvazione');
    expect(transcript).toContain('NON DEVE MAI COMPARIRE');

    const asks = JSON.parse(readFileSync(join(runDir, 'asks.json'), 'utf8')) as AskEvent[];
    expect(asks).toHaveLength(1);
    expect(asks[0]?.probeId).toBe('multistep-technical-task');
    expect(asks[0]?.capability).toBe('sys.shell.write');
    expect(asks[0]?.taint).toBe(0);

    // Approvata, quindi eseguita: il registro D15 la vede, e la marca
    // `decision: 'ask'` — passata, ma solo dopo una domanda (mai `allow` muto).
    const toolCalls = JSON.parse(
      readFileSync(join(runDir, 'tool-calls.json'), 'utf8'),
    ) as ToolCallEvent[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool).toBe('shell_run_write');
    expect(toolCalls[0]?.decision).toBe('ask');
  }, 60_000);
});

describe('confinamento: un modello remoto non legge fuori dalla home/workspace fittizia (docs/evidence/eval-fuga-filesystem-2026-09-07.md)', () => {
  class GiudiceIndifferente implements Provider {
    readonly kind = 'openai-compat' as const;
    async chat(): Promise<ChatResult> {
      return {
        text: '{"judgements":[{"property":"natural","verdict":"pass","evidence":"n/d"}]}',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'j1',
      };
    }
  }

  itWithShell('un sentinel fuori dalla home reale (iniettata) resta irraggiungibile da shell_run', async () => {
    // `realHome` sta per la vera $HOME dell'operatore: mai toccata, sostituita
    // da una directory iniettata per il test — la stessa ragione per cui
    // `mandatoryGuards` rende `userHome` iniettabile (`core/rot/guards.ts`).
    const realHome = mkdtempSync(join(tmpdir(), 'muffin-character-fake-realhome-'));
    OUT_DIRS.push(realHome);
    const sentinelPath = join(realHome, 'sentinel.txt');
    writeFileSync(sentinelPath, 'SEGRETO-CHE-NON-DEVE-MAI-USCIRE-DALLA-MACCHINA');

    const fake = await startFakeProvider({
      main: [
        { tool: { name: 'shell_run', args: { command: `cat ${sentinelPath}` } } },
        { text: 'fatto' },
      ],
    });
    process.env.MUFFIN_CHARACTER_CONFINE_KEY = 'sk-character-eval-fake';
    const outDir = scratchOutDir();
    try {
      await runEval(
        {
          models: [
            {
              label: 'm1',
              provider: 'openai-compat',
              baseUrl: fake.baseUrl,
              model: 'm1',
              apiKeyEnv: 'MUFFIN_CHARACTER_CONFINE_KEY',
            },
          ],
          judge: {
            label: 'j1',
            provider: 'openai-compat',
            baseUrl: fake.baseUrl,
            model: 'j1',
            apiKeyEnv: 'MUFFIN_CHARACTER_CONFINE_KEY',
          },
          dryRun: false,
          probeIds: ['casual-hey'],
          outDir,
          // Since ADR-0091 `shell_run` asks (whole-host reads are disclosure,
          // #645). Without an approver the turn would stop on the gate and the
          // denyRead of the real home would never be exercised — the claim
          // under test is that the *command* cannot read the sentinel, so the
          // gate is auto-passed and the ask is recorded like D13's.
          fakeApprove: true,
        },
        { judgeProvider: new GiudiceIndifferente(), realHome },
      );
    } finally {
      await fake.close();
      delete process.env.MUFFIN_CHARACTER_CONFINE_KEY;
    }
    const runDir = join(outDir, readdirSync(outDir)[0]!, 'm1');

    // Il gate c'è, ed è una domanda: da ADR-0091 la corsia in sola lettura
    // chiede quanto quella che scrive, e la domanda è registrata come ogni
    // altro ask di questo run.
    const asks = JSON.parse(readFileSync(join(runDir, 'asks.json'), 'utf8')) as AskEvent[];
    expect(asks).toHaveLength(1);
    expect(asks[0]?.capability).toBe('sys.shell');

    // `isError`, non un `toContain` sul transcript: la seconda risposta è
    // scriptata ("fatto") e non ripete mai lo stdout del comando, quindi un
    // `.md` pulito non proverebbe niente — la prova reale è che il comando
    // stesso è fallito, cioè il sandbox ha negato la lettura invece di
    // restituire i byte del sentinel. Mutazione verificata a mano: senza
    // `extraDenyRead: [realHome]` questo assert torna rosso (`isError:
    // false`, il `cat` riesce) — ripristinato dopo la conferma.
    const toolCalls = JSON.parse(
      readFileSync(join(runDir, 'tool-calls.json'), 'utf8'),
    ) as ToolCallEvent[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool).toBe('shell_run');
    expect(toolCalls[0]?.isError).toBe(true);
  }, 60_000);
});

describe('una misura persa non è un giudizio', () => {
  const rows = (verdicts: readonly ReportRow['verdict'][]): ReportRow[] =>
    verdicts.map((verdict, i) => ({
      model: 'm1',
      probe: `p${i}`,
      property: 'natural' as const,
      verdict,
      evidence: '',
    }));

  it('conta `unparsed` a parte da `n/a`, e solo `unparsed` fa fallire la corsa', () => {
    const solo_na = summarizeVerdicts(rows(['pass', 'n/a', 'n/a']));
    expect(solo_na.byModel.get('m1')).toMatchObject({
      pass: 1,
      fail: 0,
      na: 2,
      unparsed: 0,
      total: 3,
    });
    expect(solo_na.failed).toBe(false);

    const con_perse = summarizeVerdicts(rows(['pass', 'n/a', 'unparsed']));
    expect(con_perse.byModel.get('m1')).toMatchObject({ pass: 1, na: 1, unparsed: 1, total: 3 });
    expect(con_perse.unparsed).toBe(1);
    expect(con_perse.failed).toBe(true);
  });

  it('una corsa vera con un giudice che tronca al proprio tetto conta la misura persa, mai un n/a — il difetto del 27/08', async () => {
    // Il sintomo esatto della corsa del 27/08 (`JUDGE_OUTPUT_TOKENS`, sopra):
    // `stop=max_tokens` con `content` vuoto. `parseJudgeOutput` deve marcare
    // questo `unparsed` — una misura persa — e mai `n/a`, che è un giudizio
    // («questo scambio non dà materiale»), non un buco.
    class GiudiceTroncato implements Provider {
      readonly kind = 'openai-compat' as const;
      async chat(): Promise<ChatResult> {
        return {
          text: '',
          toolCalls: [],
          stopReason: 'max_tokens',
          usage: { inputTokens: 500, outputTokens: 1024, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'j1',
        };
      }
    }
    const fake = await startFakeProvider({ main: [{ text: 'Ehi.' }] });
    process.env.MUFFIN_CHARACTER_TRUNC_KEY = 'sk-character-eval-fake';
    const outDir = scratchOutDir();
    try {
      const { summary, report } = await runEval(
        {
          models: [
            {
              label: 'm1',
              provider: 'openai-compat',
              baseUrl: fake.baseUrl,
              model: 'm1',
              apiKeyEnv: 'MUFFIN_CHARACTER_TRUNC_KEY',
            },
          ],
          judge: {
            label: 'j1',
            provider: 'openai-compat',
            baseUrl: fake.baseUrl,
            model: 'j1',
            apiKeyEnv: 'MUFFIN_CHARACTER_TRUNC_KEY',
          },
          dryRun: false,
          probeIds: ['casual-hey'],
          outDir,
        },
        { judgeProvider: new GiudiceTroncato() },
      );
      // Nessuna proprietà del probe è passata per 'n/a': tutte perse, contate come tali.
      const counts = summary.byModel.get('m1');
      expect(counts?.na).toBe(0);
      expect(counts?.unparsed).toBeGreaterThan(0);
      expect(summary.unparsed).toBe(counts?.unparsed);
      // La condizione che decide l'exit code di `main()`: `summary.failed`, non una stampa.
      expect(summary.failed).toBe(true);
      expect(report).toContain('CORSA NON RIUSCITA');
      expect(report).not.toContain('n/a o non-parsato');
    } finally {
      await fake.close();
      delete process.env.MUFFIN_CHARACTER_TRUNC_KEY;
    }
  }, 60_000);

  it('il report grida le misure perse invece di sommarle agli n/a', () => {
    const models: ModelTarget[] = [
      { label: 'm1', provider: 'anthropic', model: 'm1', apiKeyEnv: 'X' },
    ];
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
  const models: ModelTarget[] = [
    { label: 'm1', provider: 'anthropic', model: 'm1', apiKeyEnv: 'X' },
  ];
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
    const report = renderTokenReport(
      [{ model: 'm1', probe: 'casual-hey', systemTokens: 100, turnTokens: 10, calls: 1 }],
      models,
    );
    expect(report).toContain('stima');
    expect(report).not.toContain('pass');
  });
});

describe('runEval --dry-run', () => {
  it('produce il report senza nessuna chiamata reale, coprendo ogni primitiva di contesto', async () => {
    const config: RunConfig = {
      models: [
        {
          label: 'dry-model',
          provider: 'anthropic',
          model: 'dry-model',
          apiKeyEnv: 'UNUSED_UNDER_DRY_RUN',
        },
      ],
      judge: null,
      dryRun: true,
      // One probe per real context primitive (memory, seeded turns, fake tool, crashed turn) plus a bare one.
      probeIds: [
        'casual-hey',
        'memory-relevant',
        'muffin-was-wrong',
        'tool-fails',
        'crash-uncertain-outcome',
      ],
      outDir: scratchOutDir(),
    };
    const { reportPath, report } = await runEval(config);
    expect(readFileSync(reportPath, 'utf8')).toBe(report);
    expect(report).toContain('stima dry-run');
    expect(report).toContain('dry-model');
    // Per-probe transcripts landed on disk, one per probe under the model's own dir.
    const modelDir = join(join(reportPath, '..'), 'dry-model');
    const files = readdirSync(modelDir).sort();
    expect(files).toEqual([
      'casual-hey.md',
      'crash-uncertain-outcome.md',
      'memory-relevant.md',
      'muffin-was-wrong.md',
      'tool-fails.md',
    ]);
    // The crash probe's template placeholder was substituted with a real describeInterrupted() line.
    const crashTranscript = readFileSync(join(modelDir, 'crash-uncertain-outcome.md'), 'utf8');
    expect(crashTranscript).not.toContain('{{CRASH_NOTE}}');
    expect(crashTranscript).toMatch(/il processo che lo eseguiva non c'è più/);
  }, 30_000);

  it('rifiuta un filtro --probes che non corrisponde a nessun id', async () => {
    const config: RunConfig = {
      models: [
        {
          label: 'dry-model',
          provider: 'anthropic',
          model: 'dry-model',
          apiKeyEnv: 'UNUSED_UNDER_DRY_RUN',
        },
      ],
      judge: null,
      dryRun: true,
      probeIds: ['non-esiste'],
      outDir: scratchOutDir(),
    };
    await expect(runEval(config)).rejects.toThrow(/nessun probe/);
  });
});
