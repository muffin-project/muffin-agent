import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';
import { scenario } from '../scenario.js';
import { paths } from '../../../core/config/config.js';
import { seal } from '../../../core/rot/verify.js';

/**
 * B6 — retry per-tool, attraverso il binario reale.
 *
 * La riga era BLOCKER solo per scenario mancante: il meccanismo
 * (`eseguiConRitentativi`, `agent/loop.ts`, `MAX_TOOL_RETRIES=2`) è provato in
 * unità da `agent/tool-retry.test.ts` — `runTurn()` con un tool finto che
 * conta le chiamate, esattamente il pattern che `evals/acceptance/harness.ts`
 * esiste per non essere ("nothing imports runTurn and hands it fakes").
 * Questo file prova cosa resta quando quel tool finto diventa
 * `agent/tools/http.ts` vero, dentro un processo `muffin` vero.
 *
 * ## Il limite trovato, non aggirato
 *
 * Il giro completo chiesto dalla riga — un server HTTP locale che risponde
 * 503 e poi 200, e il turno che finisce con il corpo del 200 in mano al
 * modello — **non è raggiungibile da questo harness**, e non per una
 * scorciatoia mancata: `agent/tools/http.ts` chiama `addressVeto` su OGNI
 * hop, prima di ogni fetch, e `core/net/egress.ts#isForbiddenAddress` nega
 * incondizionatamente l'intero 127.0.0.0/8, tutto l'RFC1918, CGNAT,
 * link-local, multicast/reserved e i loro equivalenti IPv6 — indipendente
 * dall'allowlist e dal taint (commento della funzione: "no name, trusted or
 * not, is allowed to point into the house"). Ogni indirizzo su cui questo
 * harness può mettere in ascolto un server proprio ricade in una di quelle
 * fasce: non esiste una "forma locale" che l'allowlist accetta e che
 * `addressVeto` lasci passare. È la stessa classe di limite che il manifest
 * già accetta per D7 (l'endpoint reale di Tavily "would need a real
 * reachable host" — out of scope, nessun provider reale in questa suite).
 *
 * Misurato prima di scrivere l'asserzione qui sotto, non assunto dal
 * commento del codice: uno scenario preliminare identico a questo, puntato
 * su un server allowlisted a `127.0.0.1`, esce con `content` che inizia per
 * `"127.0.0.1 resolves to a non-routable address (127.0.0.1) — refused"` (il
 * ramo letterale di `addressVeto`, l'hostname È l'IP) e con **zero** richieste
 * arrivate al server finto — il fetch non parte mai.
 *
 * ## Cosa prova invece questo scenario, attraverso il binario reale
 *
 * 1. Il pavimento anti-SSRF regge anche quando l'owner ha esplicitamente
 *    allowlisted l'host (`rot/egress.json`) — difesa in profondità: il
 *    kernel (`decide.ts`) approverebbe, l'esecutore (`http.ts`) rifiuta lo
 *    stesso.
 * 2. Il rifiuto non è retryable: una sola `http_get` viene registrata, non
 *    tre — il retry non gira a vuoto su un target permanentemente negato.
 * 3. `http_get` E `web_search` sono le uniche due capability che marcano
 *    `retryable` (`agent/tools/http.ts`, `agent/tools/search.ts` — `fs.ts`
 *    no, un errore su disco non è transiente): il rifiuto SSRF passa per lo
 *    stesso `throwTier: 0` / `tier: 0` di ogni altro esito di `http_get`, non
 *    solleva mai un'eccezione che una repair path diversa dovrebbe gestire.
 */
describe('acceptance · B · retry per-tool (limite SSRF misurato)', () => {
  scenario(
    'B6',
    async () => {
      let requestsSeen = 0;
      const server: Server = createServer((_req, res) => {
        requestsSeen += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('non dovrebbe mai arrivare qui: addressVeto deve fermare la richiesta prima');
      });
      await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
      const port = (server.address() as { port: number }).port;

      const inst = await install({
        main: [
          { tool: { name: 'http_get', args: { url: `http://127.0.0.1:${port}/riprova-503-poi-200` } } },
          { text: 'non sono riuscito a raggiungere quell indirizzo' },
        ],
      });
      try {
        // L'owner mette 127.0.0.1 sull'allowlist esplicitamente — la forma
        // locale più diretta che l'allowlist può accettare. Non basta:
        // addressVeto nega comunque, indipendentemente da questo.
        const egressPath = join(paths(inst.home).rot, 'egress.json');
        const egress = JSON.parse(readFileSync(egressPath, 'utf8'));
        egress.allow = ['127.0.0.1'];
        writeFileSync(egressPath, JSON.stringify(egress, null, 2));
        seal(inst.home, '1', new Date());

        const r = await inst.muffin(['run', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'apri quell indirizzo']);
        if (r.code !== 0) {
          throw new Error(`il turno non completa (l'esito è un tool_result, non un crash): exit ${r.code}\n${r.err}`);
        }

        // (1) il pavimento anti-SSRF regge nonostante l'host sia allowlisted.
        const call = inst.db(
          (db) =>
            db
              .prepare(`SELECT tool, content, is_error AS isError FROM turn_tool_calls ORDER BY started_at DESC LIMIT 1`)
              .get() as { tool: string; content: string | null; isError: number | null } | undefined,
        );
        if (!call || call.tool !== 'http_get') {
          throw new Error(`nessuna http_get registrata: ${JSON.stringify(call)}`);
        }
        if (call.isError !== 1) {
          throw new Error(`http_get verso un indirizzo non instradabile non è stato negato: ${JSON.stringify(call)}`);
        }
        if (!/resolves to a non-routable address|address not routable from here/.test(call.content ?? '')) {
          throw new Error(`il rifiuto non si legge come un veto SSRF: ${JSON.stringify(call.content)}`);
        }

        // (2) il server finto non ha MAI visto una richiesta — il fetch non
        // è mai partito, quindi non c'è niente da ritentare nel senso della
        // riga (un 503 vero non è mai arrivato per essere marcato retryable).
        if (requestsSeen !== 0) {
          throw new Error(`il server finto ha visto ${requestsSeen} richieste — il veto non ha fermato il fetch`);
        }

        // (3) niente ciclo di retry a vuoto: la tabella ha UNA riga per
        // questa http_get, non `MAX_TOOL_RETRIES + 1`.
        const howMany = inst.db(
          (db) => (db.prepare(`SELECT COUNT(*) AS n FROM turn_tool_calls WHERE tool = 'http_get'`).get() as { n: number }).n,
        );
        if (howMany !== 1) {
          throw new Error(`http_get registrata ${howMany} volte — atteso 1: un rifiuto non-retryable non deve rigirare`);
        }
      } finally {
        await inst.cleanup();
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      }
    },
    headlessTestTimeoutMs(1),
  );
});
