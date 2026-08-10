import type Database from 'better-sqlite3';

/**
 * Chi è diventato silenzioso — il segnale di Stadio-1 che nasce da *ciò che non
 * è successo*.
 *
 * Il principio è cognitivo prima che tecnico (`knowledge/04-learn-from-absence.md`):
 * un tema centrale che sparisce è un evento narrativo, e la sorpresa di ciò che
 * manca è prediction-error quanto quella di ciò che arriva. La regola che rende
 * il principio misurabile: **il silenzio significativo è il delta rispetto al
 * pattern storico**, non il valore assoluto di `last_seen`. Un'entità nominata
 * ogni sei mesi non è silente a tre; una nominata ogni due giorni lo è a dieci.
 *
 * ## Perché non la regola "media × 3"
 *
 * Il vecchio Muffin usava due costanti: almeno 3 menzioni, e silenzio > media × 3.
 * Sembrano una soglia al 5%: se gli intervalli fra menzioni sono esponenziali,
 * P(gap > k·media) = e^-k, ed e^-3 = 0,0498. Ma quel conto vale **solo se la
 * media è nota**, e qui è stimata su una manciata di intervalli.
 *
 * Con la media stimata, la distribuzione predittiva giusta è la Gamma-Esponenziale
 * coniugata: posterior Gamma(n, S) su λ, e coda predittiva di Lomax
 *
 *      P(T > gap) = (1 + gap/S)^(-n)
 *
 * dove **n = numero di intervalli osservati** e **S = la loro somma**, che è
 * semplicemente `ultima_menzione − prima_menzione`. La media non compare: si
 * cancella. Con la storia più corta che accettiamo (3 occasioni → n=2), la regola
 * ×3 dà p = 0,16 — **un falso allarme ogni sei entità**, non ogni venti. La forma
 * ×3 è la coda giusta nel limite di n grande e mente esattamente dove il vecchio
 * detector viveva, sul minimo di menzioni.
 *
 * Quindi la soglia qui è **p**, non k: una manopola sola che *significa* qualcosa
 * (il tasso di falsi allarmi che accetti), e che da sola pretende un silenzio più
 * lungo quando la storia è più magra. Un solo intervallo osservato chiede un gap
 * 19× prima di parlare, senza che nessuna costante glielo imponga.
 *
 * E la promessa è **esatta, non asintotica**: con V = gap/(gap+S) ~ Beta(1,n) si
 * ha p = (1-V)^n, quindi P(p < alpha) = alpha per *ogni* n. Simulato su entità
 * vive (`absence.test.ts` §calibrazione): 0,047 · 0,051 · 0,053 a n = 2, 5, 20 —
 * mentre la regola ×3, sullo stesso campione, dà 0,154 · 0,099 · 0,063.
 *
 * **La costante dipende dalla prior, e va detto**: quella sopra è la prior di
 * Jeffreys per un tasso esponenziale, p(λ) ∝ 1/λ, cioè Gamma(0,0) impropria. Con
 * una prior propria il "19×" cambia. La coniugazione e l'identità
 * Gamma-mistura-di-esponenziali = Lomax sono standard e verificate su fonti
 * terze; questa forma chiusa specifica l'abbiamo derivata, non copiata, ed è per
 * questo che `overdueProbability` è esportata e provata su numeri a mano.
 *
 * **Non esiste prior art da cui calibrare.** La ricerca (2026-08-10, in
 * `research/proattivita-quando-parlare.md`) non ha trovato letteratura che tratti
 * "un tema smette di comparire" come segnale di memoria o retrieval: nessun
 * benchmark contro cui misurare questa soglia. Da qui la postura conservativa —
 * alpha stretta, pavimento assoluto, tetto basso — che è una scelta obbligata
 * dall'assenza di misura, non timidezza.
 *
 * ## Cosa conta come menzione
 *
 * Un'occasione in cui l'owner ha *portato su* quell'entità, non un fatto vero su
 * di essa. Da qui tre scelte che sembrano dettagli e non lo sono:
 *
 *  - **Anche i fatti scaduti contano.** Averne parlato è attenzione, e resta
 *    attenzione anche se poi la credenza è stata superata. Filtrare su
 *    `expired_at IS NULL` misurerebbe cosa credi adesso, non quando te ne sei
 *    occupato.
 *  - **Solo evidenza tier ≤ 1.** È il rail #1 del gate applicato alla *fonte*:
 *    un gruppo che nomina X venti volte non può creare, per assenza successiva,
 *    un nudge nel canale privato dell'owner (threat model §b).
 *  - **Le menzioni ravvicinate collassano in una.** Un messaggio produce cinque
 *    fatti sulla stessa entità nello stesso istante: senza coalescenza gli
 *    intervalli valgono zero, S → 0 e *qualunque* gap risulta infinitamente
 *    improbabile. Sarebbe un firehose costruito per sbaglio dentro l'antidoto al
 *    firehose. La finestra collassa la raffica nell'occasione che è.
 *
 * ## Il costo, misurato
 *
 * La query legge **tutti** i fatti del tenant: serve la storia intera per avere
 * il ritmo, e non c'è indice che eviti una scansione di ciò che va scansionato
 * comunque. Su questa macchina, in memoria: 25k fatti → 18 ms, 100k → 86 ms,
 * 400k → 532 ms (mediana di cinque). Leggermente superlineare per il b-tree
 * temporaneo dell'ORDER BY. È un percorso **schedulato**, non di turno: nessuno
 * aspetta mezzo secondo mentre parla.
 *
 * Un indice su `facts(tenant_id, object_id)` sembra la mossa ovvia per il ramo
 * da oggetto ed è stato **misurato e scartato**: SQLite lo sceglie e il piano
 * peggiora — 103 ms contro 88 ms a 100k, perché su una scansione dell'intero
 * tenant un indice secondario aggiunge indirezione senza togliere righe. Scritto
 * qui perché è esattamente il tipo di ottimizzazione che al prossimo giro
 * qualcuno riproporrà per intuizione.
 */

