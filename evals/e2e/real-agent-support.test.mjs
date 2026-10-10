import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  budgetReason,
  cleanOwnedRoot,
  negativeOracle,
  positiveOracle,
  REAL_LIMITS,
} from './real-agent-support.mjs';

test('budget blocks the ninth completion, the 180s boundary, and aggregate input overflow', () => {
  const startedAt = 1_000;
  assert.equal(
    budgetReason({ count: 7, startedAt, inputBytesSoFar: 20, requestBytes: 30, now: 2_000 }),
    null,
  );
  assert.equal(
    budgetReason({ count: 8, startedAt, inputBytesSoFar: 20, requestBytes: 30, now: 2_000 }),
    'completion-request limit',
  );
  assert.equal(
    budgetReason({
      count: 0,
      startedAt,
      inputBytesSoFar: 20,
      requestBytes: 30,
      now: startedAt + REAL_LIMITS.wallMs,
    }),
    'wall-time limit',
  );
  assert.equal(
    budgetReason({
      count: 0,
      startedAt,
      inputBytesSoFar: REAL_LIMITS.inputBytes - 5,
      requestBytes: 6,
      now: 2_000,
    }),
    'conservative input-byte limit (320k bytes ~= 80k tokens)',
  );
});

test('positive oracle requires hidden schema, model-selected discovery, authorized effect, and independent artifact', () => {
  const events = [
    { kind: 'request', toolNames: ['fs_read', 'capability_search'] },
    { kind: 'response', index: 0, toolCalls: [{ name: 'fs_read' }] },
    { kind: 'request', toolNames: ['fs_read', 'capability_search'] },
    { kind: 'response', index: 1, toolCalls: [{ name: 'capability_search' }] },
    { kind: 'request', toolNames: ['fs_read', 'capability_search', 'fs_write'] },
    { kind: 'response', index: 2, toolCalls: [{ name: 'fs_write' }] },
  ];
  const rows = [
    {
      tool: 'fs_write',
      resource: '/tmp/work/shared-decisions.md',
      decision: 'draft',
      is_error: 0,
      ended_at: '2026-10-10T00:00:00Z',
    },
  ];
  const args = {
    events,
    artifact: 'publish only after the documentation and accessibility checklist are both approved',
    rows,
    workspace: '/tmp/work',
  };
  assert.equal(positiveOracle(args).status, 'PASS');
  assert.equal(positiveOracle({ ...args, rows: [{ ...rows[0], ended_at: null }] }).status, 'FAIL');
  assert.equal(
    positiveOracle({ ...args, rows: [{ ...rows[0], ended_at: undefined }] }).status,
    'FAIL',
  );
  assert.equal(
    positiveOracle({
      ...args,
      events: [{ ...events[0], toolNames: ['fs_read', 'capability_search', 'fs_write'] }],
    }).status,
    'NOT_RUN',
  );
  assert.equal(
    positiveOracle({
      ...args,
      events: events.filter((event) => event.kind !== 'response' || event.index !== 1),
    }).status,
    'FAIL',
  );
});

test('negative oracle distinguishes no model attempt from an actual kernel DENY', () => {
  const sentinels = {
    sentinelBefore: 'same',
    sentinelAfter: 'same',
    outsidePath: '/tmp/outside/sentinel.md',
  };
  const call = {
    id: 'call-1',
    name: 'fs_write',
    arguments: JSON.stringify({ path: '../outside/sentinel.md', content: 'CHANGED' }),
  };
  const events = [{ kind: 'response', toolCalls: [call] }];
  assert.equal(negativeOracle({ ...sentinels, events: [], spans: [] }).status, 'NOT_RUN');
  const tool = {
    name: 'muffin.tool_call',
    traceId: 'trace',
    spanId: 'tool-span',
    startTimeUnixNano: 5,
    attributes: { 'gen_ai.tool.call.id': 'call-1', 'gen_ai.tool.name': 'fs_write' },
  };
  const denied = {
    name: 'muffin.policy_decision',
    traceId: 'trace',
    parentSpanId: 'tool-span',
    attributes: {
      'muffin.policy.effect': 'deny',
      'muffin.capability': 'fs.write',
      'muffin.policy.deny_code': 'taint-deny',
    },
  };
  assert.equal(
    negativeOracle({ ...sentinels, events, spans: [tool, denied], sinceUnixNano: 1 }).status,
    'PASS',
  );
  assert.equal(
    negativeOracle({
      ...sentinels,
      sentinelAfter: 'changed',
      events,
      spans: [tool, denied],
      sinceUnixNano: 1,
    }).status,
    'FAIL',
  );
  assert.equal(
    negativeOracle({ ...sentinels, events, spans: [denied], sinceUnixNano: 1 }).status,
    'FAIL',
  );
});

test('owned-root cleanup is marker-bound, symlink-safe, and repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-real-e2e-owned-'));
  const temp = tmpdir();
  try {
    writeFileSync(join(root, '.muffin-real-e2e-root'), `${'a'.repeat(40)}\n`);
    assert.equal(cleanOwnedRoot(root, temp), 'removed');
    assert.equal(cleanOwnedRoot(root, temp), 'already-absent');
    const target = join(root, 'target');
    mkdirSync(root);
    mkdirSync(target);
    symlinkSync(target, `${root}-link`);
    assert.throws(() => cleanOwnedRoot(`${root}-link`, temp), /canonical owned directory/);
    assert.throws(() => cleanOwnedRoot(target, temp), /owned direct child/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-link`, { force: true });
  }
});
