import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDecide } from './decide.js';
import { POLICY_FLOOR, ROW_FLOOR } from './matrix.js';
import type { CapabilityDecl, Decision, DecisionRequest, Principal, TrustTier } from './types.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { shellCapability, shellWriteCapability } from '../../agent/tools/shell.js';
import { processCapabilities } from '../../agent/tools/process.js';
import { sendFileCapability } from '../../agent/tools/deliver.js';
import { httpCapability } from '../../agent/tools/http.js';
import { searchCapability } from '../../agent/tools/search.js';
import { memoryCapability } from '../../agent/tools/memory.js';
import { memoryForgetCapability } from '../../agent/tools/memory-forget.js';
import { skillCapability } from '../../agent/tools/skill.js';
import { documentCapability } from '../../agent/tools/document.js';
import { inspectCapability } from '../../agent/tools/inspect.js';
import { effectsCapability } from '../../agent/tools/effects.js';
import { todoCapability } from '../../agent/tools/todo.js';
import { waitCapability } from '../../agent/tools/wait.js';
import { vaultWriteCapability } from '../../agent/tools/vault-save.js';
import { mcpCapabilityFor } from '../../agent/tools/mcp.js';
import { DOORS } from './doors.js';

/**
 * The normative matrix, executed.
 *
 * `docs/history/rebuild-2026/03-threat-model.md` §3 prints a table whose rows are
 * **effect classes** — where the bytes of an effect end up — and whose columns
 * are the turn's taint. The kernel used to decide from a risk class plus a
 * number pinned by hand on each declaration, and the two drifted apart in
 * silence: the row "Shell / filesystem host / processi" reads `ASK` at taint 2,
 * and only `sys.shell` ever got that cell, by an amendment written one
 * capability at a time (ADR-0044 §revisione 2026-08-16). `fs.write` and
 * `sys.process.kill` sit on the same row and kept inheriting the medium/high
 * class default of 1, so they answered `deny` where the matrix says `ask` —
 * measured on the real binary in
 * `evals/acceptance/scenarios/b-parita-superfici.accept.ts`.
 *
 * This file is the guard that makes that drift impossible to repeat: every
 * shipped declaration names its row, and every cell of the matrix is asserted
 * against the kernel's own answer. Move a row in the document without moving
 * the table here, pin a `maxTaint` that contradicts a row — or one on a
 * reversible read, which ADR-0075 forbids outright — or ship a capability this
 * file has never heard of, and it goes red.
 *
 * **What it does not cover**, stated because a guard that is trusted further
 * than it reaches is worse than none: `decisionAt` asks as the owner, hardened,
 * with the allowlist open and the budget fine. Non-owner principals, safe mode,
 * the non-hardened auto-allow and the off-allowlist branch are asserted in
 * `decide.test.ts`, not here.
 */

const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const TIERS: readonly TrustTier[] = [0, 1, 2, 3];

const ALL: readonly CapabilityDecl[] = [
  ...fsCapabilities,
  shellCapability,
  shellWriteCapability,
  ...processCapabilities,
  sendFileCapability,
  httpCapability,
  searchCapability,
  memoryCapability,
  memoryForgetCapability,
  skillCapability,
  documentCapability,
  inspectCapability,
  effectsCapability,
  todoCapability,
  waitCapability,
  vaultWriteCapability,
  mcpCapabilityFor('esempio'),
  // The two doors: declared without a tool, asserted against their rows like
  // everything else (ADR-0055).
  ...DOORS,
];

function resourceFor(decl: CapabilityDecl): DecisionRequest['resource'] {
  switch (decl.resourceKind) {
    case 'path':
      return { kind: 'path', value: '/tmp/scope/nota.txt' };
    case 'url':
      return { kind: 'url', value: 'https://esempio.test/pagina' };
    case 'url-read':
      return { kind: 'url-read', value: 'https://esempio.test/pagina' };
    case 'query':
      return { kind: 'query', value: 'il tempo di domani' };
    case 'tenant':
      return { kind: 'tenant', value: 'host' };
    default:
      return { kind: 'none' };
  }
}

