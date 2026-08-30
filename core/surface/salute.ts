/**
 * Se una superficie **abilitata** stia rispondendo adesso, e da quando no.
 *
 * Il difetto da cui nasce, misurato sulla macchina dell'owner il 30/08/2026.
 * Telegram e Discord erano abilitate e avevano portato 47 turni veri. Poi, alle
 * 17:08 del 29, il polling ha smesso di funzionare e non e' piu' ripartito: 19
 * ore, zero turni su qualunque superficie, e `muffin doctor` che stampava
 *
 * ```text
 * ✓ gateway    attivo · pid 73344 · dal 29/08/26, 12:30 · in attesa · socket concorde
 * ✓ consegne   nessuna delivery mancante nelle ultime 24h
 * ```
 *
 * Tutte e due vere. **Verdi perche' non arrivava piu' niente**: una superficie
 * che non riceve non produce turni, quindi non produce consegne, quindi non ne
 * mancano. Ogni indicatore guardava a valle del punto in cui il sistema era
 * rotto, e piu' il guasto era completo piu' i numeri sembravano tranquilli.
 *
 * `connectSurfaces` conosceva gia' meta' del problema — riporta la superficie
 * che *dovrebbe* essere su e non e' partita — ma solo all'avvio. Quello che
 * mancava e' il caso opposto e piu' insidioso: connessa all'avvio, morta dopo.
 *
 * ## Fatti, non giudizi
 *
 * Questo registro non decide cosa sia un guasto: registra quante volte di fila
 * un battito e' fallito, da quando, e con quale causa. La soglia oltre la quale
 * la cosa merita un `!` sta in `doctor`, che e' il posto che parla all'owner.
 * Un connettore che decidesse da solo di essere «giu'» dovrebbe conoscere le
 * abitudini di chi legge, e non le conosce.
 *
 * Vive in memoria e non nel database di proposito. L'unico processo che sa se
 * il polling sta rispondendo e' quello che lo fa, e la domanda «e' viva
 * adesso?» non sopravvive al processo che la risponde: una riga durevole
 * lasciata da un gateway morto direbbe soltanto com'era il mondo l'ultima volta
 * che qualcuno ha guardato — cioe' la stessa classe di bugia da cui nasce
 * questo file.
 */

export type StatoSuperficie = {
  readonly id: string;
  readonly connessa: boolean;
  /** Da quando dura **questo** stato, non da quando la superficie esiste. */
  readonly da: string;
  /** Solo quando non e' connessa: cosa ha detto l'ultimo fallimento. */
  readonly causa?: string;
  /** Quanti battiti di fila sono falliti. Zero quando e' connessa. */
  readonly fallimentiDiFila: number;
};

export class SaluteSuperfici {
  private readonly stati = new Map<string, StatoSuperficie>();

  /**
   * Un battito riuscito.
   *
   * `da` cambia solo alla **transizione**: una superficie sana da tre ore non
   * deve sembrare appena riconnessa a ogni giro, altrimenti «da quando» smette
   * di essere un'informazione.
   */
  connessa(id: string, ora: Date): void {
    const prima = this.stati.get(id);
    if (prima?.connessa === true) return;
    this.stati.set(id, { id, connessa: true, da: ora.toISOString(), fallimentiDiFila: 0 });
  }

  /**
   * Un battito fallito.
   *
   * La causa dell'**ultimo** fallimento, non del primo: quando un guasto cambia
   * natura — rifiutata, poi risolta male, poi silenziosa — e' l'ultima che dice
   * cosa provare adesso. `da` resta quello del primo, perche' e' la durata a
   * distinguere un lampo da un guasto.
   */
  caduta(id: string, causa: string, ora: Date): void {
    const prima = this.stati.get(id);
    const daQuando = prima !== undefined && !prima.connessa ? prima.da : ora.toISOString();
    const quanti = prima !== undefined && !prima.connessa ? prima.fallimentiDiFila + 1 : 1;
    this.stati.set(id, { id, connessa: false, da: daQuando, causa, fallimentiDiFila: quanti });
  }

  /** Solo le superfici che qualcuno ha davvero provato a connettere. */
  stato(): StatoSuperficie[] {
    return [...this.stati.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
