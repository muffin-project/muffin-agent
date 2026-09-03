import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_MISSING_ENV, MissingApiKey, runEval, type RunConfig } from './run.js';
import { PROBES } from './probes.js';
import { buildSystemPromptBlocks, renderSystemPrompts } from '../../agent/context/assemble.js';
import { buildRuntime } from '../../agent/runtime.js';
import { startFakeProvider } from '../acceptance/provider.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';

/**
 * Le tre proprietà che rendono questo eval un metro e non un'opinione:
 *
 *  1. **il prompt misurato è quello di produzione**, byte per byte — un metro
 *     che misura una ricostruzione non misura niente, ed è il guasto di questa
 *     casa: un meccanismo che esiste, ha i suoi test, e non sta sulla strada
 *     vera. Qui la falsificazione è diretta: se `run.ts` si costruisse un
 *     prompt suo, i byte inviati e quelli che `buildSystemPromptBlocks`
 *     produce sulla stessa home smetterebbero di coincidere.
 *  2. **senza ambiente si esce 78**, e si dice quale variabile serve senza mai
 *     stampare il contenuto di nessuna.
 *  3. **la forma del record regge senza rete**, così la struttura resta onesta
 *     in CI mentre la corsa vera resta locale e a pagamento.
 */

const SCRATCH: string[] = [];
afterEach(() => {
  for (const dir of SCRATCH.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}

const REPO = resolve(import.meta.dirname, '..', '..');

describe("il prompt che l'eval manda è l'assemblaggio di produzione", () => {
  it('è byte-identico a renderSystemPrompts(buildSystemPromptBlocks(home)) per la classe owner', async () => {
    const config: RunConfig = {
      models: [{ label: 'dry-model', provider: 'anthropic', model: 'dry-model', apiKeyEnv: 'UNUSED_UNDER_DRY_RUN' }],
      judge: null,
      dryRun: true,
      probeIds: ['casual-hey'],
      outDir: scratch('muffin-character-prompt-out-'),
    };
    const { homes, sentSystemPrompts } = await runEval(config);
    expect(homes).toHaveLength(1);
    expect(sentSystemPrompts.length).toBeGreaterThan(0);
    const home = homes[0]!;
    SCRATCH.push(home);

    const inviato = sentSystemPrompts[0]!;
    expect(inviato.length).toBeGreaterThan(1000); // un prompt vuoto passerebbe ogni confronto

    const runtime = buildRuntime(home);
    try {
      // La sezione skills è un catalogo generato al boot: si rilegge dal blocco
      // che il runtime ha costruito, non si ri-deriva — ri-derivarla sarebbe la
      // seconda descrizione della produzione che questo test esiste per vietare.
      const skills = runtime.promptBlocks.owner.find((b) => b.name === 'skills')?.text ?? '';
      const atteso = renderSystemPrompts(buildSystemPromptBlocks(home, runtime.safeMode != null, skills)).owner;
      expect(inviato).toBe(atteso);

      // E l'ordine canonico, dichiarato qui perché è ciò che il metro misura:
      // spostare `voice` prima di `persona` cambierebbe il carattere senza
      // cambiare nessun byte dei file.
      expect(runtime.promptBlocks.owner.map((b) => b.name)).toEqual([
        'persona',
        'identity',
        'voice',
        'skills',
        'work-rules',
        'safe-mode',
      ]);
    } finally {
      runtime.close();
    }
  }, 60_000);
});

describe("senza chiave nell'ambiente la corsa non parte", () => {
  it('il comando esce 78 e nomina le variabili che servono, senza stampare nessun valore', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUFFIN_CHARACTER_SENTINEL: 'sk-non-deve-mai-uscire-di-qui' };
    delete env['LLM_API_KEY'];
    delete env['OPENROUTER_API_KEY'];
    const r = spawnSync(
      'npx',
      ['tsx', join(REPO, 'evals', 'character', 'run.ts'), '--provider', 'openai-compat', '--model', 'm', '--judge-model', 'j'],
      { cwd: REPO, env, encoding: 'utf8' },
    );
    expect(r.status).toBe(EXIT_MISSING_ENV);
    expect(r.stderr).toContain('LLM_API_KEY');
    expect(r.stderr).toContain('OPENROUTER_API_KEY');
    expect(r.stderr).toContain('--api-key-env');
    expect(`${r.stdout}${r.stderr}`).not.toContain('sk-non-deve-mai-uscire-di-qui');
  }, 120_000);

  it('una variabile nominata e vuota ferma la corsa prima di creare qualunque cosa, e il messaggio non porta valori', async () => {
    const outDir = scratch('muffin-character-missing-out-');
    process.env['MUFFIN_CHARACTER_OTHER_KEY'] = 'sk-un-valore-che-esiste';
    try {
      const promessa = runEval({
        models: [{ label: 'm1', provider: 'openai-compat', model: 'm1', apiKeyEnv: 'MUFFIN_CHARACTER_ABSENT_KEY' }],
        judge: { label: 'j1', provider: 'openai-compat', model: 'j1', apiKeyEnv: 'MUFFIN_CHARACTER_ABSENT_KEY' },
        dryRun: false,
        probeIds: ['casual-hey'],
        outDir,
      });
      await expect(promessa).rejects.toBeInstanceOf(MissingApiKey);
      await promessa.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain('MUFFIN_CHARACTER_ABSENT_KEY');
        expect(message).not.toContain('sk-un-valore-che-esiste');
      });
      // Niente è stato creato: la directory di output è ancora quella vuota di partenza.
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      delete process.env['MUFFIN_CHARACTER_OTHER_KEY'];
    }
  });
});

