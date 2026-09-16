import type Database from 'better-sqlite3';
import { askRaw, CONTROL_PROTOCOL } from './control-socket.js';
import { readGateway } from './lock.js';

/**
 * Chi può produrre execution ed effects per questa Home, adesso.
 *
 * Una Home ha in ogni momento un solo soggetto autorizzato a eseguire — mai
 * due runtime che possono entrambi farlo. Questa è l'unica domanda a cui il
 * modulo risponde, e la risponde senza toccare l'autorità semantica: il
 * gateway che possiede l'execution non guadagna nessuna capability, il kernel
 * decide come prima.
 *
 * L'ordine delle prove è la proprietà, non un'euristica:
 *
 * 1. **il socket parla** → il gateway è vivo *adesso* (una risposta su un
 *    socket è liveness, non un pid che può essere riusato) e dice che
 *    protocollo parla. Protocollo noto → lui è l'owner, e questo processo
 *    esegue solo come suo cliente. Protocollo più nuovo → conflitto fail
 *    closed: non si esegue in locale «tanto è uguale».
 * 2. **il socket tace ma il claim è vivo** → c'è un owner valido che non può
 *    eseguire per noi (un gateway di una versione senza `run`, o a metà
 *    boot): stand-down, non un secondo runtime. Eseguire in locale qui è
 *    esattamente lo sdoppiamento che #533 chiude.
 * 3. **né l'uno né l'altro** → owner locale esplicito, un solo percorso.
 *
 * Letta a ogni turno, mai all'avvio e mai in cache: un gateway installato
 * mentre il terminale è aperto (e uno che muore) cambiano la risposta, ed è
 * proprio intorno a quel cambio che due owner coesisterebbero.
 */

export type ExecutionOwner =
  /** Il gateway è vivo e parla un protocollo che sappiamo usare: esegue lui. */
  | { kind: 'gateway'; pid: number; protocol: number }
  /** Nessun gateway: esegue questo processo, e lo dice. */
  | { kind: 'local' }
  /**
   * C'è un owner ma non possiamo esserne clienti (o non sappiamo esserlo):
   * nessuno esegue qui. Fail closed, con il rimedio — mai un secondo runtime
   * silenzioso.
   */
  | { kind: 'conflict'; reason: string; remedy: string };

type IdentifyAnswer = { protocol?: unknown; pid?: unknown };

export async function resolveExecutionOwner(
  home: string,
  db: Database.Database,
): Promise<ExecutionOwner> {
  const identify = (await askRaw(home, { verb: 'identify' })) as IdentifyAnswer | null;
  if (identify !== null) {
    const protocol = typeof identify.protocol === 'number' ? identify.protocol : NaN;
    const pid = typeof identify.pid === 'number' ? identify.pid : process.pid;
    if (Number.isFinite(protocol) && protocol <= CONTROL_PROTOCOL && protocol >= 2) {
      return { kind: 'gateway', pid, protocol };
    }
    if (Number.isFinite(protocol) && protocol < 2) {
      return {
        kind: 'conflict',
        reason: `il gateway (pid ${pid}) parla il protocollo ${protocol}, senza esecuzione delegata`,
        remedy:
          'riavvia il gateway da questo checkout (`muffin gateway restart`), poi rimanda il turno',
      };
    }
    return {
      kind: 'conflict',
      reason: `il gateway (pid ${pid}) parla un protocollo più nuovo (${String(identify.protocol)})`,
      remedy: 'aggiorna questo checkout alla stessa versione del gateway, poi rimanda il turno',
    };
  }

  const claim = readGateway(db);
  if (claim !== null) {
    return {
      kind: 'conflict',
      reason: `un gateway (pid ${claim.pid}) possiede la Home ma non risponde sul socket di controllo`,
      remedy:
        'sta partendo oppure è di una versione senza esecuzione delegata — aspetta qualche secondo e rimanda; ' +
        'se resta così, `muffin gateway status` e `muffin gateway restart`',
    };
  }

  return { kind: 'local' };
}
