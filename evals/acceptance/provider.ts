import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A model that costs nothing and always says the same thing.
 *
 * Acceptance runs the real binary, and the real binary talks to a provider over
 * HTTP. Injecting a fake `Provider` object would mean not running the real
 * binary — the whole point of this suite — so the seam is put where production
 * already has one: `muffin init --provider openai-compat --base-url <this>`.
 * Nothing in `agent/` or `cli/` learns that it is being tested, which is the
 * only arrangement that can catch a wiring defect.
 *
 * What this buys, beyond determinism:
 *
 *  - **the request is evidence.** Recall, spotlighting, the system prompt and
 *    the tool list all end up in the body this server receives, so a scenario
 *    can assert what the model was *shown* instead of guessing from what came
 *    back. "The fact crossed the process boundary" is a substring check on a
 *    recorded request, not an interpretation of a reply.
 *  - **tool calls are scriptable.** A scenario says "now ask for `fs_write`
 *    with these arguments" and the kernel, the loop and the tool answer for
 *    real.
 *
 * The owner's key is the owner's: no scenario may ever reach a paid endpoint.
 * The one eval that does is `evals/memory/acceptance.ts`, which refuses to
 * start without an explicit key in the environment.
 */

/** One model reply. `tool` and `text` may arrive together; a tool call wins the stop reason. */
export type ScriptedReply = {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
};

export type RecordedRequest = {
  model: string;
  /** The wire messages, verbatim — this is where recall and spotlighting show up. */
  messages: Array<{ role: string; content: unknown }>;
  /** The system block, flattened, whatever dialect it arrived in. */
  system: string;
  /** Tool names offered on this call, in the order the loop exposed them. */
  tools: string[];
  /** Everything the model was shown, as one string. The usual assertion target. */
  transcript: string;
  /** Whether this call asked for SSE (DAY-1 requirement B11) — the ground truth for "did streaming actually turn on", not an assumption from the answer arriving correctly (which a non-streaming fallback would also produce). */
  stream: boolean;
};

export type FakeProvider = {
  /** Pass to `muffin init --base-url`. */
  baseUrl: string;
  /** Every call, main lane and light lane alike, in order. */
  requests: RecordedRequest[];
  /** Only the calls that used the main model — the turns the owner sees. */
  main(): RecordedRequest[];
  close(): Promise<void>;
};

export type FakeProviderOptions = {
  /**
   * Replies for the main model, consumed in order across every process the
   * scenario spawns. Past the end the last text repeats, so a turn that loops
   * one more time than expected does not hang.
   */
  main: ScriptedReply[];
  /**
   * The light lane — extraction, the contradiction judge, the reranker. It gets
   * its own hook because its replies are JSON with a schema, not prose, and
   * because a scenario about memory needs to decide what gets extracted while a
   * scenario about anything else must not have to care.
   *
   * Default: no facts. That is the honest neutral: extraction runs, costs a
   * call, and finds nothing.
   */
  light?: (request: RecordedRequest) => ScriptedReply;
};

/** The shape the light lane must produce for `core/memory/extract.ts`. */
export type ExtractedFactLiteral = {
  subject: string;
  predicate: string;
  object: string;
  subjectKind: 'person' | 'place' | 'organization' | 'project' | 'concept' | 'event' | 'thing';
  validFrom: string | null;
  confidence: number;
  matters?: boolean;
  charged?: boolean;
};

/** Convenience for `light`: the JSON body `extractFacts` parses. */
export function extraction(facts: ExtractedFactLiteral[]): ScriptedReply {
  return { text: JSON.stringify({ facts }) };
}

/**
 * Deterministic and non-zero.
 *
 * A fixed 0 would make every budget assertion vacuous — the caps would never
 * trip because nothing ever spends. Derived from the payload so the same
 * scenario bills the same amount twice.
 */
function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

type Body = {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
};

/**
 * Splits `text` into word-sized pieces, each keeping its own trailing
 * whitespace — so `pieces.join('')` is `text` back exactly, and a scenario
 * asserting "the surface saw more than one delta" has something real to see.
 * One piece when there is nothing to split on, never zero.
 */
