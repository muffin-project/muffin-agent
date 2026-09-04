import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardiano contro il dato personale che rientra — non quello di oggi, il
 * prossimo. Questo repo è dichiarato MIT e prima o poi diventa pubblico:
 * finché resta privato, un percorso di home o un id di chat nel materiale
 * vivo è innocuo; il giorno dell'apertura, non lo è più, e nessuno se ne
 * accorge finché non è già successo — la stessa forma di guasto silenzioso
 * che questo repo paga altrove (`docs/collegamenti.test.ts`, sopra).
 *
 * ## Perché il guardiano non nomina l'owner
 *
 * Un test che cerca il numero letterale dell'id Telegram dell'owner
 * **contiene** quel numero — cioè pubblica esattamente ciò che dovrebbe
 * impedire di pubblicare, nel file che chiunque può leggere. Le regole sotto
 * riconoscono perciò la **forma** di un dato personale (percorso di home
 * assoluto, id di chat in posizione riconoscibile, email fuori da un dominio
 * riservato alla documentazione) e non un valore specifico. Il vantaggio non
 * è solo evitare l'autocontraddizione: una regola di forma prende anche una
 * fuga futura, di un contributor futuro, non solo quella misurata il
 * 2026-09-04.
 *
 * L'alternativa scartata è leggere l'id vero da `~/.muffin/config.json`
 * quando l'installazione dell'owner è presente. In CI quel file non esiste
 * mai — un checkout fresco non ha `~/.muffin` — quindi il ramo "da fuori"
 * degraderebbe silenziosamente al controllo di forma proprio nell'unico posto
 * dove questo guardiano lavora davvero, aggiungendo un secondo percorso di
 * codice che il gate reale non esercita mai. Costruire quel ramo qui
 * comprerebbe complessità senza comprare copertura.
 *
 * ## Le quattro forme, e perché ciascuna
 *
 *  - **percorso di home assoluto** — `/Users/<segmento>` o `/home/<segmento>`.
 *    È la forma del leak misurato il 2026-09-04 (il segmento uguale allo
 *    username Unix dell'owner, in 7 file) e la più stabile: qualunque OS,
 *    qualunque contributor, `id -un` finisce lì.
 *  - **id di chat in formato connettore** — `` `telegram:<cifre>` `` /
 *    `` `discord:<cifre>` ``. È letteralmente come i connettori sotto
 *    `connectors/` costruiscono la scope-key di sessione
 *    (`telegram:${chatId}`), quindi è
 *    anche la forma in cui un id reale finisce per essere incollato in un
 *    verbale — il caso di `docs/decisions/0044-*.md:608`.
 *  - **cifre in posizione di `chat_id`** — una sequenza di 6-12 cifre fra
 *    backtick sulla stessa riga in cui compare la stringa `chat_id`. Più
 *    stretta della precedente apposta: un numero fra backtick da solo prende
 *    anche run id di CI e altri identificatori pubblici non personali (misura
 *    sotto), mentre l'adiacenza col nome del campo è il segnale che sta
 *    mostrando un *valore* di quel campo — il caso di
 *    `docs/history/foundations/legacy/INVARIANTS.md:265`.
 *  - **email fuori da un dominio riservato alla documentazione** — RFC 2606
 *    riserva `example.com/.net/.org` e i TLD `.example`/`.test`/`.invalid`
 *    proprio perché non risolvono mai a un indirizzo vero; `.local` è
 *    aggiunto perché il repo lo usa già con lo stesso intento
 *    (`acceptance@test.local`). Nessuna email reale è stata trovata il
 *    2026-09-04: questa regola è prevenzione, non correzione.
 *
 * ## Misura del falso positivo (2026-09-04, prima della correzione)
 *
 * Ogni regola sopra è stata calibrata contro l'intero corpus prima di essere
 * scritta così, non dopo: la sequenza nuda fra backtick, senza il vincolo che
 * la riga nomini anche il campo chat id, prendeva anche un run id di undici
 * cifre di `gh run list` (citato due volte in
 * `docs/evidence/triage-2026-08-17/c-d.md`) — pubblico ma non personale, ed è
 * il motivo per cui quella regola resta vincolata all'adiacenza col nome del
 * campo, non a "qualunque numero lungo fra backtick". Con le quattro regole
 * finali, il corpus intero richiede la lista di eccezioni sotto e nessun'altra:
 * una manciata di segmenti-home, un indirizzo email e il segnaposto numerico
 * introdotto da questa stessa PR — già in uso come dati fittizi nei test o
 * appena scelti come sostituto, ciascuno verificato a mano — non una soglia
 * scelta per abbassare il conteggio.
 *
 * ## Perché vive qui, con questo nome
 *
 * `.github/workflows/collegamenti.yml` è l'unico job che triggera anche su
 * una PR di soli documenti (`ci.yml` e `accettazione.yml` hanno `docs/**` in
 * `paths-ignore`, per la ragione già scritta in testa a quel workflow) — ed è
 * esattamente il caso che conta: un dato personale rientra quasi sempre
 * editando un documento, mai il codice. Questa slice non può toccare
 * `.github/workflows/` (vincolo del mandato), quindi il guardiano non può
 * aggiungere un proprio step lì: deve entrare nello step già esistente,
 * `npx vitest run docs/collegamenti --reporter=dot`. Vitest filtra i file per
 * sottostringa del path, non per match esatto — verificato eseguendo quel
 * comando con questo file presente — quindi il nome `collegamenti-` non è
 * decorativo: è il modo in cui questo file entra nel job senza una riga di
 * YAML in più. Le regole sotto sono comunque indipendenti da
 * `docs/collegamenti.test.ts`: guardano una proprietà diversa (dato personale,
 * non riferimento rotto) e coprono anche ADR/evidence/history, che quel
 * checker esclude apposta (§ sopra).
 */

const QUI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(QUI, '..');

const IGNORA = new Set(['node_modules', 'dist', '.git', '.releases', '.codex']);

function esclusa(rel: string): boolean {
  return rel === '.claude/worktrees' || rel.startsWith('.claude/worktrees/');
}

function tuttiIFile(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORA.has(e.name) || e.name.startsWith('.DS')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (esclusa(relative(REPO, p))) continue;
      tuttiIFile(p, acc);
    } else acc.push(p);
  }
  return acc;
}

