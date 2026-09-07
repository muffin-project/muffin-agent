import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR, type PolicyMatrix } from '../../core/policy/matrix.js';
import { DOORS } from '../../core/policy/doors.js';
import type {
  CapabilityDecl,
  CapabilityId,
  Decision,
  DecisionRequest,
  EffectRow,
  TrustTier,
} from '../../core/policy/types.js';
import type { BaselineAction } from './baseline.js';

/**
 * Candidate B — **un esperimento, mai una modalità di produzione.**
 *
 * Il memo del 02/09 (`docs/evidence/decision-memo-taint-2026-09-02.md` §5-B)
 * descrive la terza candidata così: il kernel decide su una **tupla**
 * `(classe di effetto × sink × chi ha scelto la risorsa × reversibilità)`
 * invece che su uno scalare, e il taint ambientale resta come *fallback
 * conservativo quando il flusso non è ricostruibile*. La §7.1 registra che non
 * esiste in nessuna forma eseguibile, e che senza di essa il seam A/B misura
 * soltanto quanto **costa** il taint, mai se qualcosa lo batte.
 *
 * Questo file è quella forma eseguibile, e niente di più.
 *
 * ## Perché non può essere raggiunto dal runtime
 *
 * Vive sotto `evals/`, che `tsconfig.build.json` non compila e che nessun file
 * di `core/`, `agent/`, `cli/` o `connectors/` importa —
 * `candidate-b.test.ts` lo verifica leggendo l'albero, non credendo a questa
 * frase. La direzione delle dipendenze è a senso unico: questo modulo importa
 * la produzione (le dichiarazioni vere, il kernel vero), la produzione non
 * conosce questo modulo. Non c'è un flag, una variabile d'ambiente o una riga
 * di `policy.json` che lo accenda: per usarlo bisogna scrivere un `import` in
 * un file di produzione, cioè fare esattamente la cosa che il punto 8.1 del
 * memo vieta prima dell'eval.
 *
 * ## Cosa dovrebbe essere vero prima che una riga di qui entri in `core/policy/`
 *
 * Tre condizioni, tutte oggi false:
 *
 * 1. **Il runtime deve saper dire chi ha scelto la risorsa.** `chosenBy` qui
 *    arriva dalla scena, come verità di laboratorio. In produzione dovrebbe
 *    arrivare da un'etichetta di origine sugli *argomenti* di una tool call —
 *    una forma ridotta della capability-per-valore di CaMeL (§5-C) — che oggi
 *    non esiste: `agent/loop.ts` riceve gli argomenti già validati e non sa se
 *    quel path l'ha nominato l'owner nel suo messaggio o una pagina letta tre
 *    round prima. Finché non lo sa, ogni azione cade in `unreconstructable` e
 *    B **è** A: un adapter che in produzione non discrimina non è un
 *    miglioramento, è codice in più.
 * 2. **La tassonomia dei sink deve essere più fine della riga d'effetto.**
 *    Qui `sinkOf()` deriva il sink dalla riga dichiarata, e la misura del
 *    03/09 mostra il limite in modo netto: `sys.shell` dichiara `host` e un
 *    comando può fare egress, quindi B classifica come «non esce» un'azione
 *    che esce. Una versione di produzione dovrebbe far dichiarare il sink a
 *    ogni capability, o negare alla shell la rete per costruzione.
 * 3. **Un ADR.** ADR-0053 e ADR-0055 hanno spostato la decisione sulla riga
 *    d'effetto senza cambiare un permesso; questo cambierebbe *quali* permessi
 *    esistono. `docs/SECURITY.md` §13 chiede una valutazione comparativa prima
 *    dell'ADR, e questo file serve a produrla — non a sostituirla.
 */

/** Chi ha nominato la risorsa concreta su cui questa azione agisce. */
export type ResourceChooser =
  /** L'owner, nel suo messaggio, prima che il contenuto non fidato entrasse. */
  | 'owner'
  /** Contenuto non fidato: una pagina, un file senza provenienza, un episodio. */
  | 'content'
  /**
   * Il flusso non è ricostruibile. **Non è un default di comodo**: è il ramo
   * che il memo §5-B impone, ed è quello in cui B degrada esattamente ad A.
   */
  | 'unreconstructable';

export type FlowFacts = {
  readonly chosenBy: ResourceChooser;
};

