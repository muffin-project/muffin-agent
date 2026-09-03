import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { baseToolOrder, buildRuntime } from './runtime.js';

/**
 * Which tools a turn is actually shown, and what falls off the end.
 *
 * `profile.maxToolsExposed` truncates the registered list **by registration
 * order**, and `consumer-local.json` sets it to 10 against a default install of
 * eleven or twelve tools (the sandbox decides). So something is always cut on
 * that profile, silently: it is simply not in the request, no line is logged,
 * and the model behaves as if it did not exist. *What* is cut is decided by the
 * order of a literal in `buildRuntime` — a place nobody edits with the cap in
 * mind.
 *
 * That is how `slice/turno-sospeso` cost a small-model install its web access:
 * `wait` and `todo` went into the base array at positions 6-7 and pushed
 * `skill_read` and `http_get` over the line. The trade was never decided, and
 * nothing could have caught it — the suite was green and every tool worked.
 *
 * This file is the thing that would have caught it. It asserts the **whole
 * ordered list**, so any insertion anywhere fails here and names itself, and it
 * asserts the cut for the profile where the cut is real.
 */

function realRuntime(): { names: string[]; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-exposure-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-exposure-ws-')));
  const names = runtime.deps.tools.map((t) => t.spec.name);
  return { names, close: () => runtime.close() };
}

/**
 * `shell_run` is registered only where the sandbox probe passed, so it is the
 * one entry whose presence is a property of the machine rather than of the
 * code. Dropped from the comparison, and its absence is the reason this file
 * asserts a *filtered* list rather than a snapshot.
 */
const SANDBOXED = 'shell_run';

/**
 * L'ordine dichiarato, sandbox e search a parte — non più un secondo elenco
 * scritto a mano qui: `baseToolOrder` (`agent/runtime.ts`) è la stessa lista
 * che `muffin doctor` legge per dire quali tool un tetto taglierebbe senza
 * costruire un runtime intero. Un elenco qui e un elenco là erano due modi di
 * saperlo, ed è esattamente la forma di guasto che questo file esiste per
 * impedire (`slice/turno-sospeso`: `wait`/`todo` in posizione 6-7 spinsero
 * `skill_read` e `http_get` oltre il tetto, in silenzio, e la suite restò
 * verde).
 */
const REGISTERED = baseToolOrder({ sandboxAvailable: false, searchOn: false });

describe('quali tool vede davvero un turno', () => {
  it('l’ordine di registrazione è quello dichiarato, e cambiarlo fallisce qui', () => {
    const rt = realRuntime();
    rt.close();
    expect(rt.names.filter((n) => n !== SANDBOXED)).toEqual(REGISTERED);
  });

  it('baseToolOrder non diverge dal registro reale, sandbox della macchina compresa', () => {
    // Il de-drift esplicito: qui `shell_run` NON viene filtrato, a differenza
    // del test sopra — `baseToolOrder` deve prevedere esattamente la
    // posizione reale di `sys.shell` quando la sandbox di questa macchina è
    // disponibile, non solo il caso senza. Se un domani un tool si inserisce
    // fra `document_read` e `process_list` senza toccare `baseToolOrder`, qui
    // diventa rosso — non a `cli/doctor.test.ts`, dove nessuno lo cercherebbe.
    const rt = realRuntime();
    rt.close();
    const conteneva = rt.names.includes(SANDBOXED);
    expect(baseToolOrder({ sandboxAvailable: conteneva, searchOn: false })).toEqual(rt.names);
  });

  it('su consumer-local il tetto non taglia più niente, e questo va visto', () => {
    /**
     * The profile that actually truncates. The cap is not a hypothetical: it is
     * what a local model gets, and the tools past the line are invisible to it —
     * no error, no log, no mention in the prompt.
     *
     * The assertion is on **what the cut may contain**, not on a fixed list,
     * because `shell_run` is registered only where the sandbox probe passed: on
     * a machine with a sandbox twelve tools meet a cap of ten and two are cut,
     * without one it is eleven and one. Pinning either number would make this
     * file pass or fail on the host rather than on the code. What must hold on
     * every host is that the things the cap takes are the two primitives at the
     * end of the list, and never the web, the catalogue or memory.
     */
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('qwen3.8-27b', profiles);
    // 15, alzato da 14 il 28/08 per fare posto a `fs_search`. Il commento qui
    // sotto chiamava «cerotto» esattamente questa mossa, e aveva ragione: il
    // numero continua a non avere una misura dietro.
    //
    // Fatta lo stesso, e con una misura almeno sul lato del beneficio. Sul
    // database dell'owner 19 chiamate su 94 erano `sys.shell`, quasi tutte
    // `grep` e `ls -R`, ognuna con una conferma da dare a mano — perché
    // cercare dentro i file non si poteva fare altrimenti. L'alternativa a
    // questo +1 era perdere `sys_inspect`, cioè l'auto-ispezione, che è il
    // primo della lista a cadere. Fra un cerotto dichiarato e un agente che
    // non sa più guardarsi, il cerotto.
    //
    // La risposta strutturale resta quella scritta sotto, e non è un numero.
    expect(profile.maxToolsExposed).toBe(15);

    const rt = realRuntime();
    rt.close();
    const cut = rt.names.slice(profile.maxToolsExposed);

    /**
     * Niente tagliato **oggi**, ed è la ragione per cui questo test resta.
     *
     * Fino al 27/08 il tetto mordeva e il file asseriva *cosa* poteva
     * prendere. Ora non prende niente, e l'asserzione utile si è capovolta:
     * il prossimo tool registrato lo rimette a mordere, in silenzio, e il
     * primo a sparire sarà l'ultimo della lista. Qui diventa rosso invece.
     *
     * La risposta strutturale non è alzare ancora il numero — è la tool
     * search, scartata il 26/08 valutandola contro il budget di token invece
     * che contro questo tetto (`docs/evidence/tool-design-2026-08-26.md`).
     */
    expect(cut, 'il tetto è tornato a tagliare: alzarlo ancora è un cerotto, non una risposta').toEqual([]);

    // Detto anche al positivo, perché un'asserzione su un insieme vuoto passa
    // in un mondo vuoto.
    for (const kept of ['fs_read', 'memory_search', 'document_read', 'skill_read', 'http_get', 'wait', 'todo', 'sys_inspect']) {
      expect(rt.names, `${kept} deve restare esposto`).toContain(kept);
    }
  });

  it('su un profilo frontier non taglia niente, quindi l’ordine non si vede', () => {
    // The other half: the trade above is only ever paid by the small profile,
    // and stating it here stops the next reader from thinking `wait` is
    // unavailable in general.
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('claude-sonnet-5', profiles);
    const rt = realRuntime();
    rt.close();
    expect(rt.names.length).toBeLessThanOrEqual(profile.maxToolsExposed);
  });
});