// Deliberatamente più largo di `VIVO`/`ARCHIVIATO` di `docs/collegamenti.test.ts`:
// un dato personale in un verbale d'evidenza o in un ADR (entrambi
// "archiviati" per quel checker) è comunque un dato personale pubblicato, e
// proprio lì vivevano i due leak misurati.
const LEGGIBILE = /\.(md|ts|tsx|mjs|js|yml|yaml|json|txt)$/;

const file = tuttiIFile(REPO)
  .map((p) => relative(REPO, p))
  .filter((p) => LEGGIBILE.test(p))
  .sort();

type Reperto = { file: string; riga: number; testo: string; motivo: string };

function numeroRiga(testo: string, index: number): number {
  return testo.slice(0, index).split('\n').length;
}

/** `/Users/<segmento>` o `/home/<segmento>` — solo il primo segmento dopo l'home. */
const SEGMENTO_HOME = /\/(?:Users|home)\/([A-Za-z0-9][A-Za-z0-9_.&-]*)/g;

/**
 * Segmenti-home già presenti nel repo, verificati uno a uno: nessuno è
 * l'owner. Ogni voce è un nome fittizio usato deliberatamente in un test o in
 * un placeholder editoriale, non un contributor reale.
 *
 *  - `you`, `user`, `utente`, `someone`, `qualcuno` — segnaposto generici in
 *    prosa e in `.env.example` (`user`/`utente` sono anche il segnaposto
 *    scelto da questa stessa correzione per l'home dell'owner).
 *  - `g`, `o`, `x`, `a&b`, `a&amp` — username sintetici a una lettera (più la
 *    coppia escaped/non-escaped di `&`) in `core/gateway/unit.test.ts` e
 *    `core/config/home-guard.test.ts`, lì per provare l'escaping e il
 *    path-building, non per somigliare a un nome.
 *  - `mario` — placeholder italiano generico (l'equivalente di "John Doe"),
 *    `core/config/workspace.test.ts`.
 *  - `owner` — placeholder letterale, `agent/context/ambiente.test.ts`.
 *  - `muffin` — nome del prodotto, non di una persona, `core/sandbox/probe.test.ts`.
 *  - `homeDir` — falso positivo di forma: `core/gateway/supervisor.ts:72` ha
 *    un commento con un elenco di nomi separati da `/`
 *    (`platform/home/homeDir/configHome`) che la regex legge come un
 *    percorso perché la sottostringa `/home/homeDir` compare per davvero,
 *    anche se non è un path.
 */
const SEGMENTI_INNOCUI = new Set([
  'you',
  'user',
  'utente',
  'someone',
  'qualcuno',
  'g',
  'o',
  'x',
  'a&b',
  'a&amp',
  'mario',
  'owner',
  'muffin',
  'homeDir',
]);

/** `` `telegram:<cifre>` `` / `` `discord:<cifre>` `` — la scope-key di sessione vera. */
const ID_CONNETTORE = /`(?:telegram|discord):(\d{5,})`/g;