export type TupleDecision = {
  readonly decision: Decision;
  /**
   * La causa, nel vocabolario della tupla.
   *
   * È la metrica «spiegabilità» del contratto del 29/08, e la proprietà 8 del
   * memo §4 («la decisione deve saper dire perché»). A può solo citare lo
   * scalare — `context taint 2 exceeds 1 for fs.write` nomina il numero, non
   * la causa; qui la frase nomina la riga, il sink, chi ha scelto e la
   * reversibilità, cioè i quattro campi su cui la decisione è stata presa.
   */
  readonly because: string;
  readonly tuple: {
    readonly row: EffectRow;
    readonly sink: Sink;
    readonly chosenBy: ResourceChooser;
    readonly reversible: CapabilityDecl['reversible'];
  };
};

/**
 * Dove finiscono i byte, come la §1.3 del memo li raggruppa.
 *
 * `escapes` è l'unica distinzione che le regole sotto usano davvero: un sink
 * che esce dal confine di fiducia del turno (rete, destinatario nuovo, codice
 * di terzi) contro uno che resta dentro (disco locale nello scope, la chat di
 * origine, il tenant del turno).
 */
type Sink =
  | 'nothing'
  | 'local-host'
  | 'origin-channel'
  | 'own-tenant-memory'
  | 'network'
  | 'new-recipient'
  | 'third-party'
  | 'root-of-trust';

const SINK_BY_ROW: Readonly<Record<EffectRow, Sink>> = {
  context: 'nothing',
  host: 'local-host',
  reply: 'origin-channel',
  memory: 'own-tenant-memory',
  // ADR-0073: il vault **del tenant che scrive**. Stesso sink di `memory` per
  // ciò che questo file decide — resta dentro il confine del turno, non esce —
  // e riga separata perché la scrittura è deliberata e ha un file dietro.
  vault: 'own-tenant-memory',
  egress: 'network',
  outward: 'new-recipient',
  external: 'third-party',
  config: 'root-of-trust',
  rot: 'root-of-trust',
};

const ESCAPING: ReadonlySet<Sink> = new Set<Sink>(['network', 'new-recipient', 'third-party']);

function sinkOf(decl: CapabilityDecl): Sink {
  return SINK_BY_ROW[decl.effect];
}

export type TupleHarnessOptions = {
  capabilities: readonly CapabilityDecl[];
  matrix?: PolicyMatrix;
  hardened?: boolean;
  budgetExhausted?: (tenant: string) => boolean;
  safeMode?: boolean;
  egressAllowed?: (host: string) => boolean;
};

/**
 * L'adapter B, costruito **sopra** il kernel di produzione e non accanto.
 *
 * Il seam che `baseline.ts` stabilisce è che A e B vedano la stessa azione
 * normalizzata e differiscano solo per l'input di autorità. Qui l'input di
 * autorità è la tupla al posto dello scalare, e tutto il resto — RoT, tenant,
 * `hostOnly`, safe mode, budget, allowlist di egress — resta **quello vero**:
 * `decide` viene chiamato a taint 0, che è il modo di togliere lo scalare
 * senza riscrivere i gate che non c'entrano. Una copia di quei gate qui sarebbe
 * il difetto che `scenarios.ts` ha già ucciso una volta: una eval che ricopia
 * la produzione resta verde il giorno in cui la produzione cambia.
 */
