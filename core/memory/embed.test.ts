import { describe, expect, it } from 'vitest';
import { makeEmbedder } from './embed.js';

describe('makeEmbedder — la scelta che il docstring prometteva da sempre', () => {
  const mai = () => {
    throw new Error('nessun segreto va letto per Ollama');
  };

  it('senza configurazione resta Ollama coi default di sempre', () => {
    // Assenza di configurazione non deve mai voler dire comportamento nuovo:
    // è ciò che rende questa slice priva di migrazione.
    const e = makeEmbedder(undefined, mai);
    expect(e.id).toBe('ollama:qwen3-embedding:0.6b');
    expect(e.dimensions).toBe(1024);
  });

  it('`kind: ollama` con modello e dimensioni propri li rispetta', () => {
    const e = makeEmbedder({ kind: 'ollama', model: 'altro', dimensions: 768 }, mai);
    expect(e.id).toBe('ollama:altro');
    expect(e.dimensions).toBe(768);
  });

  it('`openai-compat` legge la chiave dal riferimento, mai dalla config', () => {
    const letti: string[] = [];
    const e = makeEmbedder(
      { kind: 'openai-compat', model: 'text-embedding-3-small', dimensions: 1536, apiKeyRef: 'secret://emb' },
      (ref) => {
        letti.push(ref);
        return 'chiave-finta';
      },
    );
    expect(letti).toEqual(['secret://emb']);
    expect(e.id).toBe('openai-compat:text-embedding-3-small');
    expect(e.dimensions).toBe(1536);
  });

  it('`openai-compat` senza dimensioni rifiuta invece di inventarle', () => {
    // La dimensione è cotta nel DDL della tabella vettoriale: un default
    // inventato qui significa un indice che si rifà da solo il giorno in cui
    // qualcuno scopre il numero vero. Meglio non partire.
    expect(() =>
      makeEmbedder({ kind: 'openai-compat', model: 'x', apiKeyRef: 'secret://e' }, () => 'k'),
    ).toThrow(/dimensions/);
  });

  it('e nomina tutto ciò che manca, non solo il primo', () => {
    expect(() => makeEmbedder({ kind: 'openai-compat' }, () => 'k')).toThrow(
      /model.*dimensions.*apiKeyRef/s,
    );
  });
});
