import { describe, expect, it } from 'vitest';
import { createDecide } from './decide.js';
import { POLICY_FLOOR, ROW_FLOOR } from './matrix.js';
import type {
  CapabilityDecl,
  Decision,
  DecisionRequest,
  EffectRow,
  Principal,
  TrustTier,
} from './types.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { shellCapability, shellWriteCapability } from '../../agent/tools/shell.js';
import { processCapabilities } from '../../agent/tools/process.js';
import { sendFileCapability } from '../../agent/tools/deliver.js';
import { httpCapability } from '../../agent/tools/http.js';
import { searchCapability } from '../../agent/tools/search.js';
import { memoryCapability } from '../../agent/tools/memory.js';
import { skillCapability } from '../../agent/tools/skill.js';
import { documentCapability } from '../../agent/tools/document.js';
import { inspectCapability } from '../../agent/tools/inspect.js';
import { todoCapability } from '../../agent/tools/todo.js';
import { waitCapability } from '../../agent/tools/wait.js';
import { mcpCapabilityFor } from '../../agent/tools/mcp.js';
import { DOORS } from './doors.js';

/**
 * **ADR-0074 punto 1, eseguito su ogni capability che questo repository
 * spedisce: si chiede solo per l'irreversibile, e il taint non chiede mai.**
 *
 * `effect-rows.test.ts` prova la *matrice* — che ogni dichiarazione risponda
 * come dice la sua riga. Questo file prova la *regola*, che è
 * un'affermazione diversa e più forte: qualunque sia la riga, l'esito sotto il
 * soffitto è `ask` **se e solo se** `reversible: 'no'` incontra una riga con
 * `asksForIrreversible`. Un oracolo che leggesse la matrice non potrebbe dirlo:
 * direbbe solo che il kernel e la tabella sono d'accordo fra loro.
 *
 * La ragione per cui la regola ha bisogno di una prova sua, e non di una riga
 * in più altrove, è quella che l'ADR misura: **tutte** le 35 approvazioni mai
 * chieste sull'installazione vera erano `sys.shell` a taint 2, concesse 32
 * volte. Un cancello concesso nove volte su dieci non e' una decisione, e ciò
 * che veniva davvero fermato — `fs.write`, che ha una copia e un `muffin
 * undo` — non era la cosa che non si può disfare.
 *
 * **I quattro falsificatori**, ciascuno provato da un `it` qui sotto:
 *
 * 1. una capability con undo (`reversible !== 'no'`) che chiede, a un
 *    qualunque taint sotto il soffitto;
 * 2. una `reversible: 'no'` su `host`/`external`/`outward` che **non** chiede,
 *    owner compreso, `hardened` compreso, taint 0 compreso;
 * 3. `surface.reply` o `memory.write` che chiedono — una domanda che nessuno
 *    può ricevere, perché la risposta e' il canale su cui la si porrebbe;
 * 4. un esito che cambia col taint sotto il soffitto: il taint decide il
 *    soffitto (`denyAbove`, ADR-0044) e nient'altro.
 *
 * Le tre mutazioni che lo fanno cadere, verificate a mano su questa fetta:
 * rimettere un `askAbove` equivalente sulla riga `host`; rimettere la
 * scorciatoia `hardened && owner && taint === 0 -> allow`; mettere
 * `asksForIrreversible: true` sulla riga `reply`.
 */

const OWNER: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
/**
 * Un membro di un gruppo, il principal che l'ADR nomina accanto all'owner.
 * `tierOf(member)` vale 2 per costruzione, ma qui il taint si passa a mano su
 * tutta la scala: un piano su cui il taint non conta va provato su ogni taint,
 * non su quello che quel principal raggiunge di solito.
 */
const MEMBER: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:42',
  externalId: 'u1',
};
const TIERS: readonly TrustTier[] = [0, 1, 2, 3];

/**
 * Ogni `CapabilityDecl` che un turno può davvero invocare, raccolta dai file
 * che le dichiarano. Lo stesso elenco di `effect-rows.test.ts`, dove un test
 * legge `agent/tools/*.ts` e va rosso se una dichiarazione esportata non e'
 * stata aggiunta — quel guardiano copre anche questo file, perché l'elenco e'
 * lo stesso e una capability nuova va aggiunta in tutti e due.
 */
const ALL: readonly CapabilityDecl[] = [
  ...fsCapabilities,
  shellCapability,
  shellWriteCapability,
  ...processCapabilities,
  sendFileCapability,
  httpCapability,
  searchCapability,
  memoryCapability,
  skillCapability,
  documentCapability,
  inspectCapability,
  todoCapability,
  waitCapability,
  mcpCapabilityFor('esempio'),
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
      return { kind: 'tenant', value: decl.hostOnly ? 'host' : 'host' };
    default:
      return { kind: 'none' };
  }
}

