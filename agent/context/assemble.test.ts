import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import {
  loadConfig,
  paths,
  PROMPT_VERSIONS,
  saveConfig,
  type PromptVersion,
} from '../../core/config/config.js';
import type { Principal } from '../../core/policy/types.js';
import { buildRuntime, type Runtime } from '../runtime.js';
import { buildSystemPromptBlocks, renderSystemPrompts, tenantClass, visibleTools } from './assemble.js';

/**
 * The prompt is a function of the tenant, and the tool list is a function of the
 * principal.
 *
 * Asserted through `buildRuntime` — the production assembly — for the same
 * reason `persona.test.ts` is: what was wrong here was never the builder. The
 * defect was that `buildSystemPrompt` took no tenant at all, so a group turn
 * received, byte for byte, the owner's prompt: the owner's private pact from
 * `identity.md`, and the persona section that tells the agent to *elicit
 * personal facts* one at a time — in the one tenant whose memory is not the
 * owner's.
 */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'muffin-assemble-ws-'));

/**
 * Il nonce del recinto delle skill, fissato.
 *
 * È per-installazione e casuale, e deve esserlo: se fosse una costante di
 * repository chiunque lo saprebbe. Ma un prompt fissato per byte non può
 * dipendere da un valore casuale, quindi il test lo scrive prima di bootare —
 * dichiarando così che il prompt varia per *questo* valore e per nient'altro.
 */
const NONCE_FISSO = 'aaaaaaaaaaaa';

function bootHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-assemble-'));
  // No turn runs, so the key is never used — the check stays model-free.
  runInit({ home, apiKey: 'sk-assemble-never-called' });
  writeFileSync(paths(home).promptNonce, `${NONCE_FISSO}\n`, 'utf8');
  return home;
}

function boot(home: string): Runtime {
  return buildRuntime(home, WORKSPACE);
}

const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const MEMBER: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:-100',
  externalId: '77',
};

describe('which class a turn belongs to', () => {
  it('gives the host tenant to the owner class and every other tenant to the group class', () => {
    expect(tenantClass(OWNER, 'host')).toBe('owner');
    expect(tenantClass(MEMBER, 'group:telegram:-100')).toBe('group');
    expect(tenantClass(MEMBER, 'community:amici')).toBe('group');
  });

  it('sends the host work of the autonomous principals to the owner class', () => {
    // The scheduler and the observing spine run on the host, for the owner, on
    // the owner's own memory. A group prompt there would make the daily brief
    // talk to its owner as a guest in someone else's room.
    expect(tenantClass({ kind: 'system', source: 'scheduler' }, 'host')).toBe('owner');
    expect(tenantClass({ kind: 'system', source: 'consolidation' }, 'host')).toBe('owner');
    expect(tenantClass({ kind: 'agent', role: 'dev' }, 'host')).toBe('owner');
  });

  it('falls to the group class whenever either half is not host work', () => {
    // Two independent conditions, each failing towards the narrower prompt. A
    // member carrying the host tenant is not constructible through any
    // connector today; if one ever builds it, the answer must not be "here is
    // the owner's identity file".
    expect(tenantClass(MEMBER, 'host')).toBe('group');
    expect(tenantClass(OWNER, 'group:telegram:-100')).toBe('group');
    expect(tenantClass({ kind: 'system', source: 'scheduler' }, 'group:telegram:-1')).toBe('group');
  });
});

