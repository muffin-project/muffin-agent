import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install } from '../harness.js';

/**
 * Due superfici vive, un solo agente.
 *
 * La domanda dell'owner, testualmente: *«attivare il gateway, tenerlo sempre
 * attivo e parlarci, e vedere che sia davvero un agente in runtime e non un
 * chatbot»*. Un chatbot è una funzione da testo a testo: esiste solo mentre
 * qualcuno la chiama, e due chiamate non si conoscono. La proprietà che nega
 * quella forma è questa — **mentre** un processo residente è vivo e lavora,
 * un secondo processo parla allo stesso agente, e i due condividono memoria e
 * lavoro senza corrompersi né duplicarsi.
 *
 * Nessuno scenario la copriva, e non per svista: `lane-concurrency` prova che
 * *dentro* il gateway un job e un turno sospeso non chiamano il modello
 * insieme — due pezzi di lavoro dello stesso processo. B1 prova la continuità
 * *sequenziale*, un processo dopo l'altro. Qui i due processi sono
 * contemporanei, che è il caso che l'owner vive ogni giorno: `muffin` aperto
 * mentre il gateway di launchd è già su.
 *
 * ## Cosa rende questa prova difficile da superare per caso
 *
 * Che le due parti si vedano non è asserito su una riga di log ma su tre cose
 * che solo un agente condiviso può produrre insieme:
 *
 *  1. la conversazione vede il **testo di un turno che non ha chiesto lei** —
 *     quello del job che il gateway ha eseguito per conto suo, che non è mai
 *     passato da questo processo;
 *  2. il database ha **una riga per turno**, mai due per lo stesso lavoro:
 *     due processi vivi sullo stesso file non si sono duplicati a vicenda;
 *  3. il provider finto conta le chiamate. Se gateway e conversazione avessero
 *     rifatto lo stesso lavoro invece di condividerlo, il conto sarebbe più
 *     alto del numero di turni.
 */

describe('acceptance · due superfici vive · un solo agente', () => {
  it(
    'una conversazione e un gateway vivo condividono memoria e lavoro senza duplicarli',
    async () => {
      const inst = await install({
        main: [
          // 1. Il job che il gateway esegue da solo, mentre nessuno parla.
          { text: 'Ho controllato la posta: niente di urgente.' },
          // 2. La conversazione che arriva dopo, in un altro processo, e che
          //    deve poter vedere ciò che il gateway ha fatto senza di lei.
          { text: 'Sì: poco fa ho controllato la posta e non c’era niente di urgente.' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '300' },
      });
      try {
        // --- (a) un gateway vero, vivo per tutta la durata dello scenario.
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 20_000);

        // --- (b) un job dovuto: il lavoro che nasce senza che nessuno parli.
        const added = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 8 * * *',
          '--channel',
          'cli',
          'controlla la posta',
        ]);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);

        // Portato nel passato dal database, come fa `lane-concurrency`: è
        // l'unico modo per averlo già scaduto attraverso il CLI vero, che
        // calcola sempre la prossima occorrenza in avanti.
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        db.prepare(`UPDATE jobs SET next_fire_at = ?`).run(new Date(Date.now() - 60_000).toISOString());
        db.close();

        // --- (c) il gateway lo esegue da solo. Nessuno gli sta parlando.
        await gateway.waitFor(/niente di urgente/, 40_000);

        // --- (d) ORA la seconda superficie, mentre il gateway è ancora vivo.
        //     Non dopo averlo fermato: è il punto dello scenario.
        const chat = await inst.muffin([
          'run',
          '--session',
          'due-superfici-chat',
          '--timeout',
          '30',
          'hai controllato la posta?',
        ]);
        if (chat.code !== 0) throw new Error(`la conversazione è fallita: exit ${chat.code}\n${chat.err}`);

        // Il gateway non è morto per il fatto che qualcuno gli ha parlato
        // sopra: è la metà di «tenerlo sempre attivo» che si può provare qui.
        const stato = await inst.muffin(['gateway', 'status']);
        expect(`${stato.out}${stato.err}`).toMatch(/attivo/);

        // --- (e) il pezzo che nessun chatbot può avere: la conversazione
        //     RICORDA, con la provenienza, un lavoro che non è mai passato da
        //     questo processo né da questa sessione. Il blocco di memoria che
        //     il secondo processo riceve contiene, verbatim:
        //
        //       - [Muffin via cli, <data>] Ho controllato la posta: niente di urgente.
        //
        //     cioè l'episodio scritto dal gateway, attribuito a Muffin e non
        //     all'owner. Asserito sul blocco, non su una sottostringa qualsiasi
        //     del corpo: `toContain('niente di urgente')` da solo passerebbe
        //     anche se il testo arrivasse da un'eco del provider finto.
        const richieste = inst.provider.main();
        const ultima = richieste[richieste.length - 1];
        if (!ultima) throw new Error('il provider finto non ha registrato la richiesta della conversazione');
        const visto = JSON.stringify(ultima);
        expect(visto).toMatch(/MEMORIA_[0-9a-f]+/);
        expect(visto).toMatch(/\[Muffin via cli[^\]]*\][^"]*niente di urgente/);

        // --- (f) una riga per turno, mai due.
        const turni = inst.db(
          (d) =>
            d.prepare(`SELECT id, status, turn_outcome FROM turns`).all() as Array<{
              id: string;
              status: string;
              turn_outcome: string | null;
            }>,
        );
        expect(turni).toHaveLength(2); // il job, e la conversazione
        // Entrambi chiusi: nessuno dei due è rimasto appeso perché l'altro era vivo.
        expect(turni.every((t) => t.status === 'done')).toBe(true);

        // --- (g) e il modello è stato chiamato una volta per turno, non una
        //     volta per ogni processo che credeva di doverlo fare.
        expect(richieste).toHaveLength(2);

        await gateway.stop();
      } finally {
        await inst.cleanup();
      }
    },
    90_000,
  );
});