/** Un'entità che ha smesso di comparire, col conto che lo dice. */
export type Absence = {
  entityId: number;
  name: string;
  kind: string;
  /** Occasioni distinte in cui è comparsa (raffiche già collassate). */
  occasions: number;
  /** Prima e ultima occasione, ISO. */
  firstSeen: string;
  lastSeen: string;
  /** Giorni fra la prima e l'ultima occasione: la somma degli intervalli. */
  spanDays: number;
  /** Giorni di silenzio adesso. */
  gapDays: number;
  /**
   * P(un silenzio almeno così lungo | il tuo pattern) sotto la predittiva.
   * Più è piccolo, più è anomalo. È il numero su cui si taglia.
   */
  p: number;
};

export type AbsenceOptions = {
  /**
   * Tasso di falsi allarmi accettato. 0,05 è la convenzione, e qui ha un prezzo
   * leggibile: su cento entità con abbastanza storia, circa cinque risulteranno
   * silenti per caso. Il cap sotto è ciò che tiene quel numero lontano
   * dall'owner.
   */
  alpha?: number;
  /**
   * Silenzio minimo assoluto, in giorni. Non è statistica: è postura. Un'entità
   * nominata ogni ora è "in ritardo" dopo mezza giornata e non c'è niente da
   * chiedere. Nessuna soglia statistica può esprimerlo, perché il conto è
   * corretto — è la domanda a non valere la pena.
   */
  minGapDays?: number;
  /**
   * Occasioni minime. Due intervalli sono il minimo per cui la parola "pattern"
   * significa qualcosa in italiano; la formula regge anche con uno, ma nessuno
   * chiamerebbe pattern due menzioni.
   */
  minOccasions?: number;
  /** Menzioni entro questa distanza sono la stessa occasione. */
  coalesceMinutes?: number;
  /**
   * Quante ne torna, al massimo, dalla più anomala. Il tetto è P-I: la ricerca
   * sulla proattività prematura dice che la soglia va alta e il rubinetto
   * stretto, non che il detector deve essere timido.
   */
  limit?: number;
};

export const ABSENCE_DEFAULTS: Required<AbsenceOptions> = {
  alpha: 0.05,
  minGapDays: 7,
  minOccasions: 3,
  coalesceMinutes: 60,
  limit: 3,
};

const DAY_MS = 86_400_000;

/**
 * La coda predittiva. Esportata perché è la sola affermazione di questo file che
 * si possa sbagliare in silenzio: un test che la controlla contro numeri
 * calcolati a mano vale più di dieci che controllano il giro attorno.
 *
 * `n` intervalli, somma `span`, gap `gap` (stesse unità). Ritorna P(T > gap).
 */
