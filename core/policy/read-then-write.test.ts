import { describe, expect, it } from 'vitest';
import { createDecide } from './decide.js';
import { POLICY_FLOOR } from './matrix.js';
import type { CapabilityDecl, Principal } from './types.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { DISK_TIER } from '../../agent/tools/fs.js';

/**
 * Leggi un file, poi scrivine uno: **oggi non si può**, e nessuno lo diceva.
 *
 * Misurato il 27/08 sull'installazione dell'owner, non dedotto: lo scenario
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

  it('dopo un `fs_read` no, ed è un deny, non una domanda', () => {
    // Il numero non è scelto qui: è quello che `fs_read` produce davvero.
    expect(DISK_TIER).toBe(2);
    const d = chiedi(DISK_TIER as 2);
    expect(d.effect).toBe('deny');
    expect(d.effect === 'deny' && d.code).toBe('taint_exceeded');
  });

  it('il tetto che lo decide è 1, e sta nel floor — non in una riga di fs.ts', () => {
    // Se qualcuno lo alza per far passare un eval, questo test lo nomina.
    expect(POLICY_FLOOR.defaultMaxTaint.medium).toBe(1);
    expect(decls.get('fs.write')?.risk).toBe('medium');
    expect(decls.get('fs.write')?.maxTaint).toBeUndefined();
  });
});