describe('the owner-class prompt does not move', () => {
  /**
   * sha256 of the owner-class prompt of a fresh `muffin init` home.
   *
   * This is the cache pin, and it is deliberately brittle. Splitting the prompt
   * by class is worthless if the owner's half shifts by a byte: every session
   * that has a warm prefix goes cold, silently, and behaviour changes with it.
   *
   * When this fails after an intentional edit to `defaults/persona.md`,
   * `defaults/voice.md` or `defaults/rot/identity.md`, that is the test doing
   * its job — re-capture the hash in the same commit as the edit, so the cache
   * invalidation is a thing someone decided rather than a thing that happened.
   *
   * Note that the three files named above are not the only inputs: `WORK_RULES`
   * in `assemble.ts` is a fourth, and it is the one the re-capture below moved.
   *
   * Ri-fissato 2026-09-06 (`slice/d13-tool-prima-della-shell`, DAY-1 D13): una
   * riga in più in `WORK_RULES` che dice l'ordine — tool dedicato prima,
   * `sys.shell` ultimo — e mostra una concatenazione (`fs_read` poi, se serve,
   * `shell_run` sul risultato). La misura del 04/09 aveva trovato quattro fail
   * `agentic` della baseline di carattere fermi su "serve la tua approvazione
   * per sys.shell" dove un tool dedicato copriva già la domanda; le descrizioni
   * dei singoli tool (agent/tools/*.ts) ora dicono ciascuna quando usarle e
   * quando no, ma una riga nel prompt che dice l'ordine una volta sola resta
   * quella che un modello legge per primo. Ordine di assemblaggio invariato.
   * Pin precedente: `a8eb81ecd95df248b8bdc588c07521292bed8d5d75dcddce22b76fb32112c8b3`.
   *
   * Ri-fissato 2026-09-03 (`slice/il-disco-ha-un-recinto`): una riga in più in
   * `WORK_RULES`, 305 caratteri, che dice al modello **cosa sia un recinto**.
   * Fino a ieri nessuna riga del prompt spedito lo diceva: l'unico posto dove il
   * modello veniva avvertito era la descrizione di due tool (`http_get`,
   * `web_search`), cioè un avvertimento che sparisce se quei tool non sono
   * registrati e che per il disco non c'è mai stato.
   *
   * **Perché muovere v1 invece di tenerlo congelato**, che era l'altra strada e
   * va detta: il congelamento ha una ragione vera e recente — `slice/prompt-v2`
   * tiene v1 come fondo su cui l'owner torna indietro, e la reversibilità *è*
   * che v1 non si muova di un byte. Ma `promptVersion` di default è `v1`
   * (`core/config/config.ts`): una riga solo in v2 non arriverebbe a nessuno
   * finché l'owner non gira la manopola, e il buco che questa fetta chiude è
   * spedito adesso. Fra «v1 immobile» e «la regola arriva all'installazione che
   * gira» vince la seconda, e il costo si scrive invece di subirlo: ogni
   * sessione con un prefisso caldo va a freddo una volta, su tutte e due le
   * classi. Il fondo per il ritorno indietro resta, con la riga dentro — v1 e v2
   * dicono la stessa cosa sul recinto, quindi la manopola continua a scegliere
   * fra due prompt e non fra due politiche di sicurezza.
   *
   * La riga è la metà **probabilistica** di questa fetta e non è il controllo:
   * il controllo è `fenceDisk` in `agent/tools/fs.ts`, che marca i byte in
   * codice qualunque cosa il modello stia pensando. Pin precedente:
   * `ac57a24adb0fa04428a72c9b6ba363e54f341db829835854a9faa51897fd41a7`.
   *
   * Ri-fissato 2026-08-27 (`slice/skill-di-serie`): due cose insieme, e la
   * seconda è il motivo per cui questo test esiste. (1) Il catalogo delle skill
   * ora ha contenuto — `defaults/skills/` spedisce due skill e `init` le mette
   * in casa — quindi il blocco `skills`, che prima era vuoto e cadeva fuori,
   * occupa 744 caratteri su 23.648, il 3,1%: solo `name` e `description`, il
   * corpo si legge con `skill_read` e solo se serve. (2) Quel blocco arrivava
   * con un **nonce nuovo a ogni chiamata**, quindi il prompt owner era diverso
   * a ogni processo — e ogni `muffin run` è un processo. Misurato su due boot
   * della stessa home: due SHA diversi. Non era ri-fissabile per costruzione, e
   * peggio, la cache del provider non poteva prendere sul prefisso. Il nonce è
   * ora per-installazione (`core/skills/nonce.ts`, `paths().promptNonce`), il
   * test lo fissa a `NONCE_FISSO` prima di bootare, e la stabilità fra processi
   * ha una prova sua qui sotto. Pin precedente:
   * `a83e22ce2ab67a953c1c0b1af96c38a67ff5271593d903d1ca87c728724cde73`.
   *
   * Ri-fissato 2026-08-28 (`slice/niente-chiamate-gemelle`): un carattere,
   * `## Come lavori` diventa `# Come lavori` (e così `## Modalità sicura`), ed
   * è una correzione di struttura, non di stile. I blocchi si concatenano con
   * una riga vuota e i primi tre aprono con `#` — `# Muffin`, `# Identità`,
   * `# Voce` — quindi un `##` finiva **annidato sotto «Voce»**: le regole su
   * come usare i tool si leggevano come una sottosezione di come si scrive.
   * Nessuno lo vedeva perché ogni file si legge da solo e la gerarchia esiste
   * solo dopo la concatenazione. La documentazione di Anthropic sul context
   * engineering chiede sezioni distinte delimitate da intestazioni; questa non
   * lo era. Un carattere in meno sul prompt owner, che è esattamente quello
   * tolto dall'intestazione. Pin precedente:
   * `81f2e880260f50e2621affa008bb64980e8d4dff10981a37535513f57be986ed`.
   *
   * Ri-fissato 2026-09-02 (`slice/un-tool-che-non-ce-non-e-una-policy`): una
   * regola in più in `WORK_RULES`, dalla misura dell'episodio 310 del database
   * dell'owner — il modello aveva spiegato un tool che non esiste come una
   * policy di taint. Ordine di assemblaggio invariato. Pin precedente:
   * `dfc6b43c667cdac8341b30ac54591e15ffc8657db9c271334aadb5e921f82e97`.
   *
   * Ri-fissato 2026-08-28 (`slice/prompt-senza-eco`): `persona.md` è passato da
   * 7.528 a 4.629 byte. Non è una potatura estetica — è la conseguenza di una
   * cosa che si vede solo guardando i blocchi **insieme**: `identity.md` spedisce
   * 4.928 byte di patto autorizzato dall'owner (da c090dce; non è più vuoto,
   * qualunque cosa dicessero i commenti rimasti in giro), e `persona.md` ne
   * ripeteva metà in terza persona. «La familiarità non è authority / la memoria
   * non è permesso» stava in tutti e due quasi parola per parola.
   *
   * Tagliato `persona.md` e **non** `voice.md`, e la ragione è di classe, non di
   * gusto: `voice.md` va anche ai gruppi, `identity.md` no. Una frase di
   * `voice.md` che compare pure in `identity.md` non è un doppione — è l'unica
   * copia che la stanza riceve. `persona.md` invece è solo dell'owner e sta
   * accanto al patto sigillato che già la dice. Prompt owner: 23.648 → 20.770
   * caratteri. Pin precedente:
   * `19f1e7d300ad74c4c28d4ac0d9ff1dab0519f85c0d64fdcfabda060c2bd45d4a`.
   *
   * Re-captured 2026-09-07 (D13, remeasurement after #457/ADR-0074): the
   * `WORK_RULES`/`WORK_RULES_V2` line on tool order named `sys.shell` as one
   * tool that "always asks" — stale since the ADR-0074 split gave it two
   * (`shell_run`, read-only, never asks; `shell_run_write` always does), and
   * the model was being told a false fact about its own tools. Corrected in
   * the same line, and extended by one clause the D13 measurement asked for:
   * when the task names an external service, check for a loaded tool with
   * that name before falling back to the environment (`mcp-tool-use` probe,
   * 3/3 rounds, `docs/evidence/tool-use-2026-09-07.md`). Assembly order
   * unchanged. Previous pin, for the record:
   * `7dbab742425de4af2b473f7e509a72e82cb501ddc2d3e50527e700f1f6740c53`.
   *
   * Re-captured 2026-08-26 (`slice/come-lavori`): three rules added to
   * `WORK_RULES`, each closing a gap the runtime does not close on its own —
   * see that constant's docstring for which trace produced which rule. The
   * assembly order is unchanged. Previous pin, for the record:
   * `7dbab742425de4af2b473f7e509a72e82cb501ddc2d3e50527e700f1f6740c53`.
   *
   * Re-captured 2026-08-17 (`slice/identita`, A2/A3): commit c090dce replaced
   * the three template files with the owner's real, authored text (persona.md
   * and voice.md rewritten, identity.md filled in for the first time) — that
   * hash was that text through the *unchanged* assembly order, not a new
   * mechanism. 22,477 chars / 22,772 UTF-8 bytes, against 11,498 chars before
   * (roughly double — see the PR body for the full before/after and the
   * `group` class' smaller delta). Pin before that one:
   * `3ebf2cfc307bdda5c73fff6ed4d60d5a9db2eceffac754164b220a86214cabf2`.
   *
   * Re-captured 2026-09-13 after `defaults/rot/identity.md` became owner-generic
   * so a fresh install no longer puts the founder's identity in the prompt.
   * Previous pin: `45a73d354ec5b8d52b30fa1b306f96d35b04959c3ddf9d10e831e3beb73ffbbf`.
   */
  const OWNER_PROMPT_SHA_AT_SPLIT =
    '9af210080d8814b2236adbaf6049d7f7aae5563c968ebd4c3340af1aa074005a';

  it('è identico a se stesso fra due processi — o la cache non prende mai', () => {
    // Misurato prima di essere riparato: il recinto delle skill prendeva un
    // nonce nuovo a ogni chiamata, e ogni `muffin run` è un processo, quindi il
    // prefisso del prompt era diverso ogni volta e la cache del provider non
    // poteva prendere per costruzione. Due boot **della stessa home**: due SHA
    // uguali. Due home diverse devono invece differire, o il nonce non è un
    // nonce — ed è la seconda metà che rende questo test una prova.
    const home = mkdtempSync(join(tmpdir(), 'muffin-assemble-'));
    runInit({ home, apiKey: 'sk-assemble-never-called' });
    const uno = boot(home);
    const primo = uno.deps.systemPrompts.owner;
    uno.close();
    const due = boot(home);
    const secondo = due.deps.systemPrompts.owner;
    due.close();
    expect(secondo).toBe(primo);

    const altra = boot(bootHome());
    try {
      expect(altra.deps.systemPrompts.owner).not.toBe(primo);
    } finally {
      altra.close();
    }
  });

  it('is byte-identical to the single prompt that preceded the split', () => {
    const runtime = boot(bootHome());
    try {
      const sha = createHash('sha256')
        .update(runtime.deps.systemPrompts.owner, 'utf8')
        .digest('hex');
      expect(sha).toBe(OWNER_PROMPT_SHA_AT_SPLIT);
    } finally {
      runtime.close();
    }
  });

  /**
   * Il fondo su cui l'owner torna indietro.
   *
   * `slice/prompt-v2` aggiunge una seconda versione del prompt, e la sola cosa
   * che rende quel passaggio reversibile è che v1 non si muova di un byte: non
   * i file — che nessuno tocca — ma la **stringa assemblata**, che è ciò che il
   * modello riceve e ciò su cui la cache del provider prende. Il pin sopra lo
   * dice per la classe owner attraverso il default; questi due lo dicono per
   * l'argomento esplicito e per il gruppo, che prima non aveva nessun pin.
   *
   * Falsificabile per costruzione: montare v2 mentre la versione dice v1 fa
   * cadere questi tre insieme.
   */
  it("chiedere v1 esplicitamente dà la stessa stringa del default — e la stessa di ieri", () => {
    const home = bootHome();
    const runtime = boot(home);
    try {
      const skills = runtime.promptBlocks.owner.find((b) => b.name === 'skills')?.text ?? '';
      const esplicito = renderSystemPrompts(buildSystemPromptBlocks(home, false, skills, 'v1'));
      expect(esplicito.owner).toBe(runtime.deps.systemPrompts.owner);
      expect(createHash('sha256').update(esplicito.owner, 'utf8').digest('hex')).toBe(OWNER_PROMPT_SHA_AT_SPLIT);
    } finally {
      runtime.close();
    }
  });

  /**
   * Lo stesso pin per la classe `group`, fissato il 2026-09-03 con
   * `slice/prompt-v2`. Vale la stessa regola dell'altro: quando cade dopo una
   * modifica voluta a `defaults/voice.md` o a `GROUP_PERSONA`, si ri-cattura
   * nello stesso commit della modifica, così l'invalidazione della cache è una
   * cosa che qualcuno ha deciso e non una cosa che è successa.
   */
  /**
   * Ri-fissato 2026-09-07 (D13, remeasurement dopo #457/ADR-0074) insieme al
   * pin owner, per la stessa riga: `WORK_RULES` spedisce a tutte e due le
   * classi, quindi la correzione (`sys.shell` non è più un tool solo, e non
   * "chiede sempre") arriva anche alla stanza. Pin precedente:
   * `0cd5604d608887cb6918b8b3392cd926de5194ce73134082636a4c1d5dd7bc23`.
   *
   * Ri-fissato 2026-09-06 (`slice/d13-tool-prima-della-shell`) insieme al pin
   * owner, per la stessa riga: `WORK_RULES` spedisce a tutte e due le classi,
   * quindi la regola sull'ordine tool-poi-shell arriva anche alla stanza. Pin
   * precedente: `6d0a7bef6f7da6ded227c879427715bb64c53e8886e52710b58ace44823a524b`.
   *
   * Ri-fissato 2026-09-03 (`slice/il-disco-ha-un-recinto`) insieme al pin owner,
   * e per la stessa riga: `WORK_RULES` spedisce a tutte e due le classi, quindi
   * la regola sul recinto arriva anche alla stanza — che è dove il contenuto di
   * qualcun altro entra per definizione. Pin precedente:
   * `23aa24da39dc582dd7909f750fed59b165a71ce70dc549428b5df634ced0ed9b`.
   */
  const GROUP_PROMPT_SHA_V1 = 'a365b0fc5f1b40c4c2ef787e95f094bb4754597d9073d51d73a93c9cbcf10ae3';

  it('e la stanza riceve lo stesso prompt di ieri, byte per byte', () => {
    const runtime = boot(bootHome());
    try {
      const sha = createHash('sha256').update(runtime.deps.systemPrompts.group, 'utf8').digest('hex');
      expect(sha).toBe(GROUP_PROMPT_SHA_V1);
    } finally {
      runtime.close();
    }
  });
});

