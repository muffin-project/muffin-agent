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
 *
 * **ADR-0075 (06/09) ha aggiunto tre affermazioni a questo stesso file**, e
 * le tiene qui perche' rispondono alla stessa domanda dell'ADR precedente —
 * *cosa produce una domanda, e cosa produce un muro* — solo dall'altro lato:
 *
 * 5. nessuna capability della riga `host` risponde `taint_exceeded`, a nessun
 *    taint e per nessun principal; mutazione `host.denyAbove: 2` -> rosso;
 * 6. sopra il soffitto di `external`/`outward` l'owner riceve un `ask` che
 *    **cita il taint**; togliere quel numero dal prompt -> rosso;
 * 7. sopra lo stesso soffitto un membro di gruppo riceve `deny`; degradarlo a
 *    `ask` -> rosso.
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
          // Sopra il soffitto della riga, da ADR-0075, la risposta dipende da
          // **chi chiede**: sulle due righe che portano byte fuori dal tenant
          // (`external`, `outward`) l'owner riceve una domanda che cita il
          // taint, e chiunque altro il rifiuto di prima. Su ogni altra riga il
          // rifiuto non si e' mosso — e la riga `host` non arriva piu' qui,
          // perche' il suo soffitto e' 3 (asserito per nome piu' sotto).
          if (taint > soffitto) {
            const fuori = decl.effect === 'external' || decl.effect === 'outward';
            const atteso = fuori && principal.kind === 'owner' ? 'ask' : 'deny';
            expect(`${dove}:${d.effect}`).toBe(`${dove}:${atteso}`);
            if (atteso === 'ask' && d.effect === 'ask') {
              expect(`${dove}:${d.ask.prompt}`).toContain('taint');
            }
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
    // Taint 3 compreso, da ADR-0075: era l'ultimo gradino su cui il taint
    // negava una scrittura che ha una copia e un `muffin undo` dietro.
    for (const taint of TIERS) {
      expect(`taint ${taint}: ${decisione(write, taint, OWNER).effect}`).toBe(
        `taint ${taint}: draft`,
      );
    }

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
   * **ADR-0075 punto 1, per nome: nessuna capability della riga `host`
   * risponde `taint_exceeded`, a nessun taint e per nessun principal.**
   *
   * L'`it.each` sopra lo attraversa gia' — `soffitto` lo legge da `ROW_FLOOR`,
   * quindi seguirebbe in silenzio un `denyAbove` rimesso a 2 e continuerebbe a
   * essere verde asserendo `deny`. Questo no: il codice dell'errore e' scritto
   * qui, e la mutazione `host: { denyAbove: 2 }` fa cadere questa riga con il
   * nome della capability che ha rifiutato.
   *
   * E' la frase che l'owner ha letto sull'installazione vera il 06/09 —
   * `context taint 3 exceeds 2 for sys.shell (host)` — trasformata in
   * un'asserzione.
   */
  it('nessuna capability della riga host risponde taint_exceeded, a nessun taint', () => {
    const rifiuti: string[] = [];
    for (const decl of ALL.filter((d) => d.effect === 'host')) {
      for (const taint of TIERS) {
        for (const principal of [OWNER, MEMBER]) {
          if (principal.kind === 'member' && decl.hostOnly) continue;
          const d = decisione(decl, taint, principal);
          if (d.effect === 'deny' && d.code === 'taint_exceeded') {
            rifiuti.push(`${decl.id}@taint${taint}/${principal.kind}: ${d.detail ?? ''}`);
          }
        }
      }
    }
    expect(rifiuti).toEqual([]);
    // E la meta' positiva, perche' «nessun taint_exceeded» sarebbe vero anche
    // se la riga fosse sparita: a taint 3 la shell in sola lettura passa, la
    // scrittura fotografa, e le due irreversibili chiedono.
    expect(`sys.shell@3: ${decisione(shellCapability, 3, OWNER).effect}`).toBe('sys.shell@3: allow');
    expect(`sys.shell.write@3: ${decisione(shellWriteCapability, 3, OWNER).effect}`).toBe(
      'sys.shell.write@3: ask',
    );
  });

  /**
   * **ADR-0075 punto 3: verso l'esterno il taint chiede all'owner e nega agli
   * altri.** Scritto per nome sulle due righe che portano byte fuori dal
   * tenant, e su entrambi i principal nella stessa asserzione, perche' la
   * meta' che si perde per prima e' la seconda: un `ask` che degradasse anche
   * per un membro sarebbe un `allow` scritto in un'altra lingua, dato che in
   * un gruppo non c'e' nessuno che possa rispondere alla domanda.
   */
  it("sopra il soffitto di external/outward: l'owner e' chiesto col taint nel testo, il membro e' negato", () => {
    const fuori = ALL.filter((d) => d.effect === 'external' || d.effect === 'outward');
    expect(fuori.map((d) => d.id)).not.toEqual([]);
    for (const decl of fuori) {
      const soffitto = Math.min(ROW_FLOOR[decl.effect].denyAbove, decl.maxTaint ?? 3);
      for (const taint of TIERS.filter((t) => t > soffitto)) {
        const owner = decisione(decl, taint, OWNER);
        expect(`${decl.id}@${taint}/owner: ${owner.effect}`).toBe(`${decl.id}@${taint}/owner: ask`);
        if (owner.effect !== 'ask') continue;
        // Il prompt cita il taint: e' la ragione visibile che ADR-0075 mette
        // al posto del muro, e senza di essa la domanda non dice niente che
        // l'owner non sapesse gia'.
        expect(`${decl.id}@${taint}: ${owner.ask.prompt}`).toContain(`taint ${taint}`);

      }
    }
  });

  /**
   * La meta' non-owner della stessa regola, e **perche' ha bisogno di una
   * dichiarazione sintetica invece che di una spedita.**
   *
   * Oggi le uniche dichiarazioni su quelle due righe sono `mcp.*`
   * (`external`), e sono tutte `hostOnly: true`: un membro di gruppo le perde
   * al confine dei tenant, molto prima del soffitto del taint. Nessuna riga
   * `outward` e' spedita affatto — ADR-0070, asserito in
   * `effect-rows.test.ts`. Un ciclo sulle sole capability spedite quindi
   * *non puo'* osservare il caso, e resterebbe verde per vacuita' esattamente
   * il giorno in cui `outward.send` arriva.
   *
   * Quindi la si dichiara qui, con la forma che la matrice gia' anticipa
   * (`forbiddenForSystem` nomina `outward.send` da prima che esista), e si
   * misura la sola cosa che questa fetta cambia: sopra il soffitto, chi non e'
   * l'owner riceve il rifiuto di prima. Un `ask` qui non sarebbe una difesa —
   * in un gruppo non c'e' nessuno che possa rispondere alla domanda — e
   * sarebbe un `allow` scritto in un'altra lingua.
   */
  it('un membro sopra il soffitto di outward resta negato: la domanda e solo per chi puo rispondere', () => {
    const inviaFuori: CapabilityDecl = {
      id: 'outward.send',
      effect: 'outward',
      risk: 'high',
      reversible: 'no',
      rerunnable: false,
      resourceKind: 'none',
      policyArgs: ['to'],
      hostOnly: false,
    };
    for (const taint of TIERS.filter((t) => t > ROW_FLOOR.outward.denyAbove)) {
      const membro = decisione(inviaFuori, taint, MEMBER);
      expect(`outward.send@${taint}/member: ${membro.effect}`).toBe(`outward.send@${taint}/member: deny`);
      expect(membro.effect === 'deny' && membro.code).toBe('taint_exceeded');

      // E l'owner, sulla stessa dichiarazione e allo stesso taint, e' chiesto:
      // le due meta' insieme, perche' «il membro e' negato» sarebbe verde
      // anche se il ramo di ADR-0075 non esistesse.
      const owner = decisione(inviaFuori, taint, OWNER);
      expect(`outward.send@${taint}/owner: ${owner.effect}`).toBe(`outward.send@${taint}/owner: ask`);
      expect(owner.effect === 'ask' && owner.ask.prompt).toContain(`taint ${taint}`);
    }
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