/** Hardened and owner: the most permissive context there is, so a refusal here is the ceiling talking. */
function decisionAt(decl: CapabilityDecl, taint: TrustTier): Decision {
  const decide = createDecide({
    capabilities: new Map([[decl.id, decl]]),
    matrix: POLICY_FLOOR,
    budgetExhausted: () => false,
    hardened: true,
    egressAllowed: () => true,
  });
  return decide({
    principal: OWNER,
    tenant: 'host',
    capability: decl.id,
    resource: resourceFor(decl),
    args: {},
    taint,
  });
}

/**
 * The matrix, as a ceiling per row plus the answer to *does irreversibility
 * matter here*. `denyAbove` is the taint above which the capability is out of
 * reach entirely (`3` = the matrix does not constrain that column, `-1` =
 * never). `asksForIrreversible` replaced `askAbove` in ADR-0074: an `ask` is
 * produced by a `reversible: 'no'` declaration on a row that says `true`, and
 * by nothing else — the taint denies above the ceiling and no longer converts
 * an `allow` or a `draft` into a question.
 */
const MATRICE = {
  /** Bytes enter the turn; nothing leaves and nothing on the host changes. */
  context: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * "Shell / filesystem host / processi": chiede per ciò che non ha un undo
   * (ADR-0074) e **non nega più per taint** (ADR-0075: `denyAbove` 2 → 3).
   * Ogni capability della riga risponde a taint 3 come a taint 0, perché ogni
   * capability della riga è già coperta da un'altra difesa — giornale e undo,
   * il sandbox in sola lettura, o un `ask` che arriva comunque.
   */
  host: { asksForIrreversible: true, denyAbove: 3 },
  /** "Reply sul canale di origine": ALLOW · ALLOW · ALLOW. Una risposta è la conversazione stessa. */
  reply: { asksForIrreversible: false, denyAbove: 3 },
  /** "Egress rete": the allowlist and `paramsMaxTaint`/`searchMaxTaint` own this row's columns. */
  egress: { asksForIrreversible: false, denyAbove: 3 },
  /** "Scrittura memoria (episodi/fatti)": ALLOW · ALLOW nel tenant · ALLOW. */
  memory: { asksForIrreversible: false, denyAbove: 3 },
  /**
   * ADR-0073 punto 2 — «scrivere nel vault del proprio tenant». Riga nuova, e
   * non una trascrizione: la matrice stampata non la conosce, perché fino al
   * 06/09 nessuna scrittura durevole era deliberata. Il soffitto è alto e la
   * domanda è spenta **per dichiarazione**: byte che restano dentro il
   * confine di chi li scrive, con giornale e `muffin undo` dietro, non
   * attraversano mai un `ask`. La mutazione da far cadere è portarla al
   * livello delle righe di rete (`denyAbove: 1`), che negherebbe un membro a
   * tier 2 — provata per nome in `solo-irreversibile.test.ts`.
   */
  vault: { asksForIrreversible: false, denyAbove: 3 },
  /** Third-party code outside the allowlist model (MCP). Not a printed row: keeps today's number. */
  external: { asksForIrreversible: true, denyAbove: 1 },
  /** "Outward (mail, messaggi a terzi, pubblicazione)": DRAFT · DENY · DENY. */
  outward: { asksForIrreversible: true, denyAbove: 1 },
  /** "Scrittura config/voice (cricchetto)": ALLOW solo via ratchet · DENY · DENY. */
  config: { asksForIrreversible: true, denyAbove: 1 },
  /** "Root of Trust": DENY a runtime per chiunque. */
  rot: { asksForIrreversible: true, denyAbove: -1 },
} as const;

