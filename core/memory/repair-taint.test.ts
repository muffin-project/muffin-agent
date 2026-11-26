import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type NewTurn, TurnStore } from '../turns/store.js';
import { applyRepairTaint, formatRepairTaintReport, previewRepairTaint } from './repair-taint.js';
import { MemoryStore } from './store.js';

const NOW = '2026-11-26T21:00:00.000Z';

function counters(): NewTurn['counters'] {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  };
}

function harness() {
  const db = new DatabaseCtor(':memory:');
  const memory = new MemoryStore(db);
  const turns = new TurnStore(db, () => new Date(NOW));
  return { db, memory, turns };
}

function ownerTurn(turns: TurnStore, id: string, taint: 0 | 1 | 2 | 3 = 3, tenant = 'host') {
  turns.create({
    id,
    principal: { kind: 'owner', connector: 'telegram', externalId: '1' },
    tenant,
    surface: 'telegram',
    sessionId: 's1',
    model: 'm',
    messages: [],
    taint,
    counters: counters(),
  });
}

function agentEpisode(
  memory: MemoryStore,
  turnId: string | undefined,
  content: string,
  tier: 0 | 1 | 2 | 3,
  tenant = 'host',
) {
  return memory.addEpisode({
    tenantId: tenant,
    connector: 'telegram',
    threadKey: 's1',
    role: 'agent',
    kind: 'message',
    content,
    trustTier: tier,
    createdAt: NOW,
    ...(turnId === undefined ? {} : { turnId }),
  });
}

