import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Un System One che non costa niente e risponde sempre lo stesso.
 *
 * Stessa ragione del provider finto (`provider.ts`): l'accettazione fa
 * girare il binario vero, e il binario vero parla al giudice su HTTP. Il
 * confine è dove la produzione ce l'ha già — `config.judgment.baseUrl`
 * punta qui — quindi niente in `core/judgment/` sa di essere sotto test.
 *
 * **La richiesta è evidenza**: l'envelope che parte dalla macchina finisce
 * nel corpo che questo server riceve, quindi lo scenario asserisce ciò che
 * il giudice ha *visto* (e che i segreti non c'erano) invece di indovinarlo
 * dalla riga del database.
 *
 * Le risposte sono noul deterministiche, una per domanda ricevuta: i valori
 * non importano a questa fase — importa la forma tipizzata e il fatto che
 * la riga la registri.
 */

export type RecordedJudgmentRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  authorization: string | null;
  at: number;
};

export type FakeJudge = {
  /** Passa a `config.judgment.baseUrl`: la radice, l'SDK aggiunge `/v1/systemone`. */
  baseUrl: string;
  requests: RecordedJudgmentRequest[];
  close(): Promise<void>;
};

export async function startFakeJudge(): Promise<FakeJudge> {
  const requests: RecordedJudgmentRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/systemone')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'solo /v1/systemone' } }));
        return;
      }
      let body: { model?: unknown; state?: unknown; questions?: unknown };
      try {
        body = JSON.parse(raw || '{}') as typeof body;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'body non JSON' } }));
        return;
      }
      const questions = (body.questions ?? {}) as Record<string, unknown>;
      requests.push({
        model: String(body.model ?? ''),
        state: (body.state ?? {}) as Record<string, unknown>,
        questions,
        authorization: req.headers.authorization ?? null,
        at: Date.now(),
      });
      // Una risposta noul per ogni domanda ricevuta: la forma è quella del
      // filo (`type: 'noul'`, `noul: <p>`), i valori fissi e innocui.
      const risposte: Record<string, { type: string; noul: number }> = {};
      for (const id of Object.keys(questions)) risposte[id] = { type: 'noul', noul: 0.83 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-1.13.0-finto',
          answers: risposte,
          usage: { input_tokens: 321, output_tokens: 27 },
        }),
      );
    });
  });

  const porta = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return {
    baseUrl: `http://127.0.0.1:${porta}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
