/**
 * La parte pura del salto dichiarato, condivisa da `scenario()` e
 * `itConSandbox()`: cosa stampare e come si chiama il test saltato.
 *
 * Separata dalla chiamata a `it.skip` stessa perché quella non è testabile da
 * fuori una suite in esecuzione — questa sì, ed è il pezzo dove un refuso
 * silenzierebbe il salto senza che nessuno se ne accorga.
 */
export function annunciaSalto(etichetta: string, motivo: string, scrivi: (s: string) => void): string {
  scrivi(`\n⊘ ${etichetta} non provabile su questo host — ${motivo}\n`);
  return `${etichetta} [non provabile qui: ${motivo}]`;
}