/**
 * La manopola della versione, provata sulla strada vera.
 *
 * Due porte sulla stessa manopola — `config.json` e `muffin prompt version` —
 * e la proprietà che conta non è che ognuna funzioni, è che **dicano la stessa
 * cosa**: una manopola esposta da due porte che divergono è peggio di una
 * manopola esposta da una sola. Il confronto qui sotto è fra la config scritta
 * a mano e la config scritta dal comando, montate entrambe da `buildRuntime`.
 */
describe('quale versione del prompt assembla questa installazione', () => {
  it('senza campo in config monta v1, e col campo a v2 monta v2 — attraverso buildRuntime', () => {
    const home = bootHome();
    const primo = boot(home);
    const v1 = primo.deps.systemPrompts.owner;
    primo.close();
    // Il default è v1 e non è scritto da nessuna parte: la config appena creata
    // da `runInit` non nomina il prompt.
    expect(loadConfig(home).prompt).toBeUndefined();

    saveConfig({ ...loadConfig(home), prompt: { version: 'v2' } }, home);
    const secondo = boot(home);
    const v2 = secondo.deps.systemPrompts.owner;
    secondo.close();

    expect(v2).not.toBe(v1);
    // E non è «una stringa diversa» qualunque: è la v2, riconoscibile da una
    // riga che esiste solo lì.
    expect(v2).toContain('## Quando il risultato è incerto');
    expect(v1).not.toContain('## Quando il risultato è incerto');

    // Il ritorno indietro è lo stesso campo, e riporta i byte esatti.
    saveConfig({ ...loadConfig(home), prompt: { version: 'v1' } }, home);
    const terzo = boot(home);
    try {
      expect(terzo.deps.systemPrompts.owner).toBe(v1);
    } finally {
      terzo.close();
    }
  });

  it('v2 legge la copia spedita quando la home non ce l\'ha ancora, e sono lo stesso testo', () => {
    // L'installazione su cui questa fetta va provata è **già fatta**: `muffin
    // init` è passato mesi fa e `~/.muffin/v2/` non esiste. Se v2 sapesse
    // leggere solo la home, la manopola sarebbe girabile e non avrebbe niente
    // da montare — un difetto che si vede soltanto su una casa vecchia.
    const vecchia = mkdtempSync(join(tmpdir(), 'muffin-assemble-vecchia-'));
    runInit({ home: vecchia, apiKey: 'sk-assemble-never-called' });
    rmSync(join(vecchia, 'v2'), { recursive: true, force: true });
    expect(existsSync(join(vecchia, 'v2', 'persona.md'))).toBe(false);

    const daSpedito = renderSystemPrompts(buildSystemPromptBlocks(vecchia, false, '', 'v2'));
    expect(daSpedito.owner).toContain('## Quando il risultato è incerto');
    // E la provenienza è dichiarata, non silenziosa: chi guarda `--blocks` deve
    // vedere che sta leggendo il pacchetto e non la sua home.
    const blocchi = buildSystemPromptBlocks(vecchia, false, '', 'v2');
    expect(blocchi.owner.find((b) => b.name === 'persona')?.source).toContain('spedito');

    // Stessa home dopo un init che la ripopola: stesso testo, sorgente diversa.
    runInit({ home: vecchia, apiKey: 'sk-assemble-never-called' });
    const daCasa = buildSystemPromptBlocks(vecchia, false, '', 'v2');
    expect(daCasa.owner.find((b) => b.name === 'persona')?.source).toBe('v2/persona.md');
    expect(renderSystemPrompts(daCasa).owner).toBe(daSpedito.owner);
  });

  it('la metà operativa smette di essere un trentaduesimo del carattere', () => {
    // La misura che ha motivato la fetta, tenuta come test perché è la sola
    // affermazione strutturale che v2 fa: non «è scritto meglio» — quello lo
    // decide l'owner leggendo — ma «esiste».
    const home = bootHome();
    const conta = (v: PromptVersion) => {
      const b = buildSystemPromptBlocks(home, false, '', v);
      const testo = (nome: string) => b.owner.find((x) => x.name === nome)?.text.length ?? 0;
      return {
        chiSei: testo('persona') + testo('identity') + testo('voice'),
        comeLavori: testo('work-rules'),
      };
    };
    const v1 = conta('v1');
    const v2 = conta('v2');
    // Era `> 20` fino al 2026-09-03, poi `> 15`: la riga sul recinto aveva
    // portato il rapporto v1 da 23,35 a 17,07 (19.335 / 1.133).
    // Ri-misurato 2026-09-06 (`slice/d13-tool-prima-della-shell`, DAY-1 D13):
    // la riga sull'ordine tool-poi-shell aggiunge testo a `WORK_RULES`
    // (1.133 → 1.488 caratteri) e porta il rapporto a 12,99 (19.335 / 1.488).
    // Ri-misurato di nuovo 2026-09-07 (D13, remeasurement dopo #457/ADR-0074):
    // la stessa riga corregge "sys.shell chiede sempre" (falso dopo la
    // separazione in due tool) e aggiunge la clausola sui tool MCP caricati
    // (1.488 → 1.715 caratteri), rapporto 11,27 (19.335 / 1.715).
    // `chiSei` non è cambiato: `persona.md`/`identity.md`/`voice.md` restano
    // gli stessi file. La soglia scende con la misura invece di essere
    // aggirata, e l'affermazione che il test fa — v1 è pesantemente carattere,
    // v2 no — regge identica: 11,27 contro il `< 8` di v2 sotto, che è la
    // riga che porta il peso.
    // Ri-misurato 2026-09-08 (DAY-1 cutover, «dimentica X»): la stessa riga
    // nomina `memory_forget` come la porta per dimenticare, mai shell/sqlite —
    // il difetto misurato in REPL viva quel giorno — (1.715 → 1.858 caratteri),
    // rapporto 10,41 (19.335 / 1.858). Stessa regola: la soglia scende con la
    // misura, e v1 resta pesantemente carattere contro il `< 8` di v2.
    expect(v1.chiSei / v1.comeLavori).toBeGreaterThan(10);
    expect(v2.chiSei / v2.comeLavori).toBeLessThan(8);
    // E il prompt non è cresciuto per farlo: il peso si è spostato.
    expect(v2.chiSei + v2.comeLavori).toBeLessThan((v1.chiSei + v1.comeLavori) * 1.02);
  });
});