describe('la matrice normativa è eseguibile', () => {
  it('ogni capability dichiara la riga di effetto a cui appartiene', () => {
    const senzaRiga = ALL.filter((d) => !(d.effect in MATRICE));
    expect(senzaRiga.map((d) => d.id)).toEqual([]);
  });

  it.each(ALL.map((d) => [d.id, d] as const))(
    '%s risponde come dice la sua riga, a ogni taint',
    (_id, decl) => {
      const riga = MATRICE[decl.effect];
      // Una dichiarazione può stringere la propria riga, mai allargarla: il
      // file sigillato e la dichiarazione non sono lo stesso dominio di
      // fiducia, e il knob per capability è esattamente ciò che ha prodotto la
      // deriva (matrix.ts, §"defaultMaxTaint è clampato verso il basso").
      const denyAbove = Math.min(riga.denyAbove, decl.maxTaint ?? 3);
      // ADR-0074: sotto il soffitto l'esito non dipende più dal taint. La
      // stessa capability risponde la stessa cosa a taint 0 e a taint 2, e
      // quella cosa è `ask` se e solo se non si può annullare su una riga
      // dove l'irreversibilità conta.
      const atteso = decl.reversible === 'no' && riga.asksForIrreversible ? 'ask' : 'non-deny';
      for (const taint of TIERS) {
        const d = decisionAt(decl, taint);
        if (taint > denyAbove) {
          // ADR-0075 punto 3: sopra il soffitto delle due righe che portano
          // byte **fuori dal tenant**, l'owner — che è il principal di questo
          // file — riceve una domanda invece di un muro, e il prompt cita il
          // taint. Per ogni altra riga, e per ogni altro principal (provato in
          // `solo-irreversibile.test.ts`), il rifiuto non si muove.
          const fuori = decl.effect === 'external' || decl.effect === 'outward';
          expect(`${decl.id}@${taint}:${d.effect}`).toBe(`${decl.id}@${taint}:${fuori ? 'ask' : 'deny'}`);
          if (fuori && d.effect === 'ask') {
            expect(`${decl.id}@${taint}:${d.ask.prompt}`).toContain(`taint ${taint}`);
          }
          continue;
        }
        if (atteso === 'ask') {
          expect(`${decl.id}@${taint}:${d.effect}`).toBe(`${decl.id}@${taint}:ask`);
          continue;
        }
        expect(`${decl.id}@${taint}:${d.effect}`).not.toBe(`${decl.id}@${taint}:deny`);
        expect(`${decl.id}@${taint}:${d.effect}`).not.toBe(`${decl.id}@${taint}:ask`);
      }
    },
  );

  /**
   * La riga sopra è un oracolo, quindi il ciclo parametrizzato non può vedere
   * una dichiarazione che *contraddice* la propria riga: `Math.min` la assorbe
   * in silenzio, esattamente come fa il kernel. Questo è il rifiuto a voce
   * alta che `types.ts` e ADR-0053 promettono — misurato mancante da un
   * giudice indipendente il 02/09, che ha pinnato `fs.write` a 3 e ha visto
   * 19 test su 19 restare verdi.
   */
  it('nessuna dichiarazione appunta un `maxTaint` più largo della propria riga', () => {
    const larghe = ALL.filter(
      (d) => d.maxTaint !== undefined && d.maxTaint > MATRICE[d.effect].denyAbove,
    ).map(
      (d) =>
        `${d.id}: maxTaint ${String(d.maxTaint)} > riga ${d.effect} (${MATRICE[d.effect].denyAbove})`,
    );
    expect(larghe).toEqual([]);
  });

  /**
   * **Le due strette esplicite non ci sono più, e questo è il posto dove si
   * dice perché — ADR-0075 punto 2.**
   *
   * Fino al 06/09 questo test asseriva l'opposto: `skill.read` e
   * `sys.process.list` pinnavano `maxTaint: 1`, e la ragione scritta qui era
   * che un giro di pulizia le avrebbe tolte come «ridondanti» portandole da 1
   * a 3 senza che nient'altro nella suite lo dicesse. La ragione era buona e
   * la conclusione è cambiata per una misura, non per una pulizia: quel numero
   * non comprava sicurezza da nessuna parte. Sono **letture** — riga
   * `context`, `reversible: 'yes'`, niente che esca dal tenant e niente da
   * disfare — e l'unica cosa che il pin faceva era rendere Muffin incapace di
   * aprire le proprie skill o di guardare i propri processi per tutto il resto
   * di un turno che aveva letto una pagina web (nove turni su quattordici, il
   * 06/09, sull'installazione dell'owner).
   *
   * La regola che resta, ed è quella che il test asserisce adesso: **un
   * `maxTaint` non stringe mai una capability reversibile.** Una stretta per
   * capability è ancora lecita dove la riga stessa nega (`external`,
   * `outward`) o dove esiste un cancello di egress (`searchMaxTaint`,
   * `paramsMaxTaint`), e il test sopra continua a rifiutare a voce alta un
   * `maxTaint` più largo della propria riga. Rimettere un pin qui va contro
   * ADR-0075 e questo test lo dice per nome.
   */
  it('nessuna lettura reversibile porta più un maxTaint, e a taint 3 risponde', () => {
    expect(skillCapability.maxTaint).toBeUndefined();
    expect(processCapabilities.find((d) => d.id === 'sys.process.list')?.maxTaint).toBeUndefined();
    // Il pin era la sola cosa fra queste due e un turno a livello 3: senza,
    // rispondono. È la metà che un `toBeUndefined()` da solo non prova.
    for (const decl of [skillCapability, ...processCapabilities.filter((d) => d.id === 'sys.process.list')]) {
      expect(`${decl.id}@3: ${decisionAt(decl, 3).effect}`).toBe(`${decl.id}@3: allow`);
    }
    // E la regola in generale, su tutto ciò che questo repository spedisce:
    // un `maxTaint` sopravvive solo su una dichiarazione che non è reversibile
    // o che sta su una riga dove il taint ha ancora un cancello suo.
    const reversibiliConPin = ALL.filter(
      (d) => d.maxTaint !== undefined && d.reversible !== 'no' && MATRICE[d.effect].denyAbove === 3,
    ).map((d) => `${d.id}: maxTaint ${String(d.maxTaint)} su una lettura reversibile`);
    expect(reversibiliConPin).toEqual([]);
  });

  /**
   * L'elenco `ALL` è scritto a mano, quindi una capability nuova in un file
   * nuovo sarebbe invisibile a tutto ciò che sta sopra. Questo la rende
   * visibile: il rosso arriva quando una dichiarazione esportata da
   * `agent/tools/` non è stata aggiunta qui.
   */
  it('ogni dichiarazione esportata da agent/tools è in questo elenco', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'tools');
    const esportate: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/export (?:const|function) (\w+)[^\n]*CapabilityDecl/g)) {
        esportate.push(`${file}:${m[1] ?? ''}`);
      }
    }
    // Una per file di tool che ne dichiara: se ne compare una nuova, va
    // aggiunta a `ALL` sopra, e allora questo elenco torna a coincidere.
    expect(esportate.sort()).toEqual(
      [
        'deliver.ts:sendFileCapability',
        'document.ts:documentCapability',
        'effects.ts:effectsCapability',
        'fs.ts:fsCapabilities',
        'http.ts:httpCapability',
        'inspect.ts:inspectCapability',
        'mcp.ts:mcpCapabilityFor',
        'memory.ts:memoryCapability',
        'memory-forget.ts:memoryForgetCapability',
        'process.ts:processCapabilities',
        'search.ts:searchCapability',
        'shell.ts:shellCapability',
        'shell.ts:shellWriteCapability',
        'skill.ts:skillCapability',
        'todo.ts:todoCapability',
        'vault-save.ts:vaultWriteCapability',
        'wait.ts:waitCapability',
      ].sort(),
    );
  });

  /**
   * ADR-0074 punto 4, come cella e non come frase: le due corsie della shell stanno
   * sulla **stessa riga** (`host`, stesso soffitto, stesse conseguenze se
   * qualcosa scappa) e danno risposte diverse allo stesso taint, perché il
   * confine che le separa è quello che il sandbox costruisce — scrittura e
   * rete — non il nome della capability.
   *
   * Con i punti 1 e 2 della stessa ADR sul kernel, la cella vale a ogni taint
   * sotto il soffitto: il ciclo parametrizzato sopra lo prova contro l'oracolo
   * `MATRICE`, qui si nominano le due corsie una accanto all'altra.
   */
  it('la corsia in sola lettura non chiede dove quella che scrive chiede', () => {
    for (const taint of [0, 1, 2] as const) {
      expect(`sys.shell@${taint}:${decisionAt(shellCapability, taint).effect}`).toBe(
        `sys.shell@${taint}:allow`,
      );
      expect(`sys.shell.write@${taint}:${decisionAt(shellWriteCapability, taint).effect}`).toBe(
        `sys.shell.write@${taint}:ask`,
      );
    }
    // E il perché, dichiarato: `ask` ⇔ irreversibile.
    expect(shellCapability.reversible).toBe('yes');
    expect(shellWriteCapability.reversible).toBe('no');
  });

  /**
   * Le tre capability della riga `host`/`reply` che ADR-0053 aveva allineato,
   * riscritte da ADR-0074 sul punto che è cambiato: **quale delle due porte
   * sullo stesso sink chiede**.
   *
   * ADR-0053 le aveva portate tutte e tre allo stesso verdetto a taint 2
   * (`ask`, `ask`, `allow`) perché il taint era la ragione. ADR-0074 toglie
   * quella ragione e mette al suo posto l'unica differenza che conta fra le
   * due porte sull'host: `fs.write` fa una copia prima di scrivere e
   * `muffin undo` la rimette, `sys.process.kill` no. Quindi `fs.write`
   * diventa `draft` — a *ogni* taint sotto il soffitto, non solo a 0 — e
   * `sys.process.kill` resta `ask`, anche a taint 0, anche in hardened.
   */
  it('le tre capability che ADR-0053 ha allineato, riscritte da ADR-0074', () => {
    const write = fsCapabilities.find((d) => d.id === 'fs.write');
    const kill = processCapabilities.find((d) => d.id === 'sys.process.kill');
    if (!write || !kill) throw new Error('dichiarazione mancante');
    // Ha un undo: mai una domanda, a nessun taint raggiungibile.
    expect([0, 1, 2].map((t) => decisionAt(write, t as TrustTier).effect)).toEqual([
      'draft',
      'draft',
      'draft',
    ]);
    // Non ha un undo: sempre una domanda, taint 0 e hardened compresi.
    expect([0, 1, 2].map((t) => decisionAt(kill, t as TrustTier).effect)).toEqual([
      'ask',
      'ask',
      'ask',
    ]);
    // Riga `reply`: irreversibile per dichiarazione, e la riga dice che qui
    // non conta — la risposta è la conversazione stessa.
    expect(decisionAt(sendFileCapability, 2).effect).toBe('allow');
  });
});

