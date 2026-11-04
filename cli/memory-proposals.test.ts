/**
 * `muffin memory proposals` — the owner reads back what was staged and what
 * became of it.
 *
 * Recording is only half of ADR-0051's durability promise: a proposal nobody
 * can read back is a write to a register with no reader — this repo's most
 * familiar failure shape. These tests prove the read side reaches the rows
 * the write side staged, through the real binary path (`paths(home).db`).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { proposeMemoryRecord } from '../core/memory/proposals.js';
import { MemoryStore } from '../core/memory/store.js';
import { cmdMemoryProposals } from './memory.js';

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

/** A home holding one pending and one accepted proposal. */
function homeWithProposals(): { home: string; pending: number; accepted: number } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-proposals-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  const ep = store.addEpisode({
    tenantId: 'host',
    connector: 'cli',
    threadKey: 't',
    role: 'user',
    kind: 'message',
    content: 'ricorda che il mio commercialista è Mario',
    trustTier: 0,
    createdAt: '2026-08-04T11:00:00Z',
  });
  const pending = proposeMemoryRecord(store, {
    tenantId: 'host',
    subject: 'owner',
    predicate: 'accountant',
    object: 'Mario',
    producer: 'owner-stated',
    sourceEpisodeIds: [ep],
    content: 'ricorda che il mio commercialista è Mario',
    confidence: 0.95,
  }).id;
  const accepted = proposeMemoryRecord(store, {
    tenantId: 'host',
    subject: 'owner',
    predicate: 'city',
    object: 'Cagliari',
    producer: 'agent-inference',
    sourceEpisodeIds: [ep],
    content: 'inferisco che viva a Cagliari',
    confidence: 0.7,
  }).id;
  store.resolveProposal('host', accepted, {
    status: 'accepted',
    factIds: [7],
    detail: 'nessuna credenza esistente: inserita.',
    decidedAt: '2026-08-04T12:00:00Z',
  });
  db.close();
  return { home, pending, accepted };
}

describe('muffin memory proposals', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says the register is empty when nothing was ever staged', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-proposals-empty-'));
    new MemoryStore(new DatabaseCtor(paths(home).db)).pendingProposals('host');
    const { out } = capture();
    expect(cmdMemoryProposals(home)).toBe(0);
    expect(out.join('')).toContain('nessuna proposta');
  });

  it('reads back producer, evidence, status and outcome for every proposal', () => {
    const { home, pending, accepted } = homeWithProposals();
    const { out } = capture();
    expect(cmdMemoryProposals(home)).toBe(0);
    const text = out.join('');
    // The pending one: who staged it, from which evidence, and that it waits.
    expect(text).toContain(`[proposta #${pending}] pending`);
    expect(text).toContain('owner-stated');
    expect(text).toContain('in attesa di riconciliazione');
    // The accepted one: its outcome fact and the decision behind it.
    expect(text).toContain(`[proposta #${accepted}] accepted`);
    expect(text).toContain('agent-inference');
    expect(text).toContain('fatti #7');
    // Provenance on both: tier and origin travel to the read side.
    expect(text).toContain('tier 0');
  });

  it('--status filters to the proposals asked for', () => {
    const { home, pending, accepted } = homeWithProposals();
    const { out } = capture();
    expect(cmdMemoryProposals(home, { status: 'pending' })).toBe(0);
    const text = out.join('');
    expect(text).toContain(`[proposta #${pending}]`);
    expect(text).not.toContain(`[proposta #${accepted}]`);
  });
});
