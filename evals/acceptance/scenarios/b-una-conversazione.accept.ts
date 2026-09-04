import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
import type { RecordedRequest, ScriptedReply } from '../provider.js';
import { privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';

/**
 * B · Un solo Muffin: la conversazione dell'owner attraversa le porte, i gruppi no.
 *
 * Il failure, misurato dall'owner il 2026-09-03 sulla propria installazione:
 * «non sembra di star parlando allo stesso muffin». Un umano solo, un agente
 * solo, una cosa sola — due conversazioni. La causa non era un confine di
 * sicurezza (`identify` risolve già la DM Telegram dell'owner e il terminale
 * allo stesso tenant `host`) ma una **stringa di sessione scritta a mano in due
 * connector**: `telegram:<chatId>` di là, un id casuale per lancio di qua.
 * `docs/evidence/continuita-e-provenienza-2026-09-03.md` §2.1 la misura,
 * ADR-0056 la chiude.
 *
 * Questo file prova due cose che si smentiscono a vicenda se una sola delle due
 * è falsa, e per questo stanno insieme:
 *
 *  1. **la continuità è vera** — ciò che è stato detto su Telegram è nella
 *     finestra reiniettata di un turno del terminale, non ripescato dal recall;
 *  2. **la fusione non ha lavato la provenienza** — una lettura tier 2 su
 *     Telegram arriva al turno del terminale come **soffitto** (più ASK, che è
 *     corretto) e non come marchio sulla risposta di quel turno, che resta
 *     tier 0 e quindi invecchia fuori dalla finestra invece di cricchettare.
 *
 * Senza (2), (1) sarebbe un buco: una sessione fusa che lava il taint sarebbe
 * esattamente la lavanderia che `SECURITY.md` §4 vieta. Senza (1), (2) sarebbe
 * vacuo: non c'è niente da ereditare fra due sessioni che non si toccano.
 *
 * *Falsificatore*, per entrambi: rimetti il letterale `telegram:${chatId}` a
 * `connectors/telegram/connector.ts` e `sessions.open()` senza argomenti a
 * `cli/repl.ts`, e i due scenari tornano rossi — il primo perché la frase non
 * è più nella finestra, il secondo perché il turno del terminale riparte a
 * soffitto 0 e la scrittura passa liscia.
 */

const OWNER_ID = 4242;

/** Deliberatamente senza token in comune con la domanda: se ricomparisse per somiglianza, sarebbe il recall, non la history. */
const CONFIDENZA = 'il barometro del capanno segna 1013 da martedì';
const DOMANDA = 'riassumi in una riga quello che ti ho appena scritto';

/** Il pairing, che non consuma nessuna risposta scriptata: un codice giusto lo risolve il connettore. */
async function pairOwner(inst: Install, tg: FakeTelegram): Promise<Awaited<ReturnType<Install['gateway']>>> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-una-conversazione');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, code));
  await until(() => {
    try {
      const c = JSON.parse(readFileSync(join(inst.home, 'config.json'), 'utf8')) as {
        surfaces?: { telegram?: { ownerUserId?: number } };
      };
      return c.surfaces?.telegram?.ownerUserId === OWNER_ID;
    } catch {
      return false;
    }
  }, 20_000);
  return gw;
}

