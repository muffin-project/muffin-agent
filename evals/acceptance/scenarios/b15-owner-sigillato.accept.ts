import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

/**
 * B15, la metà «protetto»: il pairing lascia il legame **dentro il sigillo**.
 *
 * `b-telegram-pairing.accept.ts` prova già la metà «autenticato» — nessuno è
 * owner finché non manda il codice. Quello che nessuno provava è dove finisce
 * quel legame una volta stabilito: fino a questa fetta viveva soltanto in
 * `surfaces.telegram.ownerUserId`, dentro un `config.json` ordinario che
 * qualunque processo che gira come l'owner può riscrivere — mentre identità,
 * policy, egress e tetti di spesa stanno tutti sotto il Root of Trust. Un file
 * che decide **chi ha autorità** e che nessun hash copre non è un legame
 * protetto.
 *
 * ## Le due proprietà sotto esame, e perché servono entrambe
 *
 *  1. dopo il pairing `rot/owner.json` esiste e nomina l'account che ha
 *     mandato il codice;
 *  2. dopo la scrittura, `muffin rot verify` resta un diagnostico in exit 0
 *     (ADR-0108): un file nuovo in rot/ non è un incidente e non manda
 *     l'installazione in safe mode.
 *
 * Poi `muffin doctor`, perché una proprietà che l'owner non può leggere non
 * esiste per lui: la riga deve dire da dove viene il legame, non solo che c'è.
 */

/** Il legame sigillato, letto dal file: la fonte, non una vista. */
const sigillato = (home: string): { telegram?: { userId?: number } } | null => {
  try {
    return JSON.parse(readFileSync(join(home, 'rot', 'owner.json'), 'utf8')) as {
      telegram?: { userId?: number };
    };
  } catch {
    return null;
  }
};

describe('acceptance · owner binding · il legame finisce sotto il sigillo', () => {
  it('B15 owner binding: pairing writes the owner into rot/owner.json, and verify stays a non-incident diagnostic (ADR-0108)', async () => {
    const tg = await startFakeTelegram();
    const inst = await install({
      main: [{ text: 'Ciao, sono Muffin.' }],
      env: { MUFFIN_GATEWAY_TICK_MS: '300' },
    });
    try {
      const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-bot-token');
      if (tok.code !== 0) throw new Error(`secret set: exit ${tok.code}\n${tok.err}`);

      const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
      if (enable.code !== 0) throw new Error(`surface enable: exit ${enable.code}\n${enable.err}`);
      const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
      if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);

      // Prima del pairing non c'è nessun legame da sigillare: il file non
      // esiste, ed è la direzione fail-closed — non un legame vuoto.
      expect(sigillato(inst.home)).toBeNull();

      const gateway = await inst.gateway();
      await gateway.waitFor(/muffin gateway/, 20_000);
      tg.deliver(privateMessage({ id: 999, name: 'Giusto' }, code));

      await until(() => sigillato(inst.home) !== null, 30_000);
      expect(sigillato(inst.home)?.telegram?.userId).toBe(999);

      // ADR-0108: writing owner.json does not require a reseal, and
      // verify is diagnostic — exit 0 even if a leftover manifest notes the new file.
      const verifica = await inst.muffin(['rot', 'verify']);
      expect(verifica.code).toBe(0);
      expect(verifica.out).toMatch(/rot\/:|diagnostic|ADR-0108|mode single-user/);
      expect(verifica.out + verifica.err).not.toMatch(/safe mode/i);

      // E l'owner può leggerlo, con la provenienza dichiarata.
      const doctor = await inst.muffin(['doctor']);
      expect(doctor.out).toMatch(/owner binding/);
      expect(doctor.out).toMatch(/rot\/owner\.json — telegram 999/);

      await gateway.stop();
    } finally {
      await inst.cleanup();
      await tg.close();
    }
  }, 90_000);
});
