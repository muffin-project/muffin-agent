import type { TurnResult } from '../agent/loop.js';

/**
 * Come si dice un turno annullato, senza mentire su cosa potrebbe aver fatto.
 *
 * Tre casi, e il terzo non dice «niente è successo»:
 *
 * - nessun passaggio, nessuno spend: niente è partito davvero — l'unico caso
 *   in cui «annullato prima di iniziare» è un fatto e non una speranza;
 * - altrimenti: il turno ha già chiamato il modello o i tool, e un effetto
 *   potrebbe essere partito — lo si dice, con l'id per controllare.
 *
 * Pura e condivisa fra `repl` e `run`: due frasi diverse per lo stesso
 * annullamento sarebbero due verità diverse.
 */
export function describeAbort(result: TurnResult): string {
  const spesa = result.usage.inputTokens + result.usage.outputTokens;
  if (result.iterations === 0 && spesa === 0)
    return 'annullato prima di iniziare — niente è partito';
  return (
    `annullato dopo ${result.iterations} passaggi — potrebbe aver già eseguito qualcosa ` +
    `(turno ${result.turnId.slice(0, 12)})`
  );
}
