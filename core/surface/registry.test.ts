import { describe, expect, it } from 'vitest';
import { SurfaceRegistry } from './registry.js';
import { DELIVERED, MUTA, type Surface } from './types.js';

function fakeSurface(id: string): Surface {
  return {
    id,
    limits: { maxMessageChars: 100, maxUploadBytes: 0, maxDownloadBytes: 0 },
    streaming: { transport: 'off' },
    places: ['terminal'],
    negotiate: () => MUTA,
    handles: (c) => c.startsWith(`${id}:`) || c === id,
    deliver: async () => DELIVERED,
    deliverFile: async () => DELIVERED,
  };
}

/**
 * The gap measured for item 5: a surface enabled in `config.json` after this
 * process's `SurfaceRegistry` was built (`muffin surface enable X` against an
 * already-running gateway) is not in `surfaces` — `connectSurfaces` only runs
 * at boot — and a delivery to it silently answered `{ delivered: false }` with
 * a message indistinguishable from "this channel was never configured at
 * all". The fix threads a live read of `config.json`'s `surfaces.enabled`
 * into the registry so it can tell the two apart and name the exact command
 * that fixes the first one.
 */
describe('SurfaceRegistry.deliver — la superficie abilitata dopo il boot', () => {
  it('un canale mai configurato resta il messaggio generico', async () => {
    const registry = new SurfaceRegistry([fakeSurface('telegram')], () => ['telegram']);

    const outcome = await registry.deliver('discord:123', 'ciao');

    expect(outcome).toEqual({
      delivered: false,
      why: expect.stringContaining('nessuna superficie serve') as unknown as string,
    });
  });

  it('una superficie abilitata in config ma assente dal registro dice il comando esatto', async () => {
    // "discord" è in config.surfaces.enabled ma questo processo ha costruito
    // il registro prima che quell'abilitazione fosse scritta — lo stesso
    // scarto fra `loadConfig` a boot e `config.json` sul disco adesso che
    // `readDefaultChannel` già chiude per `surfaces.default`.
    const registry = new SurfaceRegistry([fakeSurface('telegram')], () => ['telegram', 'discord']);

    const outcome = await registry.deliver('discord:987654', 'ciao');

    expect(outcome.delivered).toBe(false);
    if (outcome.delivered) throw new Error('unreachable');
    expect(outcome.why).toContain('discord');
    expect(outcome.why).toContain('muffin gateway stop && muffin gateway start');
    // Non deve travestirsi da "canale sconosciuto": è una riga che l'owner può
    // eseguire, non un mistero.
    expect(outcome.why).not.toContain('nessuna superficie serve');
  });

  it('senza il secondo argomento si comporta esattamente come prima (retro-compatibile)', async () => {
    const registry = new SurfaceRegistry([fakeSurface('telegram')]);

    const outcome = await registry.deliver('discord:1', 'ciao');

    expect(outcome).toEqual({
      delivered: false,
      why: expect.stringContaining('nessuna superficie serve') as unknown as string,
    });
  });
});