describe('la forma del record regge senza rete', () => {
  it('per ogni probe scrive trascrizione, verdetti (uno per proprietà dichiarata) e risposta grezza del giudice', async () => {
    class GiudiceFisso implements Provider {
      readonly kind = 'openai-compat' as const;
      async chat(request: ChatCall): Promise<ChatResult> {
        // Il giudice legge le proprietà dal proprio prompt: un fixture che ne
        // restituisse una lista fissa proverebbe solo sé stesso.
        const user = request.messages[0]?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
        const proprieta = [...user.matchAll(/^- (\w+):/gm)].map((m) => m[1]!);
        return {
          text: JSON.stringify({
            judgements: proprieta.map((property) => ({ property, verdict: 'pass', evidence: 'fixture' })),
          }),
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'j1',
        };
      }
    }
    // Un copione per turno: i due probe sotto ne fanno uno ciascuno, e un
    // copione esaurito produce «script del provider finto esaurito» — cioè un
    // verde che avrebbe misurato la stringa sbagliata.
    const fake = await startFakeProvider({ main: [{ text: 'Ehi, ci sono.' }, { text: 'Ehi, ci sono.' }] });
    process.env['MUFFIN_CHARACTER_FIXTURE_KEY'] = 'sk-fixture';
    const outDir = scratch('muffin-character-shape-out-');
    try {
      const { report } = await runEval(
        {
          models: [{ label: 'm1', provider: 'openai-compat', baseUrl: fake.baseUrl, model: 'm1', apiKeyEnv: 'MUFFIN_CHARACTER_FIXTURE_KEY' }],
          judge: { label: 'j1', provider: 'openai-compat', baseUrl: fake.baseUrl, model: 'j1', apiKeyEnv: 'MUFFIN_CHARACTER_FIXTURE_KEY' },
          dryRun: false,
          probeIds: ['praise-mediocre-decision', 'simulated-action-bait'],
          outDir,
        },
        { judgeProvider: new GiudiceFisso() },
      );
      const runDir = join(outDir, readdirSync(outDir)[0]!, 'm1');
      for (const id of ['praise-mediocre-decision', 'simulated-action-bait']) {
        const probe = PROBES.find((p) => p.id === id)!;
        const verdetti = JSON.parse(readFileSync(join(runDir, `${id}.judge.json`), 'utf8')) as { property: string }[];
        expect(verdetti.map((v) => v.property)).toEqual([...probe.properties]);
        // La trascrizione è l'artefatto: la risposta di Muffin sta lì per
        // intero, perché il verdetto del giudice è debole e chi legge deve
        // poterlo ribaltare guardando le parole.
        expect(readFileSync(join(runDir, `${id}.md`), 'utf8')).toContain('Ehi, ci sono.');
        expect(readFileSync(join(runDir, `${id}.judge.raw.json`), 'utf8')).toContain('judgements');
        expect(report).toContain(id);
      }
      expect(report).toContain('Revisione umana');
    } finally {
      await fake.close();
      delete process.env['MUFFIN_CHARACTER_FIXTURE_KEY'];
    }
  }, 120_000);
});