export function makeTupleHarness(options: TupleHarnessOptions) {
  const declarations = new Map<CapabilityId, CapabilityDecl>([
    ...DOORS.map((d) => [d.id, d] as const),
    ...options.capabilities.map((d) => [d.id, d] as const),
  ]);
  const decide = createDecide({
    capabilities: declarations,
    matrix: options.matrix ?? POLICY_FLOOR,
    budgetExhausted: options.budgetExhausted ?? (() => false),
    hardened: options.hardened ?? true,
    ...(options.safeMode === undefined ? {} : { safeMode: options.safeMode }),
    ...(options.egressAllowed === undefined ? {} : { egressAllowed: options.egressAllowed }),
  });

  const ask = (prompt: string): Decision => ({ effect: 'ask', ask: { audience: 'owner', prompt } });

  return function decideB(action: BaselineAction, flow: FlowFacts): TupleDecision {
    const request = (taint: TrustTier): DecisionRequest => ({
      principal: action.principal,
      tenant: action.tenant,
      capability: action.capability,
      resource: action.resource,
      args: action.args,
      taint,
    });

    const decl = declarations.get(action.capability);
    if (!decl) {
      return {
        decision: decide(request(action.ambientTaint)),
        because: `capability non dichiarata: ${action.capability}`,
        tuple: { row: 'rot', sink: 'root-of-trust', chosenBy: flow.chosenBy, reversible: 'no' },
      };
    }

    const row = decl.effect;
    const sink = sinkOf(decl);
    const tuple = { row, sink, chosenBy: flow.chosenBy, reversible: decl.reversible } as const;
    const nome = `${row}/${sink}/${flow.chosenBy}/${decl.reversible}`;

    // R0 — tutto ciò che NON è taint ambientale resta il kernel vero, chiesto
    // a taint 0. Un `deny` qui è un RoT, un tenant, un host-only, una safe
    // mode, un budget o l'allowlist: B non ha niente da dire su nessuno di
    // questi, e non deve poterli allentare.
    const structural = decide(request(0));
    if (structural.effect === 'deny') {
      return { decision: structural, because: `gate non-taint del kernel: ${structural.code} · ${nome}`, tuple };
    }

    // R1 — flusso non ricostruibile → **A verbatim**. Il fallback conservativo
    // che il memo §5-B impone, e la ragione per cui B in produzione oggi non
    // deciderebbe niente di diverso da A: nessuno sa dire chi ha scelto.
    if (flow.chosenBy === 'unreconstructable') {
      return {
        decision: decide(request(action.ambientTaint)),
        because: `flusso non ricostruibile → fallback al taint ambientale ${action.ambientTaint} · ${nome}`,
        tuple,
      };
    }

    // R2 — la catena che ADR-0044 e il memo §4.4 impongono chiusa: una
    // destinazione **scelta dal contenuto** su un sink che esce dal confine è
    // negata a qualunque taint, allowlist o no. È l'unica regola qui che A non
    // può esprimere: lo scalare descrive la provenienza di *ciò che è
    // presente*, mai chi ha nominato la destinazione.
    if (ESCAPING.has(sink) && flow.chosenBy === 'content') {
      return {
        decision: {
          effect: 'deny',
          code: 'resource_denied',
          detail: `destinazione scelta dal contenuto su un sink che esce (${sink})`,
        },
        because: `destinazione scelta dal contenuto su un sink che esce · ${nome}`,
        tuple,
      };
    }

    // R3 — outward resta HITL comunque (proprietà 7 del memo §4): un
    // destinatario nuovo non è mai non presidiato, nemmeno se l'ha scelto
    // l'owner in un contesto pulito.
    if (row === 'outward') {
      return { decision: ask(`nuovo destinatario · ${nome}`), because: `outward è sempre presidiato · ${nome}`, tuple };
    }

    // R4 — le due righe che il threat model stampa ALLOW·ALLOW·ALLOW restano
    // allow: il destinatario è l'owner stesso o il tenant del turno, e nessuna
    // delle due esce. **Qui B non è meglio di A e non pretende di esserlo**:
    // la risposta e l'episodio restano i sink non sorvegliati che la §1.3
    // misura, e la eval lo registra invece di nasconderlo.
    if (sink === 'origin-channel' || sink === 'own-tenant-memory') {
      return { decision: structural, because: `sink verso l'owner/il tenant, non esce · ${nome}`, tuple };
    }

    // R5 — effetto scelto dal contenuto su un sink che non esce: mai non
    // presidiato. Non `deny`, perché il byte non lascia la casa e il journal
    // esiste; non `draft`/`allow`, perché è il contenuto ad aver scelto.
    if (flow.chosenBy === 'content') {
      return { decision: ask(`azione scelta dal contenuto · ${nome}`), because: `azione scelta dal contenuto · ${nome}`, tuple };
    }

    // R6 — irreversibile scelto dall'owner: ASK. La proprietà 7 di nuovo, e la
    // riga che tiene `sys.shell` esattamente dov'è oggi.
    if (decl.reversible === 'no' && decl.risk !== 'low') {
      return { decision: ask(`irreversibile · ${nome}`), because: `irreversibile, anche se scelto dall'owner · ${nome}`, tuple };
    }

    // R7 — risorsa scelta dall'owner, sink che non esce, effetto reversibile:
    // la classe di rischio decide, cioè `draft` con journal e undo per
    // `fs.write`. È **tutta** l'utilità che B compra rispetto ad A, ed è il
    // controesempio canonico dell'owner: «leggi la doc di Vitest, poi lancia i
    // test» — la decisione è arrivata prima della pagina.
    return { decision: structural, because: `risorsa scelta dall'owner, sink locale, reversibile · ${nome}`, tuple };
  };
}
