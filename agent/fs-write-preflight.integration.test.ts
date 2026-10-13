import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { runTurn } from './loop.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private index = 0;

  constructor(private readonly answers: ChatResult[]) {}

  async chat(_call: ChatCall): Promise<ChatResult> {
    const answer = this.answers[this.index++];
    if (answer === undefined) throw new Error('unexpected provider call');
    return answer;
  }
}

function toolCall(id: string, path: string, content: string): ChatResult {
  return {
    text: null,
    toolCalls: [{ id, name: 'fs_write', args: { path, content } }],
    stopReason: 'tool_use',
    usage,
    model: 'scripted-test',
  };
}

function finalAnswer(): ChatResult {
  return { text: 'fatto', toolCalls: [], stopReason: 'end', usage, model: 'scripted-test' };
}

type TraceRow = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  status: string;
  error?: string;
  attributes: Record<string, unknown>;
};

function readTraceRows(home: string): TraceRow[] {
  const traceDir = join(home, 'traces');
  return readdirSync(traceDir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => readFileSync(join(traceDir, file), 'utf8').split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceRow);
}

describe('fs_write draft preflight distinguishes outside-scope rejection', () => {
  it('records typed containment rejection before intent while a generic snapshot failure stays generic', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-fs-preflight-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-fs-preflight-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'muffin-fs-preflight-outside-'));
    const outsideSentinel = join(outside, 'sentinel.txt');
    const insideSentinel = join(workspace, 'inside.txt');
    writeFileSync(outsideSentinel, 'OUTSIDE-UNCHANGED');
    writeFileSync(insideSentinel, 'INSIDE-UNCHANGED');
    runInit({ home, apiKey: 'sk-synthetic-never-used' });

    const runtime = buildRuntime(home, workspace);
    const undo = runtime.deps.undo;
    if (!undo) throw new Error('runtime undo recorder is required for this integration test');
    const outsideCallId = 'write-outside-scope';
    const snapshotFailureCallId = 'write-snapshot-failure';
    const undoTake = vi.spyOn(undo, 'take').mockImplementation(() => {
      throw new Error('synthetic undo snapshot unavailable');
    });
    const provider = new Scripted([
      toolCall(outsideCallId, outsideSentinel, 'OVERWRITTEN'),
      finalAnswer(),
      toolCall(snapshotFailureCallId, 'inside.txt', 'OVERWRITTEN'),
      finalAnswer(),
    ]);
    runtime.deps.provider = provider;
    runtime.deps.prepareTurn = () => {
      runtime.deps.provider = provider;
    };

    try {
      await runTurn(runtime.deps, {
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('outside-scope-preflight'),
        text: 'scrivi nel file richiesto',
      });
      await runTurn(runtime.deps, {
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('snapshot-failure-preflight'),
        text: 'scrivi nel file richiesto',
      });

      const rows = readTraceRows(home);
      const toolSpan = (callId: string) =>
        rows.find(
          (row) =>
            row.name === 'muffin.tool_call' && row.attributes['gen_ai.tool.call.id'] === callId,
        );
      const outsideSpan = toolSpan(outsideCallId);
      expect(outsideSpan).toMatchObject({ status: 'error', error: 'draft_snapshot_failed' });
      expect(outsideSpan?.attributes['muffin.effect.preflight_rejection']).toBe('outside_scope');
      const outsideDecision = rows.find(
        (row) => row.name === 'muffin.policy_decision' && row.parentSpanId === outsideSpan?.spanId,
      );
      expect(outsideDecision?.attributes['muffin.policy.effect']).toBe('draft');

      const snapshotFailureSpan = toolSpan(snapshotFailureCallId);
      expect(snapshotFailureSpan).toMatchObject({
        status: 'error',
        error: 'draft_snapshot_failed',
      });
      expect(snapshotFailureSpan?.attributes).not.toHaveProperty(
        'muffin.effect.preflight_rejection',
      );
      const snapshotDecision = rows.find(
        (row) =>
          row.name === 'muffin.policy_decision' && row.parentSpanId === snapshotFailureSpan?.spanId,
      );
      expect(snapshotDecision?.attributes['muffin.policy.effect']).toBe('draft');
      expect(undoTake).toHaveBeenCalledTimes(1);

      const intents = runtime.db
        .prepare('SELECT call_id FROM turn_tool_calls WHERE call_id IN (?, ?)')
        .all(outsideCallId, snapshotFailureCallId) as Array<{ call_id: string }>;
      expect(intents).toEqual([]);
      expect(readFileSync(outsideSentinel, 'utf8')).toBe('OUTSIDE-UNCHANGED');
      expect(readFileSync(insideSentinel, 'utf8')).toBe('INSIDE-UNCHANGED');
      expect(existsSync(outsideSentinel)).toBe(true);
    } finally {
      undoTake.mockRestore();
      runtime.close();
    }
  });
});
