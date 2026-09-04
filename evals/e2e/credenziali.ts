/**
 * Da dove vengono le tre cose che servono a `telegram.ts`, e perché la
 * decisione sta qui e non là dentro.
 *
 * Là dentro è codice a effetto: legge la home vera, scrive su stderr, chiama
 * `process.exit`. Una regola scritta in quella forma si può solo *leggere*,
 * mai falsificare — e questa regola ha già sbagliato una volta nel modo che
 * conta: il 04/09/2026 ha chiesto all'owner tre segreti mentre due erano sul
 * suo disco, e ha proposto un `.env` a un'installazione che ha un vault.
 *
 * Quindi: la scelta è una funzione pura, l'effetto resta di chi chiama.
 */

export type Ambiente = {
  readonly apiKey?: string | undefined;
  readonly token?: string | undefined;
  readonly ownerId?: string | undefined;
};

export type Installazione = {
  /** `provider.apiKeyRef` risolto, o '' se non c'è. */
  readonly apiKey: string;
  /** `surfaces.telegram.ownerUserId`, o 0. */
  readonly ownerId: number;
  /** `secret://e2e_telegram_token`, o ''. */
  readonly tokenDedicato: string;
  /** `secret://telegram_token` — il bot che il gateway installato usa davvero. */
  readonly tokenInstallato: string;
  /** Se il gateway installato è vivo (socket presente). */
  readonly gatewayVivo: boolean;
};

export type Credenziali = { readonly apiKey: string; readonly token: string; readonly ownerId: number };

export type Esito =
  | { readonly ok: true; readonly credenziali: Credenziali }
  | { readonly ok: false; readonly motivi: readonly string[] };

/**
 * L'ambiente vince sempre: una corsa e2e deve poter puntare a un account
 * diverso da quello installato senza toccare la config. Sotto, l'installazione
 * risponde per ciò che già sa — chiedere di nuovo a chi ha già dato è la
 * stessa porta aperta due volte.
 */
export function risolviCredenziali(env: Ambiente, inst: Installazione): Esito {
  const apiKey = env.apiKey ?? inst.apiKey;
  const token = env.token ?? (inst.tokenDedicato !== '' ? inst.tokenDedicato : inst.tokenInstallato);
  const ownerId = Number(env.ownerId ?? String(inst.ownerId));

  const motivi: string[] = [];
  if (apiKey === '') {
    motivi.push('la chiave del modello: LLM_API_KEY, oppure provider.apiKeyRef in config.json');
  }
  if (token === '') {
    motivi.push(
      'il token di un bot di prova: MUFFIN_E2E_TELEGRAM_TOKEN, oppure `muffin secret set e2e_telegram_token`',
    );
  }
  if (!Number.isInteger(ownerId) || ownerId === 0) {
    motivi.push('la tua user id Telegram: MUFFIN_E2E_OWNER_ID, oppure surfaces.telegram.ownerUserId in config.json');
  }
  if (motivi.length > 0) return { ok: false, motivi };

  /**
   * Lo stesso token in due processi che fanno `getUpdates`: Telegram ne serve
   * uno solo e all'altro risponde 409. Se l'e2e parte così, il filo registra
   * un fallimento che *sembra* un difetto del prodotto e invece è contesa —
   * la confusione esatta che questo banco esiste per non produrre.
   *
   * Non fermiamo noi il gateway dell'owner: è il suo processo vivo, la sua
   * decisione. Diciamo la conseguenza e il comando, e ci fermiamo.
   */
  if (inst.gatewayVivo && token === inst.tokenInstallato && inst.tokenInstallato !== '') {
    return {
      ok: false,
      motivi: [
        'il gateway installato sta già ricevendo con questo stesso bot: due getUpdates sullo stesso token danno 409,\n' +
          "  e l'e2e registrerebbe un fallimento che non è del prodotto.\n" +
          '  ferma il gateway per la durata della corsa:  muffin gateway stop   (poi: muffin gateway start)\n' +
          '  oppure usa un bot dedicato:                 muffin secret set e2e_telegram_token',
      ],
    };
  }

  return { ok: true, credenziali: { apiKey, token, ownerId } };
}