export function overdueProbability(gap: number, span: number, n: number): number {
  if (n <= 0) return 1;
  // Un arco nullo con più occasioni vuol dire che la coalescenza non ha
  // collassato una raffica: nessun tempo è passato fra menzioni distinte. Non
  // c'è pattern da violare, e restituire 0 farebbe scattare tutto.
  if (span <= 0) return 1;
  return Math.pow(1 + gap / span, -n);
}

type MentionRow = { entityId: number; name: string; kind: string; at: string };

/**
 * Legge le menzioni e ne ricava i silenzi. Sincrona e senza modello: è lo
 * Stadio-1 per intero — un LLM decide *cosa* dire, mai *se* c'è qualcosa.
 */
export function detectAbsences(
  db: Database.Database,
  tenantId: string,
  now: Date,
  options: AbsenceOptions = {},
): Absence[] {
  const o = { ...ABSENCE_DEFAULTS, ...options };

  // Un'entità è "menzionata" tanto da soggetto quanto da oggetto: "ho visto
  // Marco" e "il libro di Marco" sono entrambi occasioni in cui Marco è passato.
  // UNION ALL e non UNION: un fatto che la nomina due volte è comunque una riga
  // per lato, e la coalescenza le fonde subito dopo.
  const rows = db
    .prepare(
      `SELECT e.id AS entityId, e.name, e.kind, f.recorded_at AS at
         FROM facts f JOIN entities e ON e.id = f.subject_id
        WHERE f.tenant_id = ? AND f.trust_tier <= 1
       UNION ALL
       SELECT e.id AS entityId, e.name, e.kind, f.recorded_at AS at
         FROM facts f JOIN entities e ON e.id = f.object_id
        WHERE f.tenant_id = ? AND f.trust_tier <= 1
        ORDER BY entityId, at`,
    )
    .all(tenantId, tenantId) as MentionRow[];

  const byEntity = new Map<number, MentionRow[]>();
  for (const row of rows) {
    const list = byEntity.get(row.entityId);
    if (list) list.push(row);
    else byEntity.set(row.entityId, [row]);
  }

  const found: Absence[] = [];
  for (const [entityId, mentions] of byEntity) {
    // UNION ALL non garantisce l'ordine dentro il gruppo su tutti i motori: si
    // ordina qui, dove costa niente e non dipende dal piano di query.
    const times = mentions
      .map((m) => Date.parse(m.at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    const occasions = coalesce(times, o.coalesceMinutes * 60_000);
    if (occasions.length < o.minOccasions) continue;

    const first = occasions[0]!;
    const last = occasions[occasions.length - 1]!;
    const span = last - first;
    const gap = now.getTime() - last;
    if (gap < o.minGapDays * DAY_MS) continue;

    const p = overdueProbability(gap, span, occasions.length - 1);
    if (p >= o.alpha) continue;

    found.push({
      entityId,
      name: mentions[0]!.name,
      kind: mentions[0]!.kind,
      occasions: occasions.length,
      firstSeen: new Date(first).toISOString(),
      lastSeen: new Date(last).toISOString(),
      spanDays: round1(span / DAY_MS),
      gapDays: round1(gap / DAY_MS),
      p,
    });
  }

  // Dalla più anomala: se il tetto taglia, taglia le meno strane.
  found.sort((a, b) => a.p - b.p || b.gapDays - a.gapDays);
  return found.slice(0, o.limit);
}

/** Timestamp ordinati → occasioni: la prima di ogni raffica. */
function coalesce(sorted: number[], windowMs: number): number[] {
  const out: number[] = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    // Rispetto all'inizio della raffica, non all'ultimo elemento: altrimenti
    // dieci messaggi a 59 minuti l'uno dall'altro diventano una sola occasione
    // lunga dieci ore.
    if (prev === undefined || t - prev > windowMs) out.push(t);
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * L'ancora per il dedup del gate. Contiene `lastSeen`: lo stesso silenzio non
 * si ripete, ma se ne parli di nuovo e poi taci di nuovo, quello è un silenzio
 * nuovo e può parlare. È la differenza fra ricordare e insistere.
 */
export function absenceAnchor(a: Absence): string {
  return `absence:${a.entityId}:${a.lastSeen}`;
}