/** Il contenuto di un messaggio sul filo, qualunque dialetto abbia usato. */
function testo(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

/** Le righe di `sessions/owner.jsonl` — il file che, dopo la fusione, esiste. */
function sessioneOwner(inst: Install): Array<{ role: string; content: string; surface: string; tier?: number }> {
  const file = join(inst.home, 'sessions', 'owner.jsonl');
  if (!existsSync(file)) throw new Error(`nessun sessions/owner.jsonl: le due porte non condividono ancora una conversazione`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { role: string; content: string; surface: string; tier?: number });
}

describe('acceptance · una conversazione sola · Telegram e terminale, stesso owner', () => {
  /**
   * Il segnale è la **finestra reiniettata**, non il recall.
   *
   * La distinzione si fa sulla forma della richiesta e non sull'intenzione:
   * `buildContext` rende ogni riga di history come un messaggio a sé
   * (`{role, content:[{text}]}`), mentre il recall viaggia dentro l'**ultimo**
   * messaggio utente, insieme all'ambiente, al piano e alla domanda. Quindi
   * cercare la frase come contenuto *esatto* di un messaggio che non è
   * l'ultimo è, per costruzione, cercarla nella history — e per di più la
   * domanda non condivide un token con la frase, così nemmeno il ranking
   * lessicale potrebbe spiegarla.
   */
  it(
    'quello che l owner dice su Telegram è nel contesto del turno successivo sul terminale',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'annotato.' }, { text: 'ecco il riassunto.' }, { text: 'ok.' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const gw = await pairOwner(inst, tg);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, CONFIDENZA));
          await until(() => tg.messages().some((m) => m.text.includes('annotato')), 30_000);
        } finally {
          await gw.stop();
        }

        // Il terminale, come lo apre l'owner: nessun `--session`, nessun
        // trucco. È la porta che prima non aveva continuità nemmeno con sé
        // stessa fra due lanci.
        const repl = await inst.muffin(['repl'], `${DOMANDA}\n/exit\n`);
        if (repl.code !== 0) throw new Error(`REPL: exit ${repl.code}\n${repl.err}`);

        const righe = sessioneOwner(inst);
        process.stderr.write(
          `  una-conversazione · sessions/owner.jsonl: ${righe
            .map((r) => `${r.surface}/${r.role}`)
            .join(' ')}\n`,
        );
        if (!righe.some((r) => r.surface === 'telegram') || !righe.some((r) => r.surface === 'cli')) {
          throw new Error(
            `owner.jsonl non contiene entrambe le porte: ${JSON.stringify(righe.map((r) => r.surface))}`,
          );
        }

        const turniCli = inst.provider
          .main()
          .filter((r: RecordedRequest) => r.transcript.includes(DOMANDA));
        if (turniCli.length === 0) throw new Error('nessuna richiesta al provider contiene la domanda del terminale');
        const richiesta = turniCli[turniCli.length - 1] as RecordedRequest;

        // `[telegram] …` e non la frase nuda: la finestra fusa dice da dove
        // viene ogni riga che **non** viene da qui (`buildContext`), ed è la
        // seconda condizione senza la quale la fusione sarebbe un
        // peggioramento — vedi §7 della memo.
        const indice = richiesta.messages.findIndex(
          (m) => m.role === 'user' && testo(m.content).startsWith('[telegram]') && testo(m.content).includes(CONFIDENZA),
        );
        if (indice === -1) {
          throw new Error(
            'la frase detta su Telegram non è un messaggio della finestra reiniettata del turno CLI — ' +
              `le due porte non condividono la conversazione. Contesto visto dal modello:\n${richiesta.transcript}`,
          );
        }
        // E non è il recall: il recall sta dentro l'ultimo messaggio utente,
        // insieme all'ambiente e alla domanda, mai da solo e mai prima.
        const ultimoUtente = richiesta.messages.map((m) => m.role).lastIndexOf('user');
        if (indice >= ultimoUtente) {
          throw new Error(
            `la frase compare nell'ultimo messaggio utente (indice ${indice}): è contesto recuperato, non history`,
          );
        }
        process.stderr.write(
          `  una-conversazione · frase Telegram al messaggio ${indice} di ${richiesta.messages.length}, ultimo utente ${ultimoUtente}\n`,
        );
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

/** Turno Telegram: leggi (il disco vale `DISK_TIER` = 2). Poi due turni sul terminale. */
const SCRIPT_PROVENIENZA: ScriptedReply[] = [
  { tool: { name: 'fs_read', args: { path: 'dati.txt' } } },
  { text: 'letto: la somma è 6' },
  // Terminale, turno 1: niente tool. Il suo soffitto è ereditato, il suo
  // taint intrinseco no — è la differenza che questo scenario misura.
  { text: 'tutto a posto.' },
  // Terminale, turno 2: la scrittura, che a soffitto 2 diventa una domanda.
  { tool: { name: 'fs_write', args: { path: 'esito.txt', content: 'totale 6' } } },
  { text: 'ho provato a scrivere esito.txt' },
];

describe('acceptance · fondere non lava · il soffitto attraversa le porte, il marchio no', () => {
  /**
   * ADR-0044 §Riconciliazione 2026-08-28, applicato dove i byte vanno davvero.
   *
   * `agent/loop.ts` alza il **soffitto** del turno con `raiseCeiling(historyTaint(...))`
   * e stampa la risposta con `snapshot.intrinsicTaint()`. Prima della fusione la
   * distinzione valeva dentro una porta sola; dopo vale fra due, ed è l'unica
   * cosa che rende sicura una sessione condivisa: senza, la lettura di un file
   * fatta su Telegram sporcherebbe il terminale **per sempre**, perché ogni
   * risposta pulita rientrerebbe nella finestra al tier che aveva soltanto
   * ereditato.
   *
   * Due asserzioni, e servono entrambe:
   *
   *  - la riga di `approvals` per `fs.write` esiste **a taint 2** — il soffitto
   *    ha attraversato la porta, e il kernel decide a quel tier (`fs.write` sta
   *    sulla riga *shell / filesystem host*, che a taint 2 è ASK da ADR-0053);
   *  - la riga `assistant` che il primo turno del terminale scrive in
   *    `owner.jsonl` porta `tier: 0` — la risposta di quel turno non è marcata
   *    col tier che ha solo visto.
   */
  it(
    'una lettura tier 2 su Telegram alza il soffitto di un turno CLI senza marcarne la risposta',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({ main: SCRIPT_PROVENIENZA, env: { MUFFIN_GATEWAY_TICK_MS: '200' } });
      try {
        writeFileSync(join(inst.workspace, 'dati.txt'), '1 2 3\n', 'utf8');
        const gw = await pairOwner(inst, tg);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'leggi dati.txt e dimmi la somma'));
          // The answer follows a tool call (`fs_read`), so it joins that
          // tool's own transcript message as an edit rather than arriving as
          // a fresh `sendMessage` (`connector.ts#deliverTo`'s merge) — wait
          // on `tg.sent()` directly, not `tg.messages()`.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('somma è 6'),
                ),
            30_000,
          );
        } finally {
          await gw.stop();
        }

        const repl = await inst.muffin(['repl'], 'come va?\nscrivi il totale in esito.txt\n/exit\n');
        if (repl.code !== 0) throw new Error(`REPL: exit ${repl.code}\n${repl.err}`);

        // (1) Il soffitto ha attraversato la porta.
        const chiesto = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT taint FROM approvals WHERE capability = 'fs.write'
                   ORDER BY asked_at DESC, rowid DESC LIMIT 1`,
              )
              .get() as { taint: number } | undefined,
        );
        process.stderr.write(`  provenienza · approvals fs.write chiesto a taint ${String(chiesto?.taint ?? '-')}\n`);
        if (chiesto === undefined) {
          throw new Error(
            'nessuna domanda di approvazione per fs.write: il turno del terminale è partito a soffitto 0, ' +
              'cioè la lettura fatta su Telegram non è arrivata — la fusione ha lavato la provenienza',
          );
        }
        if (chiesto.taint !== 2) {
          throw new Error(`atteso soffitto 2 ereditato da Telegram, trovato ${chiesto.taint}`);
        }
        if (existsSync(join(inst.workspace, 'esito.txt'))) {
          throw new Error('esito.txt è stato scritto senza approvazione');
        }

        // (2) …e non ha marcato la risposta del turno che l'ha soltanto visto.
        const righe = sessioneOwner(inst);
        const primoCli = righe.findIndex((r) => r.surface === 'cli' && r.role === 'user');
        if (primoCli === -1) throw new Error('nessun turno CLI in owner.jsonl');
        const risposta = righe.slice(primoCli).find((r) => r.role === 'assistant' && r.surface === 'cli');
        if (risposta === undefined) throw new Error('il turno CLI non ha scritto nessuna risposta in owner.jsonl');
        process.stderr.write(
          `  provenienza · risposta CLI marcata tier=${String(risposta.tier)} («${risposta.content.slice(0, 30)}»)\n`,
        );
        if (risposta.tier !== 0) {
          throw new Error(
            `la risposta del turno CLI è marcata tier ${String(risposta.tier)}: il soffitto ereditato è diventato ` +
              'un marchio, cioè un cricchetto che non invecchierà mai fuori dalla finestra (ADR-0044 §Riconciliazione)',
          );
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});

describe('acceptance · i gruppi restano separati · attraverso il percorso di produzione', () => {
  /**
   * La separazione dei gruppi non è una condizione da ricordare in due
   * connector: è una conseguenza di `identify`, che per un `member` produce la
   * stringa per stanza che i connector scrivevano a mano. Ma
   * `core/surface/types.test.ts` prova la funzione, non il cablaggio — e questo
   * repository ha già pagato più volte per un meccanismo giusto che la
   * produzione non attraversa. Qui il gruppo entra dal gateway vero, come un
   * gruppo, e si guarda **quali file di sessione esistono**.
   */
  it(
    'un messaggio di gruppo non finisce nella conversazione dell owner',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'in privata.' }, { text: 'nella stanza.' }, { text: 'ok.' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      const IN_PRIVATA = 'il barometro del capanno segna 1013';
      const NELLA_STANZA = 'che ore sono per la riunione di venerdì';
      try {
        const gw = await pairOwner(inst, tg);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, IN_PRIVATA));
          await until(() => tg.messages().some((m) => m.text.includes('in privata')), 30_000);
          // Stesso mittente — l'owner — ma dentro una stanza: è un `member` di
          // quel tenant, quindi la sua chiave è quella della stanza.
          tg.deliver({
            message: {
              message_id: 9001,
              date: Math.floor(Date.now() / 1000),
              chat: { id: -100_500, type: 'supergroup', title: 'stanza' },
              from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
              text: NELLA_STANZA,
            },
          });
          await until(() => tg.messages().some((m) => m.text.includes('nella stanza')), 30_000);
        } finally {
          await gw.stop();
        }

        const owner = join(inst.home, 'sessions', 'owner.jsonl');
        const stanza = join(inst.home, 'sessions', 'telegram:-100500.jsonl');
        process.stderr.write(
          `  gruppi · owner.jsonl=${existsSync(owner) ? 'sì' : 'no'} telegram:-100500.jsonl=${existsSync(stanza) ? 'sì' : 'no'}\n`,
        );
        if (!existsSync(owner)) throw new Error('la DM dell owner non ha aperto la conversazione condivisa');
        if (!existsSync(stanza)) throw new Error('il gruppo non ha una sessione sua');

        const testoOwner = readFileSync(owner, 'utf8');
        const testoStanza = readFileSync(stanza, 'utf8');
        if (testoOwner.includes(NELLA_STANZA)) {
          throw new Error(
            'il messaggio di gruppo è finito nella conversazione dell owner: un confine di tenant è stato attraversato',
          );
        }
        if (testoStanza.includes(IN_PRIVATA)) {
          throw new Error('la confidenza in privata è finita nella sessione del gruppo');
        }
        const righe = testoStanza
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as { role: string; tier?: number });
        const utente = righe.find((r) => r.role === 'user');
        if (utente?.tier !== 2) {
          throw new Error(`la riga del gruppo non è a tier 2 (gruppo/sconosciuti): ${JSON.stringify(utente)}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    240_000,
  );
});