function wordChunks(text: string): string[] {
  const pieces = text.match(/\S+\s*/g);
  return pieces && pieces.length > 0 ? pieces : [text];
}

function record(body: Body): RecordedRequest {
  const raw = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
  const messages = raw.map((m) => ({ role: String(m.role ?? ''), content: m.content }));
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => flattenContent(m.content))
    .join('\n');
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ function?: { name?: unknown } }>).map((t) => String(t.function?.name ?? ''))
    : [];
  return {
    model: String(body.model ?? ''),
    messages,
    system,
    tools,
    transcript: messages.map((m) => `${m.role}: ${flattenContent(m.content)}`).join('\n'),
    stream: body.stream === true,
  };
}

/**
 * Loopback, but not `127.0.0.1`.
 *
 * `core/budget/pricing.ts` treats `127.0.0.1` and `localhost` in the base URL as
 * "a model running on this machine", and prices it at zero — correct for Ollama
 * and fatal for a suite that has to prove a cap trips. `::1` is the same
 * loopback and is not one of those hints, so a fake turn bills like a hosted
 * one. Where IPv6 loopback is unavailable the fallback is taken and said out
 * loud, because "the budget scenarios silently measured nothing" is precisely
 * the class of failure this whole suite exists to stop.
 */
async function listen(server: Server): Promise<{ host: string; port: number; billable: boolean }> {
  const tryHost = (host: string): Promise<number | null> =>
    new Promise((resolve) => {
      const onError = (): void => {
        server.removeListener('error', onError);
        resolve(null);
      };
      server.once('error', onError);
      server.listen(0, host, () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    });

  const v6 = await tryHost('::1');
  if (v6 !== null) return { host: '[::1]', port: v6, billable: true };
  const v4 = await tryHost('127.0.0.1');
  if (v4 === null) throw new Error('nessun loopback disponibile per il provider finto');
  process.stderr.write('! provider finto su 127.0.0.1: pricing.ts lo tratta come locale, la spesa sarà 0\n');
  return { host: '127.0.0.1', port: v4, billable: false };
}

export async function startFakeProvider(options: FakeProviderOptions): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  let mainIndex = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: Body;
      try {
        body = JSON.parse(raw || '{}') as Body;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'body non JSON' } }));
        return;
      }
      const entry = record(body);
      requests.push(entry);

      // The lane is decided by the model id, exactly as production bills it:
      // `config.models.light` for extraction and friends, `main` for turns.
      const isLight = /haiku|light/i.test(entry.model);
      let reply: ScriptedReply;
      if (isLight) {
        reply = options.light ? options.light(entry) : extraction([]);
      } else {
        reply = options.main[mainIndex] ?? { text: '(script del provider finto esaurito)' };
        if (mainIndex < options.main.length) mainIndex++;
      }

      const toolCalls = reply.tool
        ? [
            {
              id: `call_${requests.length}`,
              type: 'function' as const,
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
            },
          ]
        : [];
      const content = reply.text ?? null;
      const usage = {
        prompt_tokens: tokensOf(entry.transcript),
        completion_tokens: tokensOf(content ?? '') + toolCalls.length * 20,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      };

      // SSE — B11. Openai-compat shaped, `data: {...}\n\n` chunks ending in
      // the wire's own `data: [DONE]`, the same format `agent/providers/
      // openai-compat.ts#chatStream` parses. This is the "SSE finto" the
      // slice's own brief names: no scenario reaches a paid endpoint, and a
      // scenario for B11 gets a real, if coarse, multi-delta stream rather
      // than one chunk pretending to be several.
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const base = { id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: entry.model };
        const send = (patch: Record<string, unknown>): void => {
          res.write(`data: ${JSON.stringify({ ...base, ...patch })}\n\n`);
        };
        send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        if (content) {
          for (const piece of wordChunks(content)) {
            send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          }
        }
        const tc = toolCalls[0];
        if (tc) {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }] });
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }] });
        send({ choices: [], usage });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const payload = {
        id: `chatcmpl-${requests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: entry.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  const { host, port } = await listen(server);
  return {
    baseUrl: `http://${host}:${port}/v1`,
    requests,
    main: () => requests.filter((r) => !/haiku|light/i.test(r.model)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