/**
 * ADR-0070 — "il modello non deve poter cambiare le impostazioni", eseguita.
 *
 * `muffin config set` (e `/config` in `agent/comandi.ts`) scrivono
 * `config.json` senza passare da qui: sono comandi che i connector
 * intercettano prima di interrogare il modello, non tool che il modello può
 * scegliere di chiamare. Questo test legge la stessa affermazione dal lato del
 * kernel — `ALL` è l'enumerazione che il file sopra usa per provare la
 * matrice cella per cella, cioè ogni `CapabilityDecl` che un turno può
 * davvero invocare — e prova che nessuna vi appartiene sulla riga `config`.
 *
 * Falsificato a mano il 04/09/2026: aggiunta una `CapabilityDecl` finta con
 * `effect: 'config'` all'array `ALL` qui sopra, e questo test è diventato
 * rosso su `expected [...] to not contain 'config'` — l'unica asserzione che
 * lo nota, perché è l'unica che guarda questo campo su ogni dichiarazione. Il
 * resto della suite (compreso il file sopra) non si accorge di una capability
 * sulla riga `config`: la matrice sa deciderla, ma nessun test le negava
 * l'esistenza prima di questo.
 */
describe('il modello non ha una porta sulla riga "config" (ADR-0070)', () => {
  it('nessuna CapabilityDecl spedita dichiara effect: "config"', () => {
    const righe = ALL.map((d) => d.effect);
    expect(righe).not.toContain('config');
  });

  it('la riga "config" della matrice resta riservata: chiede per ciò che non si annulla, DENY sopra taint 1', () => {
    expect(ROW_FLOOR.config).toEqual({ asksForIrreversible: true, denyAbove: 1 });
  });
});
