import { describe, expect, it } from 'vitest';
import { createDecide } from './decide.js';
import { POLICY_FLOOR } from './matrix.js';
import type { CapabilityDecl, Principal } from './types.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { DISK_TIER } from '../../agent/tools/fs.js';

/**
 * Leggi un file, poi scrivine uno: **oggi non si può — ma il taint è la
 * seconda ragione, non la prima.**
 *
 * Correzione a come questo file era scritto quando è nato, poche ore prima
 * (#179). Diceva che lo scenario `breadth` fallisce perché il kernel rifiuta la
 * scrittura per `taint_exceeded`, ed è vero; lasciava credere che togliendo
 * quel rifiuto la scrittura funzionerebbe, e **non è vero**. `fs.write` è
 * `medium`+`undoable`, quindi a taint 0 il kernel risponde `draft` — e il loop
 * rifiuta ogni `draft`, perché il registro di undo non esiste
 * (`agent/loop.ts`, "il registro di undo non esiste ancora"). **`fs_write` non
 * scrive un file in nessun caso**, a nessun taint, da quando esiste.
 *
 * Non è una scoperta: sono tre requisiti DAY-1 (D2 «`fs_write` non scrive mai
 * un file reale oggi», D3 «`muffin undo` non esiste», D11 «`draft` è ancora
 * ineseguibile da ogni percorso»), tutte e tre puntate sulla stessa slice
 * `undo-journal`, con la forma già decisa dall'owner il 16/08 (requirements-status.md#il-modello-di-reversibilità--la-decisione-sotto-fswrite:
 * journal per turno, copia prima della mutazione, undo che riallinea
 * filesystem **e** turno).
 *
 * Vale la pena tenere separate le due cose perché si riparano in ordine: prima
 * il journal rende `draft` eseguibile, e **solo allora** il tetto di taint
 * diventa la cosa che decide se «leggi, calcola, scrivi» funziona.
 *
 * La misura resta quella del 27/08 sull'installazione dell'owner: lo scenario
 * `breadth` di `evals/floor` («quanto ho speso secondo spesa.txt? scrivi il
 * totale in totale.txt») fallisce 9 volte su 9 con `qwen/qwen3.8-27b`, a
 * qualunque tetto di tool (10, 14, 20). Il modello fa la cosa giusta — legge,
 * calcola 8.45, prova a scrivere — e il kernel rifiuta:
 *
 *     Rifiutato dal kernel dei permessi (taint_exceeded)
 *
 * L'aritmetica è tutta qui e non ha niente di ambiguo:
 *
 *  - `fs_read` restituisce `DISK_TIER = 2` (ADR-0044: il read **paga**, ed è
 *    ciò che rende vero il gate di egress);
 *  - `fs.write` è `risk: 'medium'`, e `defaultMaxTaint.medium` è **1**;
 *  - quindi ogni turno che ha letto un file non può più scriverne uno.
 *
 * Non è un `ask` che l'owner può approvare: è `deny`. E `rot/policy.json`
 * sull'installazione viva ha esattamente gli stessi valori del floor, quindi
 * non è un artefatto dell'eval.
 *
 * **Questo file non decide se sia giusto.** Le due letture sono entrambe
 * difendibili — un contenimento voluto (byte non provenienziati non si
 * travasano in un altro file) contro una regressione di capability (leggi,
 * calcola, scrivi è il compito locale più comune, e `fs.write` è già
 * `hostOnly` dentro una root contenuta). È una decisione su kernel/taint, e
 * quelle non si prendono cambiando un numero perché un eval è rosso.
 *
 * Quello che il file fa è **impedire che cambi in silenzio, in una direzione o
 * nell'altra**: il comportamento corrente è pinnato qui, con la misura
 * accanto. Il giorno che qualcuno alza `defaultMaxTaint.medium` o abbassa
 * `DISK_TIER`, questo test lo dice e chiede di scriverlo nella decisione.
 *
 * ## Aggiornamento 2026-09-02 — la decisione è stata scritta (ADR-0053)
 *
 * Il giorno è arrivato, e non spostando un numero: il `deny` qui sopra non era
 * una scelta, era una **trascrizione mancata**. La matrice normativa
 * (`03-threat-model.md` §3) dà a `fs.write` la riga *Shell / filesystem host /
 * processi*, e quella riga a taint 2 dice `ASK`. L'emendamento owner del
 * 16/08 aveva spostato quella cella per `sys.shell` sola, appuntandole
 * `maxTaint: 2` addosso; `fs.write` — stessa riga, stesso disco, e l'unica
 * delle due con checkpoint e `undo` — ha continuato a ereditare il default di
 * classe. Due porte allo stesso sink, chiusa la più sicura.
 *
 * Quindi il kernel ora prende il soffitto dalla **riga di effetto** e non dalla
 * classe di rischio, e questo file pinna la cella nuova: `ask`, non `deny`, e
 * non perché un eval fosse rosso — perché il documento lo diceva già.
 *
 * Le due letture che il paragrafo sopra chiamava «entrambe difendibili» restano
 * tali, e la loro sede è un'altra: se il *taint ambientale* sia il segnale
 * giusto è la domanda aperta di `docs/architecture/SECURITY.md` §13, che si chiude con un
 * eval comparativo e non con questa ADR. Qui cambiano le righe, non le colonne.
 *
 * Nota su una frase invecchiata qui sopra: «`fs_write` non scrive un file in
 * nessun caso» era vero quando questo file è nato e non lo è più — il journal
 * di undo è arrivato, e D2/D3 lo provano sul binario vero
 * (`evals/acceptance/scenarios/d-capability.accept.ts`: il file c'è, e
 * `muffin undo` lo toglie).
 */