describe('repair-taint', () => {
  it('previews only falsely stamped agent episodes from clean owner turns', () => {
    const { db, memory, turns } = harness();
    ownerTurn(turns, 'clean-hello');
    const hello = agentEpisode(memory, 'clean-hello', 'ciao, sono Muffin', 3);

    ownerTurn(turns, 'web-turn');
    turns.startToolCall('web-turn', {
      callId: 'c1',
      tool: 'web_search',
      capability: 'sys.search',
      rerunnable: true,
      args: { query: 'node' },
      effect: { row: 'external', reversible: 'yes', resource: 'web', decision: 'allow' },
    });
    const web = agentEpisode(memory, 'web-turn', "l'ultima LTS è 24", 3);

    ownerTurn(turns, 'group-turn', 2, 'group:telegram:42');
    const group = agentEpisode(memory, 'group-turn', 'ciao al gruppo', 2, 'group:telegram:42');

    const orphan = agentEpisode(memory, undefined, 'vecchia risposta senza turno', 3);
    const already = agentEpisode(memory, 'clean-hello', 'una risposta già pulita', 0);

    memory.addEpisode({
      tenantId: 'host',
      connector: 'telegram',
      threadKey: 's1',
      role: 'user',
      kind: 'message',
      content: 'ciao',
      trustTier: 0,
      createdAt: NOW,
      turnId: 'clean-hello',
    });

    const report = previewRepairTaint(db);
    expect(report.candidates.map((c) => c.episodeId)).toEqual([hello]);
    expect(report.candidates[0]).toMatchObject({ turnId: 'clean-hello', from: 3, to: 0 });
    expect(
      report.skipped.some((s) => s.episodeId === web && s.reason === 'untrusted-ingress-tools'),
    ).toBe(true);
    expect(
      report.skipped.some((s) => s.episodeId === group && s.reason === 'untrusted-channel'),
    ).toBe(true);
    expect(report.skipped.some((s) => s.episodeId === orphan && s.reason === 'no-turn-id')).toBe(
      true,
    );
    expect(
      report.skipped.some((s) => s.episodeId === already && s.reason === 'already-clean'),
    ).toBe(true);
    expect(formatRepairTaintReport(report)).toContain('da ricalcolare 1 episodio agente');
    expect(formatRepairTaintReport(report)).toContain('tool di ingress non fidato');
    db.close();
  });

  it('dry-run does not write, apply backs up and retaints only the candidates', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-repair-taint-'));
    const dbPath = join(home, 'muffin.db');
    const db = new DatabaseCtor(dbPath);
    const memory = new MemoryStore(db);
    const turns = new TurnStore(db, () => new Date(NOW));
    ownerTurn(turns, 'clean-hello');
    const hello = agentEpisode(memory, 'clean-hello', 'ciao', 3);
    ownerTurn(turns, 'web-turn');
    turns.startToolCall('web-turn', {
      callId: 'c1',
      tool: 'http_get',
      capability: 'sys.http',
      rerunnable: true,
      args: { url: 'https://example.com/' },
      effect: {
        row: 'external',
        reversible: 'yes',
        resource: 'https://example.com/',
        decision: 'allow',
      },
    });
    const web = agentEpisode(memory, 'web-turn', 'ho letto la pagina', 3);

    const sessionsDir = join(home, 'sessions');
    mkdirSync(sessionsDir, { mode: 0o700 });
    const sessionFile = join(sessionsDir, 's1.jsonl');
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          role: 'user',
          content: 'ciao',
          surface: 'telegram',
          createdAt: NOW,
          traceId: 'clean-hello',
          tier: 0,
        }),
        JSON.stringify({
          role: 'assistant',
          content: 'ciao',
          surface: 'telegram',
          createdAt: NOW,
          traceId: 'clean-hello',
          tier: 3,
        }),
        JSON.stringify({
          role: 'assistant',
          content: 'pagina',
          surface: 'telegram',
          createdAt: NOW,
          traceId: 'web-turn',
          tier: 3,
        }),
      ].join('\n') + '\n',
    );

    const preview = previewRepairTaint(db, sessionsDir);
    expect(preview.candidates).toHaveLength(1);
    expect(preview.sessionRows).toBe(1);
    expect(
      (db.prepare('SELECT trust_tier AS t FROM episodes WHERE id = ?').get(hello) as { t: number })
        .t,
    ).toBe(3);

    const backupDir = join(home, 'backups');
    const applied = applyRepairTaint(db, {
      backupDir,
      sessionsDir,
      now: new Date(NOW),
    });
    expect(applied.updatedEpisodes).toBe(1);
    expect(applied.updatedSessionRows).toBe(1);
    expect(applied.backupDb).toContain('muffin-repair-taint-');
    expect(
      (db.prepare('SELECT trust_tier AS t FROM episodes WHERE id = ?').get(hello) as { t: number })
        .t,
    ).toBe(0);
    expect(
      (db.prepare('SELECT trust_tier AS t FROM episodes WHERE id = ?').get(web) as { t: number }).t,
    ).toBe(3);

    const session = readFileSync(sessionFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { role: string; traceId: string; tier: number });
    expect(session.find((r) => r.traceId === 'clean-hello' && r.role === 'assistant')?.tier).toBe(
      0,
    );
    expect(session.find((r) => r.traceId === 'web-turn' && r.role === 'assistant')?.tier).toBe(3);
    expect(session.find((r) => r.role === 'user')?.tier).toBe(0);
    db.close();
  });

  it('leaves a clean-owner turn that only used memory_search eligible, and facts untouched', () => {
    const { db, memory, turns } = harness();
    ownerTurn(turns, 'mem-only');
    turns.startToolCall('mem-only', {
      callId: 'c1',
      tool: 'memory_search',
      capability: 'memory.read',
      rerunnable: true,
      args: { query: 'nome' },
      effect: { row: 'context', reversible: 'yes', resource: 'memory', decision: 'allow' },
    });
    const agent = agentEpisode(memory, 'mem-only', 'ti chiami Giusto', 3);
    const userEp = memory.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 's1',
      role: 'user',
      kind: 'message',
      content: 'mi chiamo Giusto',
      trustTier: 0,
      createdAt: NOW,
      turnId: 'mem-only',
    });
    // A fact extracted from the user episode must stay at its own tier.
    const subject = memory.upsertEntity('host', 'Giusto', 'person', NOW);
    memory.addFact({
      tenantId: 'host',
      subjectId: subject,
      predicate: 'name',
      objectValue: 'Giusto',
      recordedAt: NOW,
      episodeId: userEp,
      trustTier: 0,
      confidence: 1,
      extractionV: 1,
    });

    const report = previewRepairTaint(db);
    expect(report.candidates.map((c) => c.episodeId)).toEqual([agent]);
    db.close();
  });
});
