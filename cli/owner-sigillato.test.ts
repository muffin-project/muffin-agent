import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { sealOwnerBinding } from '../core/rot/owner.js';
import { startFakeProvider } from '../evals/acceptance/provider.js';
import { privateMessage, startFakeTelegram } from '../evals/acceptance/telegram.js';
import { runInit } from './init.js';
import { connectSurfaces } from './surface.js';

/**
 * Il cablaggio di B15: chi decide l'owner è il sigillo, non `config.json`.
 *
 * `core/rot/owner.test.ts` prova la precedenza come funzione. Quello che una
 * funzione corretta non prova — ed è la famiglia di difetti che questo
 * repository ha già pagato più volte — è che la produzione ci passi davvero:
 * `rot/budgets.json` è stato sigillato e non letto per mesi, con la suite
 * verde tutto il tempo. Quindi qui si parte dal file sigillato e si arriva al
 * comportamento del connettore, attraverso il montaggio vero
 * (`buildRuntime` → `connectSurfaces` → `TelegramConnector`), contro un Bot
 * API finto.
 *
 * ## La discriminante
 *
 * `rot/owner.json` nomina A. `config.json` nomina B. Un DM di B non è
 * autorizzato dalla configurazione legacy: il gate owner-only lo scarta prima
 * di comandi e modello. Un DM di A resta abilitato, incluso `/pause`.
 *
 *  - se il sigillo vince, A riceve la conferma della pausa e B non riceve
 *    alcuna risposta né raggiunge il modello;
 *  - se `config.json` vincesse — cioè se qualcuno togliesse la lettura
 *    sigillata da `connectSurfaces` — B riceverebbe una risposta, e questo
 *    test diventerebbe rosso.
 *
 * Non un'asserzione su una riga di log: un'asserzione su **cosa il connettore
 * ha lasciato fare a chi**.
 */

const A_SIGILLATO = 4242;
const B_IN_CONFIG = 9999;

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function finche(condizione: () => boolean, timeoutMs = 20_000): Promise<void> {
  const inizio = Date.now();
  while (!condizione()) {
    if (Date.now() - inizio > timeoutMs) throw new Error('condizione mai raggiunta');
    await attendi(25);
  }
}

/**
 * Una home vera: `runInit` sigilla come su una macchina installata, poi il
 * legame di A entra nel sigillo e quello di B resta in `config.json`.
 */
function casa(botUrl: string, providerUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-owner-cablaggio-'));
  runInit({ home, provider: 'openai-compat', baseUrl: providerUrl, apiKey: 'sk-owner-b15' });
  writeSecret('telegram_token', '000:finto', home, 'home');
  const config = loadConfig(home);
  saveConfig(
    {
      ...config,
      surfaces: {
        ...config.surfaces,
        enabled: [...config.surfaces.enabled.filter((s) => s !== 'telegram'), 'telegram'],
        // Il legame legacy, e nomina qualcun altro: è la metà che il sigillo
        // deve rendere irrilevante.
        telegram: { ownerUserId: B_IN_CONFIG, ownerChatId: B_IN_CONFIG, apiBase: botUrl },
      },
    },
    home,
  );
  const esito = sealOwnerBinding(
    home,
    { telegram: { userId: A_SIGILLATO, chatId: A_SIGILLATO } },
    { out: () => {} },
  );
  if (!esito.ok) throw new Error(`sigillo non scritto: ${esito.why}`);
  return home;
}

describe('owner binding · il sigillo decide chi è owner, non config.json', () => {
  it(
    'the sealed account can use Telegram; a config-only DM is ignored',
    async () => {
      const provider = await startFakeProvider({ main: [{ text: 'risposta a uno sconosciuto' }] });
      const bot = await startFakeTelegram();
      const home = casa(bot.url, provider.baseUrl);
      const runtime = buildRuntime(home, home);
      const superfici = connectSurfaces(runtime, home, () => {}, undefined, () => {});
      try {
        // B, che solo `config.json` chiama owner, prova un comando di controllo.
        bot.deliver(privateMessage({ id: B_IN_CONFIG, name: 'Legacy' }, '/pause'));

        // A, che il sigillo chiama owner, prova lo stesso comando.
        bot.deliver(privateMessage({ id: A_SIGILLATO, name: 'Sigillato' }, '/pause'));
        await finche(() => bot.messages().some((m) => m.chatId === A_SIGILLATO && /in pausa/.test(m.text)));

        const aB = bot.messages().filter((m) => m.chatId === B_IN_CONFIG);
        // Nessuna risposta: B non arriva né al command handler né al provider.
        expect(aB).toEqual([]);

        // Ultima, e volutamente dopo il comportamento: la riga d'avvio dice
        // la stessa cosa, ma una riga di log è prosa e il rosso deve arrivare
        // prima da ciò che il connettore ha fatto.
        expect(superfici.lines).toContain(`telegram: connessa (owner ${String(A_SIGILLATO)})`);
      } finally {
        await superfici.stop();
        runtime.db.close();
        await bot.close();
        await provider.close();
      }
    },
    60_000,
  );
});