describe('what a group turn is allowed to be told', () => {
  it("carries nothing from the owner's identity file", () => {
    // Found while fixing this suite for c090dce (2026-08-17): the injected
    // heading used to be `'## Chi sei\n'`, which does not occur in the real
    // `identity.md` — its heading is `'## Chi sei per me\n'` — so the
    // `.replace()` below was a silent no-op and the two `toContain` assertions
    // on `owner` passed anyway, because "Sei il mio secondo cervello" is *also*
    // verbatim real prose at `identity.md:11`. The test read green for the
    // wrong reason. Fixed to the real heading, with a marker string that
    // cannot coincidentally already be in the file.
    const home = bootHome();
    const identity = join(paths(home).rot, 'identity.md');
    writeFileSync(
      identity,
      readFileSync(identity, 'utf8').replace(
        '## Chi sei per me\n',
        '## Chi sei per me\n\nMARCATORE-IDENTITY-SOLO-OWNER.\n',
      ),
    );
    const runtime = boot(home);
    try {
      const { owner, group } = runtime.deps.systemPrompts;
      // Present on the owner side, so the absence below is a filter and not a
      // file that failed to load.
      expect(owner).toContain('MARCATORE-IDENTITY-SOLO-OWNER');
      expect(owner).toContain('Non mi dai ragione per farmi contento');
      expect(group).not.toContain('MARCATORE-IDENTITY-SOLO-OWNER');
      expect(group).not.toContain('Non mi dai ragione per farmi contento');
    } finally {
      runtime.close();
    }
  });

  it("never carries persona.md's owner-facing content into the group prompt", () => {
    // 2026-08-17 (`slice/identita`): this used to check for a specific section,
    // "Al primo incontro" — 1,330 characters of the *old template* persona.md
    // that instructed the agent to elicit name and occupation, one piece at a
    // time. Commit c090dce replaced persona.md with the owner's real text,
    // which does not have that section at all any more (a defensible rewrite,
    // not a regression: the historical defect this whole module exists to
    // close was never about that one section — it was `persona.md` reaching
    // the group *at all*, whatever it happens to say this month). So this now
    // asserts the general property directly: three sentences unique to the
    // current `persona.md` (verified absent from `voice.md`, `identity.md` and
    // every hardcoded block in this file) are addressed to the owner and must
    // never reach a stranger.
    const runtime = boot(bootHome());
    try {
      const { owner, group } = runtime.deps.systemPrompts;
      expect(owner).toContain('Sono una seconda prospettiva con memoria.');
      expect(owner).toContain('Mi importa della persona con cui vivo nel tempo');
      expect(owner).toContain('Il mio humour è secco, spontaneo e affettuoso.');

      expect(group).not.toContain('seconda prospettiva con memoria');
      expect(group).not.toContain('Mi importa della persona con cui vivo nel tempo');
      expect(group).not.toContain('Il mio humour è secco, spontaneo e affettuoso');
    } finally {
      runtime.close();
    }
  });

  it('states the guest posture instead of leaving the room undescribed', () => {
    const runtime = boot(bootHome());
    try {
      const { group } = runtime.deps.systemPrompts;
      expect(group).toContain('Sono Muffin');

      // Every phrase below is unique to the group persona. `/ospite/` was the
      // first assertion here and it was theatre: `voice.md` §"Quando parli in
      // gruppo" contains the word, so deleting the entire posture block from
      // the persona left this test — and the whole suite — green. Caught by
      // mutation, which is the only thing that catches this class.
      expect(group).toContain('## Dove sei adesso');
      // `\s+` across the phrases that wrap: the assertion is about the rule
      // being stated, not about where the paragraph happens to break.
      expect(group).toMatch(/non faccio domande per conoscere\s+chi c'è/);
      expect(group).toMatch(/Quello che so del mio owner non è materiale di conversazione/);
      expect(group).toMatch(/Non tratto chi scrive come il mio owner/);
    } finally {
      runtime.close();
    }
  });

  it('reuses the voice file rather than growing a second one for groups', () => {
    const home = bootHome();
    const runtime = boot(home);
    try {
      const { group } = runtime.deps.systemPrompts;
      // `voice.md` already knows how to behave in a group, and it is the file
      // whose staleness this repo has already paid for once — shipped, then
      // opened by nobody for months. A separate group voice would recreate
      // exactly that: two files, one of them rarely read.
      expect(group).toContain('Quando parlo in gruppo');
      expect(group).toContain('🧁 è ancora più raro in gruppo');
      // Byte-identical in both classes, not merely present in both — chiesto ai
      // blocchi e non a una fetta della stringa resa. Ritagliare da `# Voce`
      // fino a `## Come lavori` presupponeva che nulla si inserisse fra i due,
      // e il catalogo delle skill si è inserito lì: il test è andato rosso
      // mentre la proprietà che afferma era ancora vera. Il confronto fra i
      // blocchi nominati dice la stessa cosa e non si rompe quando l'assemblaggio
      // ne guadagna uno.
      const blocchi = buildSystemPromptBlocks(home, false);
      const voceOwner = blocchi.owner.find((b) => b.name === 'voice')?.text;
      const voceGruppo = blocchi.group.find((b) => b.name === 'voice')?.text;
      expect(voceOwner).toBeTruthy();
      expect(voceGruppo).toBe(voceOwner);
    } finally {
      runtime.close();
    }
  });

  it('does not advertise the skills a member cannot open', () => {
    const home = bootHome();
    const skillDir = join(home, 'skills', 'brief-giornata');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: brief-giornata\ndescription: Prepara il brief della giornata.\n---\n# Brief\nTre righe.\n`,
    );
    const runtime = boot(home);
    try {
      // `skill.read` is hostOnly, so the door is shut for a member by the
      // kernel. Listing the skills anyway is the same defect as showing the
      // tool: a catalogue of things the answer will be "no" to.
      expect(runtime.deps.systemPrompts.owner).toContain('brief-giornata');
      expect(runtime.deps.systemPrompts.group).not.toContain('brief-giornata');
    } finally {
      runtime.close();
    }
  });

  it('keeps the operational rules, which are not about the owner', () => {
    const runtime = boot(bootHome());
    try {
      const { group, owner } = runtime.deps.systemPrompts;
      // `#` e non `##`: i blocchi si concatenano e i primi aprono con `#`, e
      // un `##` qui finiva annidato sotto la sezione precedente — le regole sui
      // tool lette come una sottosezione della voce.
      expect(group).toContain('# Come lavori');
      expect(group).toContain('Non fingere di aver fatto');
      // The three rules added on 26/08 are about the turn too, so they belong
      // to both classes — `WORK_RULES` is one constant in both lists, and this
      // pins that it stays that way rather than being forked per class.
      for (const rule of [
        'lo chiede il kernel',
        'chiediti cosa è cambiato',
        'prima di partire',
      ]) {
        expect(group).toContain(rule);
        expect(owner).toContain(rule);
      }
      // Form rules apply everywhere: a second voice for groups is how the two
      // drift, and drift in this file is measured in emoji thresholds.
      expect(group).toContain('Niente azioni simulate');
    } finally {
      runtime.close();
    }
  });
});

