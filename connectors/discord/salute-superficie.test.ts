import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import { SaluteSuperfici } from '../../core/surface/salute.js';
import type { DiscordApi } from './api.js';
import { DiscordConnector } from './connector.js';
import type { WebSocketLike, WsEvent } from './gateway.js';
import { DiscordInbox } from './inbox.js';

/**
 * Il ponte fra il socket di Discord e cio' che `doctor` legge.
 *
 * `DiscordGateway` sa gia' dire se sta portando eventi (`gateway.test.ts`), e
 * `doctor` sa gia' stampare una superficie caduta (`cli/doctor.test.ts`). In
 * mezzo ci sono quattro righe in `connector.ts`, ed erano l'unico anello della
 * catena che nessun test attraversava — cioe' esattamente il punto in cui il
 * secondo giudice della #260 ha trovato il difetto: `run()` si risolve anche
 * quando rinuncia su un 4004, quindi il `.catch` di `connectSurfaces` non
 * scatta mai e la superficie restava «connessa» dalla stretta di mano d'avvio.
 */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  private handlers: Record<string, ((ev?: WsEvent) => void)[]> = {};
  send(): void {}
  close(code?: number, reason?: string): void {
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev?: WsEvent) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }
  emit(type: string, ev?: WsEvent): void {
    for (const h of this.handlers[type] ?? []) h(ev);
  }
  serverSends(envelope: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }
}

const HELLO = { op: 10, d: { heartbeat_interval: 45_000 } };
const READY = { op: 0, s: 1, t: 'READY', d: { session_id: 's1', resume_gateway_url: 'wss://resume' } };

function connettore(salute: SaluteSuperfici, sockets: FakeSocket[]) {
  const api = {
    me: async () => ({ id: '1', username: 'muffin' }),
    gatewayUrl: async () => ({ url: 'wss://gateway' }),
  } as unknown as DiscordApi;
  return new DiscordConnector({
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    inbox: new DiscordInbox(new DatabaseCtor(':memory:')),
    api,
    salute,
    config: { token: 'tok', ownerUserId: '1' },
    wsFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
}

describe('la salute di Discord arriva dal socket, non dalla stretta di mano', () => {
  it('READY registra la superficie come connessa', async () => {
    const salute = new SaluteSuperfici();
    const sockets: FakeSocket[] = [];
    const c = connettore(salute, sockets);
    const run = c.run();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.serverSends(HELLO);
    sockets[0]!.serverSends(READY);
    await vi.waitFor(() => expect(salute.stato()[0]?.connessa).toBe(true));
    c.stop();
    await run;
  });

  /**
   * Il caso vero: token revocato nel portale. Il connettore **sa** di essere
   * morto e lo scrive nel diario; prima di questa riparazione `doctor`
   * continuava a stampare `✓ superfici discord — connesse` per tutta la vita
   * del processo.
   */
  it('un 4004 lascia la superficie caduta, con la causa e senza confonderla con uno stop', async () => {
    const salute = new SaluteSuperfici();
    const sockets: FakeSocket[] = [];
    const c = connettore(salute, sockets);
    const run = c.run();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.serverSends(HELLO);
    sockets[0]!.close(4004, 'Authentication failed');
    await run;

    const riga = salute.stato()[0];
    expect(riga?.id).toBe('discord');
    expect(riga?.connessa).toBe(false);
    expect(riga?.causa).toContain('non riprovo');
    expect(sockets.length).toBe(1);
  });

  /**
   * `me()` che risponde prova che il token vale e che la rete c'e', **non** che
   * arrivino i messaggi. Prima della riparazione era proprio quella chiamata a
   * dichiarare «connessa», e da li' nasceva il verde su un Discord morto.
   */
  it('la sola risposta di me() non dichiara niente', async () => {
    const salute = new SaluteSuperfici();
    const sockets: FakeSocket[] = [];
    const c = connettore(salute, sockets);
    const run = c.run();
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    // Il socket esiste ma non ha ancora detto READY: `me()` e' gia' passata.
    expect(salute.stato().some((s) => s.connessa)).toBe(false);
    c.stop();
    await run;
  });
});
