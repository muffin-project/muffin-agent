import { describe, expect, it } from 'vitest';
import { echoContentFor } from './sensitive-echo.js';

/**
 * The single classification both echo paths delegate to — live collection in
 * `guidaIlTurno` and durable rehydration in `TurnRun`. If a third copy of
 * this matrix ever appears (a tool set restated, an argument lookup
 * re-derived), this file is where the drift is caught: extend the matrix
 * here, never beside the new copy.
 */
describe('sensitive-echo · one classifier for live collect and replay', () => {
  const secret = (name: string) => ({ type: 'tool_result', toolCallId: 'c1', content: name }) as const;

  it.each([
    ['fs_read', { path: 'credenziali.txt' }],
    ['fs_read', { path: 'chiave-privata.pem' }],
    ['http_get', { url: 'https://x/segreto.json' }],
    ['document_read', { path: 'vault/segreto.md' }],
    ['skill_read', { path: 'skills/segreto/SKILL.md' }],
  ])('collects %s on a sensitive name', (tool, args) => {
    expect(echoContentFor(tool, args, secret('contenuto'))).toBe('contenuto');
  });

  it.each([
    ['collects nothing on a plain name', 'fs_read', { path: 'note.md' }, secret('pubblico'), undefined],
    ['collects nothing on a write-shaped call', 'fs_write', { path: 'segreto.txt' }, secret('scritto'), undefined],
    [
      'collects nothing on a failed read',
      'fs_read',
      { path: 'segreto.txt' },
      { type: 'tool_result', toolCallId: 'c1', content: 'errore', isError: true },
      undefined,
    ],
    ['collects nothing without a named resource', 'fs_read', {}, secret('x'), undefined],
    ['collects nothing off a non-result block', 'fs_read', { path: 'segreto.txt' }, { type: 'text', text: 'x' }, undefined],
  ])('%s', (_label, tool, args, outcome, expected) => {
    expect(echoContentFor(tool as string, args, outcome as never)).toBe(expected);
  });
});