/** Cifre fra backtick, lette solo su una riga che nomina anche `chat_id`. */
const CHAT_ID_NUDO = /`(\d{6,12})`/g;

/**
 * Il segnaposto scelto da questa stessa PR per l'id Telegram reale
 * dell'owner, in `docs/decisions/0044-il-disco-non-ha-provenienza.md:608` e
 * `docs/history/foundations/legacy/INVARIANTS.md:265`. Cifre scelte a caso,
 * non l'id vero — ma un verbale cita un output letterale, e un segnaposto
 * ovviamente sequenziale (`000000000`, `123456789`) sarebbe comunque
 * indistinguibile da un id vero *per la forma*: l'eccezione è sul valore
 * esatto introdotto qui, non un indebolimento della regola di forma.
 */
const ID_INNOCUI = new Set(['987654321']);

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * RFC 2606 riserva esplicitamente `example.com`/`.net`/`.org` (nomi di
 * secondo livello) e i TLD `.example`/`.test`/`.invalid` come indirizzi che
 * non risolvono mai a qualcuno di vero. `.local` non è nella RFC ma il repo
 * lo usa già con lo stesso intento (vedi eccezioni email sotto).
 */
const DOMINI_RISERVATI = new Set(['example.com', 'example.net', 'example.org']);
const TLD_RISERVATO = /\.(example|test|invalid|localhost|local)$/i;
function dominioInnocuo(dominio: string): boolean {
  return DOMINI_RISERVATI.has(dominio.toLowerCase()) || TLD_RISERVATO.test(dominio);
}

/**
 * Indirizzi fittizi già in uso nei test che non sono su un dominio RFC 2606
 * ma non sono comunque nessuno reale:
 *  - `mario@x.it` — esempio di worked-example nel system prompt di
 *    `core/memory/extract.ts` ("mandare i report a mario@x.it"), ripreso dal
 *    suo test; `mario` è lo stesso placeholder italiano generico usato per i
 *    percorsi di home.
 */
const EMAIL_INNOCUE = new Set(['mario@x.it']);

function scansiona(): Reperto[] {
  const out: Reperto[] = [];

  for (const f of file) {
    const testo = readFileSync(join(REPO, f), 'utf8');

    for (const m of testo.matchAll(SEGMENTO_HOME)) {
      const segmento = m[1]!;
      if (SEGMENTI_INNOCUI.has(segmento)) continue;
      out.push({
        file: f,
        riga: numeroRiga(testo, m.index!),
        testo: m[0]!,
        motivo: `percorso di home assoluto con segmento '${segmento}'`,
      });
    }

    for (const m of testo.matchAll(ID_CONNETTORE)) {
      if (ID_INNOCUI.has(m[1]!)) continue;
      out.push({
        file: f,
        riga: numeroRiga(testo, m.index!),
        testo: m[0]!,
        motivo: 'id di chat in formato connettore (telegram:/discord:)',
      });
    }

    for (const m of testo.matchAll(EMAIL)) {
      const dominio = m[1]!;
      if (dominioInnocuo(dominio)) continue;
      if (EMAIL_INNOCUE.has(m[0]!.toLowerCase())) continue;
      out.push({
        file: f,
        riga: numeroRiga(testo, m.index!),
        testo: m[0]!,
        motivo: 'email fuori da un dominio riservato alla documentazione',
      });
    }

    const righe = testo.split('\n');
    righe.forEach((l, i) => {
      if (!l.includes('chat_id')) return;
      for (const m of l.matchAll(CHAT_ID_NUDO)) {
        if (ID_INNOCUI.has(m[1]!)) continue;
        out.push({
          file: f,
          riga: i + 1,
          testo: m[0]!,
          motivo: 'cifre in posizione di chat_id',
        });
      }
    });
  }

  return out;
}

describe('dati personali dell\'owner fuori dal repo', () => {
  it('il corpus sorvegliato non è vuoto', () => {
    // Stessa lezione di `docs/collegamenti.test.ts`: un controllo su zero
    // file passa verde e non prova niente.
    expect(file.length).toBeGreaterThan(100);
    for (const sentinella of ['docs/decisions/0044-il-disco-non-ha-provenienza.md', 'cli/STYLES.md']) {
      expect(file, `il corpus non contiene ${sentinella}`).toContain(sentinella);
    }
  });

  it('non contiene percorsi di home, id di chat o email fuori da un segnaposto noto', () => {
    const trovati = scansiona().map(
      (r) => `${r.file}:${r.riga} — ${r.motivo}: ${r.testo}`,
    );
    expect(trovati).toEqual([]);
  });
});
