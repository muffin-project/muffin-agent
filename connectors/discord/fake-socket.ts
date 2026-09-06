import type { WebSocketLike, WsEvent } from './gateway.js';

/**
 * The Discord gateway socket, scripted by a test instead of by Discord.
 *
 * Node has a built-in WebSocket *client* (since v22.4.0) but no built-in
 * WebSocket *server*, so there is nothing to point a real socket at without
 * either a new dependency or hand-rolling RFC 6455 framing — and either would
 * be testing Node's WebSocket implementation rather than `DiscordGateway`'s
 * state machine. `DiscordGatewayDeps.wsFactory` exists for exactly this: what
 * is emitted here is the same three events (`message`, `close`, `error`) the
 * real class listens for, and nothing more.
 *
 * Extracted in slice 16 (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
 * §3 row 16, "estrarre `FakeSocket` da `connectors/discord/gateway.test.ts`").
 * There were **two** copies by then — `gateway.test.ts`'s and a smaller one in
 * `salute-superficie.test.ts` whose `send()` threw its argument away — and the
 * parity test needed a third. Shipped beside the code it doubles rather than
 * hidden in one of those files, for the same reason `evals/acceptance/
 * telegram.ts` is a real module: a double that two tests import is one
 * behaviour, and a double copied into each is two that drift.
 */
export class FakeSocket implements WebSocketLike {
  readyState = 1;
  /** Every frame the connector sent, already parsed — Identify, Resume, heartbeats. */
  readonly sent: unknown[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly handlers: Record<string, ((ev?: WsEvent) => void)[]> = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code: code ?? 1000, reason: reason ?? '' };
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev?: WsEvent) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }

  emit(type: string, ev?: WsEvent): void {
    for (const h of this.handlers[type] ?? []) h(ev);
  }

  /** One frame from Discord's side, as the wire carries it. */
  serverSends(envelope: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(envelope) });
  }
}

/** The two frames every session opens with, before any dispatch can arrive. */
export const HELLO = (intervalMs = 45_000): Record<string, unknown> => ({ op: 10, d: { heartbeat_interval: intervalMs } });

export const READY = (sessionId = 's1', resumeUrl = 'wss://resume.discord.gg'): Record<string, unknown> => ({
  op: 0,
  s: 1,
  t: 'READY',
  d: { session_id: sessionId, resume_gateway_url: resumeUrl },
});