/**
 * `hardened: true` **sempre**, ed e' il punto 2 dell'ADR: la modalità della
 * radice di fiducia era l'unica scorciatoia capace di saltare del tutto un
 * `ask`, e la si prova nella configurazione in cui saltava.
 *
 * L'allowlist e' aperta e il budget e' pieno perché altrimenti si misurerebbe
 * un altro cancello: il gate di egress (ADR-0071/0072) e' fuori da questa
 * fetta e ha i suoi test in `decide.test.ts`.
 */
function decisione(decl: CapabilityDecl, taint: TrustTier, principal: Principal): Decision {
  const decide = createDecide({
    capabilities: new Map([[decl.id, decl]]),
    matrix: POLICY_FLOOR,
    budgetExhausted: () => false,
    hardened: true,
    egressAllowed: () => true,
  });
  return decide({
    principal,
    tenant: principal.kind === 'member' ? principal.tenantId : 'host',
    capability: decl.id,
    resource: resourceFor(decl),
    args: {},
    taint,
  });
}

/** Le righe su cui l'irreversibilità decide, lette dal pavimento e non riscritte a mano. */
const CHIEDE: ReadonlySet<EffectRow> = new Set(
  (Object.entries(ROW_FLOOR) as Array<[EffectRow, { asksForIrreversible: boolean }]>)
    .filter(([, r]) => r.asksForIrreversible)
    .map(([name]) => name),
);

