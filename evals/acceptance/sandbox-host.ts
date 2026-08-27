import { execFileSync } from 'node:child_process';
import { it } from 'vitest';
import { annunciaSalto } from './non-provabile.js';

/**
 * Questo host **può** contenere, o non è attrezzato per provarlo?
 *
 * Nasce da un rosso che sembrava un difetto e non lo era. Il gate Linux
 * (`gate-linux.sh`) gira dentro Docker, e lì `bwrap` non riesce a montare
 * `/proc` in un namespace nuovo: `SandboxManager` risponde `contain_failed`, il
 * job script non parte, e lo scenario va rosso con un messaggio che si legge
 * come «il sandbox di Muffin è rotto su Linux». Misurato il 27/08: bwrap grezzo
 * lì funziona benissimo — non è Muffin, è il container. Né `--cap-add
 * SYS_ADMIN` né `--security-opt systempaths=unconfined` lo sbloccano, e
 * `--privileged` si pianta.
 *
 * Un rosso falso costa quanto un verde falso: nasconde se la cosa funziona
 * davvero, e insegna a ignorare quel rosso. Ma **saltare in silenzio** sarebbe
 * peggio ancora — sarebbe la stessa suite che dichiara verde una capability che
 * nessuno ha esercitato.
 *
 * Quindi la domanda va posta a **bwrap direttamente**, non a Muffin. Se bwrap
 * grezzo non riesce a fare ciò che a Muffin serve, l'host non è attrezzato e lo
 * scenario si dichiara non provabile *qui*, dicendolo. Se bwrap grezzo ci
 * riesce e Muffin no, quello è un difetto di Muffin e lo scenario deve restare
 * rosso — che è esattamente la distinzione che oggi non esisteva.
 */
export type EsitoHost = { ok: true } | { ok: false; perche: string };

/**
 * `esegui` e `piattaforma` sono iniettabili per una ragione sola: senza, il
 * ramo Linux di questa funzione non è verificabile da macOS, ed è esattamente
 * il ramo che decide se uno scenario viene esercitato o saltato. Un
 * interruttore che non si può testare dalla macchina dove si sviluppa è il modo
 * più rapido perché diventi «salta sempre» senza che nessuno se ne accorga.
 */
export function hostContiene(
  esegui: (file: string, args: string[]) => void = (file, args) => {
    execFileSync(file, args, { timeout: 10_000, stdio: 'pipe' });
  },
  piattaforma: NodeJS.Platform = process.platform,
): EsitoHost {
  if (piattaforma === 'darwin') {
    // seatbelt è nel sistema operativo: non c'è un prerequisito che possa
    // mancare, quindi non c'è niente da dichiarare non provabile.
    return { ok: true };
  }
  if (piattaforma !== 'linux') {
    return { ok: false, perche: `piattaforma ${piattaforma}: nessun meccanismo di contenimento noto` };
  }
  try {
    // Le stesse tre cose che servono a `SandboxManager`, chieste a bwrap nudo:
    // un namespace utente non privilegiato, un `/proc` montato dentro, e un
    // comando che esce zero. `--proc` è quello che fallisce dentro Docker, ed è
    // il motivo per cui sta in questo probe e non in un flag più generico.
    esegui('bwrap', [
      '--ro-bind', '/', '/',
      '--proc', '/proc',
      '--dev', '/dev',
      '--unshare-all',
      '--die-with-parent',
      '/bin/true',
    ]);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const riga = detail.split('\n').find((l) => /bwrap:|ENOENT|not found/.test(l)) ?? detail.slice(0, 200);
    return { ok: false, perche: `bwrap grezzo non contiene su questo host: ${riga.trim()}` };
  }
}

/**
 * Un `it` che ha bisogno di contenimento vero.
 *
 * Gemello di `scenario(..., nonProvabileQui)` per i file che non registrano una
 * riga M5-BIS (`b-job-script`). Stessa regola: la domanda va a bwrap, non a
 * Muffin, e il salto si stampa — una capability non esercitata che non lascia
 * traccia nell'output è indistinguibile da una provata.
 */
export function itConSandbox(
  titolo: string,
  fn: () => Promise<void>,
  timeout?: number,
): void {
  const esito = hostContiene();
  if (esito.ok) {
    it(titolo, fn, timeout);
    return;
  }
  it.skip(annunciaSalto(`«${titolo}»`, esito.perche, (s) => process.stderr.write(s)), fn, timeout);
}