/**
 * I pavimenti della stanza — la trappola scritta in `assemble.ts` e facile da
 * non vedere, resa un test.
 *
 * `voice.md` arriva a **tutte e due** le classi; `identity.md` solo all'owner.
 * Quindi una frase presente in entrambi non è un doppione: è **l'unica copia
 * che il gruppo riceve**, e cancellarla come ridondante toglie in silenzio un
 * pavimento alla stanza piena di sconosciuti mentre il prompt dell'owner
 * continua a sembrare a posto. `muffin prompt show --eco` misura la
 * sovrapposizione ma non conosce questa regola: misura, non decide.
 *
 * Sette regole, e per ognuna la sola cosa che serve sapere è dove ne vive
 * l'altra copia. Sono asserite **per versione**, così una potatura futura di
 * `defaults/v2/voice.md` che ne cancella una perché «c'è già in identity.md»
 * fallisce qui invece che nella chat di un estraneo.
 *
 * `identity.md` non ha una v2 (è sigillato), quindi la lista vale identica per
 * entrambe: è esattamente ciò che rende il confronto per versione utile.
 */
describe('i pavimenti che la stanza riceve solo da voice.md', () => {
  /**
   * `[regola, frase-o-forma nel prompt di gruppo, dove sta l'altra copia]`.
   *
   * Le forme sono regex e non stringhe intere perché il testo va a capo dove
   * capita: la proprietà è che la regola sia detta, non dove si spezza la riga.
   */
  const PAVIMENTI: readonly (readonly [string, RegExp, string])[] = [
    [
      'niente azioni simulate',
      /Se descrivo un'azione al passato,?\s+deve\s+esserci\s+evidenza/,
      "identity.md §«Cosa non fai mai»: «Non fingi di ricordare, aver visto, controllato, eseguito»",
    ],
    [
      '«non lo so» invece di una certezza falsa',
      /[«"]Non lo so[»"]\s+è\s+meglio\s+di\s+una\s+certezza\s+falsa/,
      'identity.md §«Come ti comporti quando è difficile»: «Quando non sai, dici che non sai»',
    ],
    [
      "un'inferenza si sente che è un'inferenza",
      /[«"]mi\s+sembra\s+che\.\.\.[»"]|ho\s+l'impressione\s+che/,
      'identity.md: «Non trasformi una tua inferenza su di me in un fatto»',
    ],
    [
      'niente terapeuta, coach, motivational speaker',
      /Non\s+faccio\s+il\s+motivational\s+speaker/,
      'identity.md: «Non fai il terapeuta, il coach o il motivational speaker»',
    ],
    [
      'niente linguaggio da assistente generico',
      /come\s+posso\s+aiutarti\?/,
      "persona.md, che al gruppo non arriva: «Un assistente cerca soprattutto di essere utile alla richiesta davanti a lui»",
    ],
    [
      'niente emozioni o continuità finte',
      /Non\s+fingo\s+continuità\s+emotiva/,
      "identity.md: «Non devi inventarti emozioni umane»; GROUP_PERSONA lo dice a sua volta, ed è la sola con due copie",
    ],
    [
      'la memoria non si ostenta',
      /Non\s+ostento\s+la\s+memoria/,
      'identity.md §«La relazione nel tempo»: «Non ostentare la memoria»',
    ],
  ];

  /**
   * E le tre che il gruppo riceve da un blocco che **cambia** fra le versioni.
   *
   * La distinzione crash/retry è il caso interessante: in v1 vive in
   * `voice.md` §«Niente azioni simulate» come regola di forma, in v2 è una
   * regola di lavoro in `WORK_RULES_V2`. Il pavimento è lo stesso e la stanza
   * lo riceve in tutte e due, da blocchi diversi — che è precisamente perché
   * questo si chiede al prompt di gruppo intero e non a un blocco per nome.
   */
  const PAVIMENTI_OPERATIVI: readonly (readonly [string, RegExp])[] = [
    ['tre esiti distinti dopo un crash', /potrebbe\s+essere\s+successo/],
    ['un tool negato si dice', /Non\s+fingere\s+di\s+aver\s+fatto|non\s+da\s+aggirare\s+in\s+silenzio/],
    ['un limite non si inventa', /non\s+invent(o|are)\s+una\s+policy\s+o\s+un\s+permesso/],
  ];

  for (const versione of PROMPT_VERSIONS) {
    it(`${versione}: la stanza li riceve tutti`, () => {
      const home = bootHome();
      const gruppo = renderSystemPrompts(buildSystemPromptBlocks(home, false, '', versione)).group;
      for (const [regola, forma, altraCopia] of PAVIMENTI) {
        expect(gruppo, `${regola} — altrove solo in: ${altraCopia}`).toMatch(forma);
      }
      for (const [regola, forma] of PAVIMENTI_OPERATIVI) {
        expect(gruppo, regola).toMatch(forma);
      }
      // E le regole di gruppo vere e proprie, che nessun altro blocco porta.
      expect(gruppo).toMatch(/In\s+gruppo\s+occupo\s+meno\s+spazio\s+che\s+in\s+privato/);
      expect(gruppo).toMatch(/Non\s+sono\s+il\s+filo\s+principale\s+della\s+conversazione/);
      expect(gruppo).toMatch(/informazioni\s+private\s+dell'owner\s+non\s+diventano\s+materiale/);
      expect(gruppo).toMatch(/🧁 è ancora più raro/);
    });

    it(`${versione}: e continua a non ricevere niente del patto dell'owner`, () => {
      const home = bootHome();
      const blocchi = buildSystemPromptBlocks(home, false, '', versione);
      const gruppo = renderSystemPrompts(blocchi).group;
      const owner = renderSystemPrompts(blocchi).owner;
      // Presente da una parte, assente dall'altra: senza la prima metà questo
      // sarebbe un test che passa perché il file non si è caricato.
      expect(owner).toContain('Non mi dai ragione per farmi contento');
      expect(gruppo).not.toContain('Non mi dai ragione per farmi contento');
      expect(gruppo).not.toContain('Sei il mio secondo cervello');
      expect(blocchi.group.map((b) => b.name)).not.toContain('identity');
    });
  }
});

describe('the tool list a principal is shown', () => {
  it('hides every host-only tool from a member', () => {
    const runtime = boot(bootHome());
    try {
      const all = runtime.deps.tools;
      const caps = runtime.deps.capabilities;
      const forMember = visibleTools(all, MEMBER, caps, undefined);

      expect(forMember.length).toBeGreaterThan(0);
      expect(forMember.length).toBeLessThan(all.length);
      for (const tool of forMember) {
        expect(caps?.get(tool.capability)?.hostOnly, tool.spec.name).toBe(false);
      }
      // And the shape of the loss is named, not just counted.
      const names = forMember.map((t) => t.spec.name);
      expect(names).toContain('memory_search');
      expect(names).not.toContain('fs_read');
      expect(names).not.toContain('fs_write');
      expect(names).not.toContain('skill_read');
    } finally {
      runtime.close();
    }
  });

  it('hides nothing from the owner, the scheduler or the dev agent', () => {
    const runtime = boot(bootHome());
    try {
      const all = runtime.deps.tools;
      const caps = runtime.deps.capabilities;
      expect(visibleTools(all, OWNER, caps, undefined)).toEqual(all);
      expect(visibleTools(all, { kind: 'system', source: 'scheduler' }, caps, undefined)).toEqual(all);
      expect(visibleTools(all, { kind: 'agent', role: 'dev' }, caps, undefined)).toEqual(all);
    } finally {
      runtime.close();
    }
  });

  it('agrees with the kernel in both directions, without being the kernel', () => {
    // Defence in depth only means something if the two depths agree. The filter
    // is derived from the same declarations `decide.ts:132` reads, so this
    // cross-check fails the moment they diverge — and it reads the real
    // assembled `decide`, never a hand-built one.
    const runtime = boot(bootHome());
    try {
      const { tools, capabilities, decide } = runtime.deps;
      const shown = new Set(visibleTools(tools, MEMBER, capabilities, undefined).map((t) => t.spec.name));
      let refused = 0;
      for (const tool of tools) {
        const decision = decide({
          principal: MEMBER,
          tenant: MEMBER.tenantId,
          capability: tool.capability,
          resource: { kind: 'none' },
          args: {},
          taint: 2,
        });
        const hostOnlyRefusal =
          decision.effect === 'deny' && decision.detail === 'host-only capability';
        if (hostOnlyRefusal) refused += 1;
        // Shown ⇒ not refused for being host-only; refused ⇒ not shown.
        expect(shown.has(tool.spec.name), tool.spec.name).toBe(!hostOnlyRefusal);
      }
      expect(refused).toBeGreaterThan(0);
    } finally {
      runtime.close();
    }
  });

  it('hides an undeclared capability from a member rather than betting on it', () => {
    // The kernel answers `no_capability` for everyone, so hiding it from the
    // member costs nothing and keeps the direction of the failure fail-closed.
    const runtime = boot(bootHome());
    try {
      const rogue = { ...runtime.deps.tools[0]!, capability: 'not.declared' };
      const shown = visibleTools([rogue], MEMBER, runtime.deps.capabilities, undefined);
      expect(shown).toEqual([]);
      expect(visibleTools([rogue], OWNER, runtime.deps.capabilities, undefined)).toEqual([rogue]);
    } finally {
      runtime.close();
    }
  });

  it('shows a member nothing when declarations are absent, rather than everything', () => {
    // `capabilities` is mandatory on `LoopDeps` now — no real construction site
    // can omit it, and `tsc` refuses the build if one tries (proven outside
    // this file: reverting the field to optional and dropping it from
    // `agent/runtime.ts`'s construction of `deps` is a compile error).
    //
    // This test is the second, independent line of defence for a caller that
    // reaches `visibleTools` from outside the type checker — a `.js` importer,
    // an `as any` — which is the only way `capabilities` can still be falsy
    // here. Before this slice that path filtered *nothing* and handed a member
    // every host-only tool by name; it must now fail closed. Mutating the
    // guard back to `return tools` reproduces exactly that regression and
    // turns this test red.
    const runtime = boot(bootHome());
    try {
      const senzaTipo = undefined as unknown as typeof runtime.deps.capabilities;
      expect(visibleTools(runtime.deps.tools, MEMBER, senzaTipo, undefined)).toEqual([]);
      // The owner is never filtered, absence of declarations or not.
      expect(visibleTools(runtime.deps.tools, OWNER, senzaTipo, undefined)).toEqual(runtime.deps.tools);
    } finally {
      runtime.close();
    }
  });
});