describe('si chiede solo per l irreversibile — ADR-0074, ogni capability spedita', () => {
  it('le righe che chiedono sono esattamente host, external, outward, config, rot', () => {
    // Ancorata qui perché tutto il resto del file ne dipende: se qualcuno
    // spegne `asksForIrreversible` su `host`, i cicli sotto smettono di
    // pretendere un `ask` senza andare rossi, e questa riga e' cio' che lo
    // nota. `config` e `rot` non hanno dichiarazioni spedite (ADR-0070) e
    // restano com'erano.
    expect([...CHIEDE].sort()).toEqual(['config', 'external', 'host', 'outward', 'rot']);
    // E le quattro che NON chiedono, per nome, perché sono la meta' della
    // decisione che si perde piu' facilmente in un giro di pulizia.
    expect(ROW_FLOOR.context.asksForIrreversible).toBe(false);
    expect(ROW_FLOOR.reply.asksForIrreversible).toBe(false);
    expect(ROW_FLOOR.memory.asksForIrreversible).toBe(false);
    expect(ROW_FLOOR.egress.asksForIrreversible).toBe(false);
  });

  it.each(ALL.map((d) => [d.id, d] as const))(
    '%s: mai un ask per ciò che si annulla, sempre uno per ciò che non si annulla su una riga che conta',
    (_id, decl) => {
      const soffitto = Math.min(ROW_FLOOR[decl.effect].denyAbove, decl.maxTaint ?? 3);
      const deveChiedere = decl.reversible === 'no' && CHIEDE.has(decl.effect);

      for (const taint of TIERS) {
        for (const principal of [OWNER, MEMBER]) {
          const d = decisione(decl, taint, principal);
          const dove = `${decl.id}@taint${taint}/${principal.kind}`;

          // Un membro non raggiunge una capability `hostOnly`, e non e' questo
          // il piano che si sta misurando: quel rifiuto e' il confine dei
          // tenant, provato da `decide.test.ts`.
          if (principal.kind === 'member' && decl.hostOnly) {
            expect(`${dove}:${d.effect}`).toBe(`${dove}:deny`);
            continue;
          }
          // Sopra il soffitto della riga il taint nega, e continua a negare:
          // ADR-0044 non e' cambiata.
          if (taint > soffitto) {
            expect(`${dove}:${d.effect}`).toBe(`${dove}:deny`);
            continue;
          }
          expect(`${dove}:${d.effect}`).toBe(
            `${dove}:${deveChiedere ? 'ask' : d.effect === 'ask' ? 'NON-ask' : d.effect}`,
          );
        }
      }
    },
  );

  /**
   * La stessa affermazione detta al contrario, perché l'`it.each` sopra e'
   * parametrico e un errore nell'oracolo lo attraverserebbe in silenzio: qui
   * l'elenco delle capability che chiedono e' scritto **per nome**.
   *
   * Tre, e sono le tre cose che questa installazione non sa disfare: un
   * comando di shell che scrive nel workspace (`sys.shell.write`; la corsia in
   * sola lettura di ADR-0074 punto 4 non è fra loro, perché è reversibile per
   * costruzione), un processo terminato, una chiamata a un server MCP di cui
   * non possediamo la semantica. `mcp.*` e' `reversible: 'no'` a mano su
   * ogni server ed e' la meta' che ADR-0074 punto 5 (altra fetta) sistema
   * leggendo `readOnlyHint` dal protocollo; finché quella non atterra, ogni
   * chiamata MCP chiede, ed e' la conseguenza dichiarata dell'ADR, non una
   * sorpresa di questa.
   */
  it('le capability che chiedono, per nome: shell che scrive, kill, MCP — e nessun altra', () => {
    const chiedono = ALL.filter((d) => decisione(d, 0, OWNER).effect === 'ask').map((d) => d.id);
    expect(chiedono.sort()).toEqual(['mcp.esempio', 'sys.process.kill', 'sys.shell.write']);
  });

  /**
   * Il falsificatore del punto 1 nella sua forma piu' diretta: le scritture
   * con undo. `fs.write` fotografa il file prima di scrivere e `muffin undo`
   * lo rimette; `turn.todo` scrive una riga in una tabella nostra. Nessuna
   * delle due chiedeva **prima** di ADR-0053 e nessuna deve chiedere ora — nel
   * mezzo, per due settimane, `fs.write` ha chiesto a taint 2, cioe' dopo ogni
   * lettura di una pagina web.
   */
  it('una scrittura con undo non chiede a nessun taint sotto il soffitto', () => {
    const write = fsCapabilities.find((d) => d.id === 'fs.write');
    if (!write) throw new Error('fs.write manca');
    expect(write.reversible).toBe('undoable');
    for (const taint of [0, 1, 2] as const) {
      expect(`taint ${taint}: ${decisione(write, taint, OWNER).effect}`).toBe(
        `taint ${taint}: draft`,
      );
    }
    expect(decisione(write, 3, OWNER).effect).toBe('deny');

    expect(todoCapability.reversible).toBe('undoable');
    for (const taint of TIERS) {
      expect(`turn.todo@${taint}: ${decisione(todoCapability, taint, OWNER).effect}`).not.toContain(
        'ask',
      );
    }
  });

  /**
   * Il falsificatore del punto 2: `hardened` non compra piu' un salto. Scritto
   * sulla capability che l'ADR nomina — `sys.process.kill` — e nella
   * configurazione in cui la scorciatoia scattava: owner, taint 0, hardened.
   */
  it('hardened + owner + taint 0 non salta un ask: terminare un processo chiede lo stesso', () => {
    const kill = processCapabilities.find((d) => d.id === 'sys.process.kill');
    if (!kill) throw new Error('sys.process.kill manca');
    const d = decisione(kill, 0, OWNER);
    expect(d.effect).toBe('ask');
    if (d.effect !== 'ask') return;
    expect(d.ask.prompt).toContain('non si torna indietro');
  });

  /**
   * Il falsificatore del punto 3: le due porte del loop. Entrambe dichiarano
   * `reversible: 'no'` — i byte sul filo non si richiamano, e nulla giornala
   * un episodio — e nessuna delle due deve chiedere: un'approvazione che
   * blocca la risposta e' una domanda che non ha nessun canale su cui
   * comparire, e un episodio si cancella.
   */
  it('le due porte del loop non chiedono mai: la risposta e la memoria non sono un ask', () => {
    for (const porta of DOORS) {
      expect(porta.reversible).toBe('no');
      for (const taint of TIERS) {
        for (const principal of [OWNER, MEMBER]) {
          const d = decisione(porta, taint, principal);
          expect(`${porta.id}@${taint}/${principal.kind}: ${d.effect}`).toBe(
            `${porta.id}@${taint}/${principal.kind}: allow`,
          );
        }
      }
    }
    // E `surface.send_file`, sulla stessa riga `reply`, e' `reversible: 'no'`
    // come loro: un allegato e' la conversazione gia' in corso, non un
    // destinatario nuovo (ADR-0053).
    expect(sendFileCapability.reversible).toBe('no');
    expect(decisione(sendFileCapability, 2, OWNER).effect).toBe('allow');
  });

  /**
   * Il falsificatore del punto 4, che e' la meta' dell'ADR piu' facile da
   * riportare indietro per sbaglio: sotto il soffitto **l'esito non dipende
   * dal taint**. Un `askAbove` rimesso su una riga qualunque cade qui, e cade
   * per ogni capability insieme.
   */
  it('sotto il soffitto della riga, la decisione non cambia col taint', () => {
    for (const decl of ALL) {
      const soffitto = Math.min(ROW_FLOOR[decl.effect].denyAbove, decl.maxTaint ?? 3);
      const sotto = TIERS.filter((t) => t <= soffitto);
      const esiti = new Set(sotto.map((t) => decisione(decl, t, OWNER).effect));
      expect(`${decl.id}: ${[...esiti].sort().join('|')}`).toBe(
        `${decl.id}: ${[...esiti][0] ?? ''}`,
      );
    }
  });
});
