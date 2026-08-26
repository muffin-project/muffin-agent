import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Span } from '../core/tracing/types.js';
import { formatSpan, formatTurn, readSpans } from './trace.js';

/**
 * Il difetto che questo file esiste per non far tornare (dogfood, 26/08/2026):
 * un turno finisce stampando `trace c22cb4445952` — dodici caratteri dei
 * trentadue — e l'unico filtro che il CLI aveva confrontava per uguaglianza.
 * Quindi l'unico id che il prodotto ti mette in mano era l'unico che rifiutava,
 * con un «no spans matched» su un trace che era lì.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TRACE = 'c22cb4445952aaaabbbbccccddddeeee';

/** Secondi dall'inizio del turno, in nanosecondi dall'epoch. */
const BASE = 1_787_000_000_000_000_000;
function at(seconds: number): number {
  return BASE + seconds * 1e9;
}

function span(over: Partial<Span> & { name: Span['name'] }): Span {
  return {
    traceId: TRACE,
    spanId: 'aaaaaaaaaaaaaaaa',
    parentSpanId: null,
    startTimeUnixNano: at(0),
    endTimeUnixNano: at(1),
    status: 'ok',
    attributes: {},
    semconvVersion: '1.42.0',
    ...over,
  };
}

function homeWith(spans: readonly Span[], day = '2026-08-26'): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-trace-'));
  dirs.push(home);
  mkdirSync(join(home, 'traces'), { recursive: true });
  writeFileSync(join(home, 'traces', `${day}.jsonl`), `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`);
  return home;
}

describe('un turno si ritrova con l id che il turno stampa', () => {
  it('il prefisso di dodici caratteri basta, ed è esattamente quello stampato', () => {
    const home = homeWith([span({ name: 'muffin.turn' })]);
    const found = readSpans(home, { limit: 10, traceId: TRACE.slice(0, 12) });
    expect(found).toHaveLength(1);
    expect(found[0]?.traceId).toBe(TRACE);
  });

  it('l id intero continua a funzionare', () => {
    const home = homeWith([span({ name: 'muffin.turn' })]);
    expect(readSpans(home, { limit: 10, traceId: TRACE })).toHaveLength(1);
  });

  it('un prefisso che non è di questo turno non pesca niente — non è un match qualunque', () => {
    const home = homeWith([span({ name: 'muffin.turn' })]);
    expect(readSpans(home, { limit: 10, traceId: 'ffffffffffff' })).toHaveLength(0);
    // E nemmeno un pezzo *in mezzo* all id: è un prefisso, non una sottostringa.
    expect(readSpans(home, { limit: 10, traceId: TRACE.slice(4, 16) })).toHaveLength(0);
  });
});

describe('la vista di un turno dice cosa ha fatto, quanto ci ha messo e quanti token', () => {
  const spans = [
    span({
      name: 'muffin.turn',
      startTimeUnixNano: at(0),
      endTimeUnixNano: at(108),
    }),
    span({
      name: 'muffin.chat_call',
      spanId: 'b'.repeat(16),
      startTimeUnixNano: at(0.1),
      endTimeUnixNano: at(44),
      attributes: {
        'gen_ai.request.model': 'qwen/qwen3.8-27b',
        'gen_ai.usage.input_tokens': 5938,
        'gen_ai.usage.output_tokens': 1204,
        'muffin.usage.cache_read_tokens': 4800,
        'muffin.stop_reason': 'tool_use',
      },
    }),
    span({
      name: 'muffin.chat_call',
      spanId: 'c'.repeat(16),
      startTimeUnixNano: at(45),
      endTimeUnixNano: at(108),
      attributes: {
        'gen_ai.request.model': 'qwen/qwen3.8-27b',
        'gen_ai.usage.input_tokens': 5661,
        'gen_ai.usage.output_tokens': 1372,
        'muffin.stop_reason': 'end_turn',
      },
    }),
  ];

  it('somma i token di ogni chiamata e conta i passaggi, invece di mostrarli uno alla volta', () => {
    const out = formatTurn(spans);
    expect(out).toContain('2 chiamate al modello');
    expect(out).toContain('11599 in / 2576 out'); // 5938+5661 · 1204+1372
    expect(out).toContain('4800 da cache');
    expect(out).toContain('108.0s'); // dal primo inizio all ultima fine
  });

  it('ogni step porta la sua durata e i suoi token, non solo la durata', () => {
    const out = formatTurn(spans);
    expect(out).toContain('in=5938 out=1204');
    expect(out).toContain('stop=tool_use');
    // Gli offset sono relativi al primo span: "+45.0s" trova lo step lento,
    // un orario assoluto no.
    expect(out).toContain('+45.0s');
  });

  it('anche la vista a scorrimento mostra i token — era la domanda senza risposta', () => {
    const line = formatSpan(spans[1]!);
    expect(line).toContain('in=5938');
    expect(line).toContain('out=1204');
  });

  it('un turno senza span lo dice invece di stampare una tabella vuota', () => {
    expect(formatTurn([])).toContain('nessuno span');
  });

  it('il turno sta nell intestazione, non fra i suoi stessi step', () => {
    const out = formatTurn(spans);
    // Lo span radice apre per primo e chiude per ultimo: lasciato in lista
    // finisce in fondo con un `+0.0s` sotto un `+45.0s`, e chi legge deve
    // fermarsi a capire che è la cornice.
    expect(out.split('\n').filter((l) => l.includes('turn ')).length).toBe(0);
    expect(out).toContain('2 step');
  });

  it('gli step sono in ordine di inizio, non di chiusura', () => {
    // Gli span si scrivono quando *finiscono*, quindi un padre arriva dopo i
    // figli e uno step lungo dopo uno corto partito più tardi. Con la colonna
    // degli offset, un ordine di chiusura è una tabella che si contraddice.
    const out = formatTurn([spans[0]!, spans[2]!, spans[1]!]);
    const rows = out.split('\n').filter((l) => l.includes('chat_call'));
    expect(rows[0]).toContain('+0.1s');
    expect(rows[1]).toContain('+45.0s');
  });

  it('il recall della memoria non è una riga vuota', () => {
    // È uno span `tool_call` che non è un tool: si nomina in
    // `gen_ai.operation.name`. Chiedere solo `gen_ai.tool.name` stampava una
    // riga bianca proprio per il primo step di ogni turno.
    const out = formatTurn([
      spans[0]!,
      span({
        name: 'muffin.tool_call',
        spanId: 'd'.repeat(16),
        startTimeUnixNano: at(0),
        endTimeUnixNano: at(1.8),
        attributes: { 'gen_ai.operation.name': 'memory.recall', 'muffin.memory.items': 11 },
      }),
    ]);
    expect(out).toContain('op=memory.recall');
  });

  it('un turno di cui è rimasta solo la cornice non finge di avere step', () => {
    const out = formatTurn([spans[0]!]);
    expect(out).toContain('0 step');
    expect(out).toContain('nessuno step registrato');
  });
});
