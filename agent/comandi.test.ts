import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadConfig } from '../core/config/config.js';
import { COMANDI, aiuto, eseguiComando, type ContestoComandi, type Controlli } from './comandi.js';

/**
 * Le quattro leve di ADR-0054, con controlli finti: cosa risponde ogni
 * comando, e che dica il vero — «fermato» solo se c'era qualcosa da fermare.
 */

function contesto(controlli?: Controlli): ContestoComandi {
  return {
    home: '/nessuno',
    config: {} as ContestoComandi['config'],
    profilo: { name: 'test', thinking: 'unset' },
    budget: { status: () => ({ monthUsd: 0, monthlyCapUsd: 1, exhausted: false }), tenantTodayUsd: () => 0 },
    sessionId: 's',
    verbosity: 'normale',
    puoiUscire: false,
    model: async () => undefined,
    ...(controlli === undefined ? {} : { controlli }),
  };
}

function leve(over: { vivo?: boolean; pausa?: boolean } = {}) {
  const chiamate: string[] = [];
  let pausa = over.pausa ?? false;
  const controlli: Controlli = {
    vivo: () => over.vivo ?? false,
    stop: () => {
      chiamate.push('stop');
      return over.vivo ?? false;
    },
    steer: (t) => {
      chiamate.push(`steer:${t}`);
      return over.vivo ?? false;
    },
    pausa: {
      attiva: () => pausa,
      metti: () => {
        pausa = true;
        chiamate.push('pausa');
      },
      togli: () => {
        pausa = false;
        chiamate.push('riprendi');
      },
    },
  };
  return { controlli, chiamate, inPausa: () => pausa };
}

describe('i comandi esistono e l aiuto li elenca', () => {
  it('stop, steer, pause, resume sono nell elenco condiviso — una volta, per tutte le superfici', () => {
    const nomi = COMANDI.map((c) => c.nome);
    for (const n of ['stop', 'steer', 'pause', 'resume']) expect(nomi).toContain(n);
    expect(aiuto(false)).toContain('/steer');
  });
});

describe('/stop', () => {
  it('ferma il turno vivo e lo dice', async () => {
    const l = leve({ vivo: true });
    const e = await eseguiComando('/stop', contesto(l.controlli));
    expect(e.testo).toContain('fermato');
    expect(l.chiamate).toEqual(['stop']);
  });
  it('senza turno vivo dice che non c e niente', async () => {
    const l = leve();
    const e = await eseguiComando('/stop', contesto(l.controlli));
    expect(e.testo).toContain('nessun turno');
  });
  it('senza leve — muffin run, un test — dice che qui non puo', async () => {
    const e = await eseguiComando('/stop', contesto());
    expect(e.sconosciuto).toBeUndefined();
    expect(e.testo).toContain('non c\'è');
  });
});

describe('/steer', () => {
  it('consegna il testo al turno vivo', async () => {
    const l = leve({ vivo: true });
    const e = await eseguiComando('/steer cerca in italiano', contesto(l.controlli));
    expect(e.testo).toContain('ricevuto');
    expect(l.chiamate).toEqual(['steer:cerca in italiano']);
  });
  it('senza testo chiede cosa correggere', async () => {
    const l = leve({ vivo: true });
    const e = await eseguiComando('/steer', contesto(l.controlli));
    expect(e.testo).toContain('senza testo');
    expect(l.chiamate).toEqual([]);
  });
  it('senza turno vivo rimanda a un messaggio normale', async () => {
    const l = leve();
    const e = await eseguiComando('/steer x', contesto(l.controlli));
    expect(e.testo).toContain('messaggio normale');
  });
});

describe('/pause e /resume', () => {
  it('mette in pausa, e la seconda volta lo sa gia', async () => {
    const l = leve();
    const prima = await eseguiComando('/pause', contesto(l.controlli));
    expect(prima.testo).toContain('in pausa');
    expect(l.inPausa()).toBe(true);
    const seconda = await eseguiComando('/pause', contesto(l.controlli));
    expect(seconda.testo).toContain('già in pausa');
  });
  it('con un turno vivo dice che quello finisce, e come fermarlo', async () => {
    const l = leve({ vivo: true });
    const e = await eseguiComando('/pause', contesto(l.controlli));
    expect(e.testo).toContain('/stop');
  });
  it('riprende, e se non era in pausa lo dice', async () => {
    const l = leve({ pausa: true });
    expect((await eseguiComando('/resume', contesto(l.controlli))).testo).toContain('ripreso');
    expect(l.inPausa()).toBe(false);
    expect((await eseguiComando('/resume', contesto(l.controlli))).testo).toContain('non ero in pausa');
  });
});

/**
 * `/config` (ADR-0070) — la porta REPL/Telegram sulla stessa funzione di
 * `muffin config set` (`core/config/settings.ts::setConfigKnob`). A
 * differenza delle leve di ADR-0054 questo comando tocca davvero il
 * filesystem, quindi serve una home reale — non `/nessuno`.
 */
function contestoConHome(home: string): ContestoComandi {
  let config = loadConfig(home);
  return {
    home,
    config,
    profilo: { name: 'test', thinking: 'unset' },
    budget: { status: () => ({ monthUsd: 0, monthlyCapUsd: 1, exhausted: false }), tenantTodayUsd: () => 0 },
    sessionId: 's',
    verbosity: 'normale',
    puoiUscire: false,
    model: async () => undefined,
    onConfig: (next) => {
      config = next;
    },
  };
}

describe('/model', () => {
  it('dice che la scelta si applica al turno successivo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-comandi-model-'));
    runInit({ home: dir, apiKey: 'sk-fixture' });
    const ctx = contestoConHome(dir);
    ctx.model = async () => undefined;

    const result = await eseguiComando('/model main example/model', ctx);

    expect(result.testo).toContain('dal prossimo turno');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('/config', () => {
  it('è nell elenco condiviso — una volta, per tutte le superfici', () => {
    expect(COMANDI.map((c) => c.nome)).toContain('config');
  });

  it('senza "set" o senza argomenti elenca le chiavi scrivibili, e non tocca il file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-comandi-config-'));
    runInit({ home: dir, apiKey: 'sk-ant-fixture' });
    const before = loadConfig(dir);
    for (const riga of ['/config', '/config set', '/config set traces.retentionDays']) {
      const e = await eseguiComando(riga, contestoConHome(dir));
      expect(e.testo).toContain('traces.retentionDays');
    }
    expect(loadConfig(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('/config set traces.retentionDays 20 scrive davvero e lo dice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-comandi-config-'));
    runInit({ home: dir, apiKey: 'sk-ant-fixture' });
    const e = await eseguiComando('/config set traces.retentionDays 20', contestoConHome(dir));
    expect(e.testo).toContain('traces.retentionDays');
    expect(e.testo).toContain('20');
    expect(loadConfig(dir).traces.retentionDays).toBe(20);
    rmSync(dir, { recursive: true, force: true });
  });

  it('/config set rot.mode hardened è rifiutato, come da CLI — stessa funzione, stessa risposta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-comandi-config-'));
    runInit({ home: dir, apiKey: 'sk-ant-fixture' });
    const before = loadConfig(dir);
    const e = await eseguiComando('/config set rot.mode hardened', contestoConHome(dir));
    expect(e.testo).toContain('non è un\'impostazione modificabile');
    expect(loadConfig(dir)).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