const decls = new Map<string, CapabilityDecl>(fsCapabilities.map((c) => [c.id, c]));
// `hardened: false` è lo stato vero dell'installazione dell'owner: `rot/` ha
// lo stesso uid dell'agente, quindi la modalità non è raggiungibile (LAVORO,
// lamentela dogfood su `sys.shell`). Metterlo a `true` qui misurerebbe una
// macchina che non esiste.
const decide = createDecide({ matrix: POLICY_FLOOR, capabilities: decls, budgetExhausted: () => false, hardened: false });
const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'o' };
const chiedi = (taint: 0 | 1 | 2 | 3) =>
  decide({
    capability: 'fs.write',
    principal: owner,
    tenant: 'host',
    taint,
    resource: { kind: 'path', value: '/w/out.txt' },
    args: { path: 'out.txt', content: 'x' },
  });

describe('leggere un file spegne la scrittura per il resto del turno', () => {
  it('un turno pulito può scrivere (draft, perché la scrittura è undoable)', () => {
    expect(chiedi(0).effect).toBe('draft');
    expect(chiedi(1).effect).toBe('draft');
  });

  /**
   * **Riscritta da ADR-0074 punto 1**, ed è il caso che ha prodotto l'ADR.
   *
   * ADR-0053 aveva portato questa cella da `deny` ad `ask`: la riga `host`
   * diceva ASK a taint 2, quindi dopo un `fs_read` la scrittura chiedeva. La
   * misura successiva ha detto perché non regge — 35 approvazioni in tutta la
   * vita dell'installazione, tutte a taint 2, 32 concesse: un cancello
   * concesso nove volte su dieci è un riflesso. E ciò che si stava
   * approvando aveva **un undo**: `fs.write` fotografa il file prima di
   * scrivere e `muffin undo` lo rimette.
   *
   * Quindi resta `draft`, identico a taint 0 e a taint 2, e ciò che il taint
   * decide su questa riga è solo il soffitto — provato dal test qui sotto,
   * che a taint 3 resta `deny`.
   */
  it('dopo un `fs_read` resta un `draft` con undo, non una domanda (ADR-0074)', () => {
    // Il numero non è scelto qui: è quello che `fs_read` produce davvero.
    expect(DISK_TIER).toBe(2);
    const d = chiedi(DISK_TIER as 2);
    expect(d.effect).toBe('draft');
    // E la finestra di undo è la stessa del turno pulito: il taint non ha
    // cambiato niente sotto il soffitto.
    expect(d).toEqual(chiedi(0));
  });

  /**
   * **Riscritta da ADR-0075.** Fino al 06/09 questo test asseriva che a taint
   * 3 la scrittura restava un `deny/taint_exceeded` — «la riga si è alzata di
   * un gradino, non è sparita». Il gradino è stato misurato dove finisce: nove
   * turni su quattordici in privato a taint 3 il 06/09, cioè dopo una ricerca
   * web niente scrittura e niente shell fino a una conversazione nuova.
   *
   * Il rifiuto non comprava niente *qui*: la cosa che si stava negando ha una
   * copia e un `muffin undo` dietro. Quindi la scrittura resta `draft` anche a
   * taint 3, e il taint compare dove serve — nel testo di ciò che chiede
   * (`agent/loop/tool-call.ts`) — invece che come un muro.
   */
  it('a taint 3 la scrittura con undo resta un draft, identico al turno pulito (ADR-0075)', () => {
    const d = chiedi(3);
    expect(d.effect).toBe('draft');
    expect(d).toEqual(chiedi(0));
  });

  /**
   * E il muro è una **manopola**, non una riga cancellata: un `policy.json`
   * sigillato che rimette `host.denyAbove: 2` lo rimette davvero, perché
   * `tighterRows` stringe. Senza questa metà, ADR-0075 sarebbe
   * indistinguibile da «il soffitto è stato tolto dal codice» — ed è la stessa
   * distinzione che ADR-0072 ha già dovuto provare per `searchMaxTaint`.
   */
  it('un policy.json che rimette host.denyAbove a 2 vince, e il rifiuto torna', () => {
    const stretto = createDecide({
      capabilities: decls,
      matrix: { ...POLICY_FLOOR, rows: { ...POLICY_FLOOR.rows, host: { asksForIrreversible: true, denyAbove: 2 } } },
      budgetExhausted: () => false,
      hardened: false,
    });
    const d = stretto({
      principal: owner,
      capability: 'fs.write',
      tenant: 'host',
      taint: 3,
      resource: { kind: 'path', value: '/w/out.txt' },
      args: { path: 'out.txt', content: 'x' },
    });
    expect(d.effect).toBe('deny');
    expect(d.effect === 'deny' && d.code).toBe('taint_exceeded');
  });

  it("il tetto che lo decide è la riga di effetto, non la classe di rischio", () => {
    // Se qualcuno riporta il soffitto su un numero appuntato sulla singola
    // capability, questo test lo nomina: è la forma che ha prodotto la deriva.
    expect(decls.get('fs.write')?.effect).toBe('host');
    expect(decls.get('fs.write')?.maxTaint).toBeUndefined();
    expect(POLICY_FLOOR.rows.host).toEqual({ asksForIrreversible: true, denyAbove: 3 });
    // La classe di rischio resta `medium` e continua a decidere altro — se la
    // scrittura sia un `draft` o un `allow`, il safe mode, il budget, la coda
    // degli autonomi — ma non il soffitto, e da ADR-0074 nemmeno l'`ask`.
    expect(decls.get('fs.write')?.risk).toBe('medium');
  });
});
