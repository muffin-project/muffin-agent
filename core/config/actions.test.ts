import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runInit } from '../../cli/init.js';
import {
  type ActionSpec,
  listActions,
  ownerCommandAuthorization,
  paramsDigest,
  plan,
  read,
  registerAction,
  unregisterAction,
} from './actions.js';
import { issueSettingsApproval } from './actions-approval.js';
import { commit } from './actions-commit.js';
import type { ActionContext, ChangePlan, PlanOutcome } from './actions-types.js';
import { loadConfig } from './config.js';
import { setConfigKnob } from './settings.js';

const homes: string[] = [];
afterEach(() => {
  unregisterAction('test.widen');
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-actions-'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  homes.push(dir);
  return dir;
}

const widenParams = z.object({ amount: z.number() });

function widenFixture(): ActionSpec<z.infer<typeof widenParams>> {
  const marker = (ctx: ActionContext) => join(ctx.home, 'widen-fixture.txt');
  return {
    id: 'test.widen',
    section: 'budget',
    label: 'fixture di allargamento',
    help: 'solo per il test del cancello',
    category: 'widen',
    params: widenParams,
    store: 'none',
    plan(params, ctx): PlanOutcome {
      const after = 'yes';
      const before = existsSync(marker(ctx)) ? 'yes' : 'no';
      const plan: ChangePlan = {
        actionId: 'test.widen',
        category: 'widen',
        paramsCanonical: params,
        paramsDigest: paramsDigest('test.widen', params),
        before,
        after,
        files: [marker(ctx)],
        impact: 'allarga di proposito, solo in test',
        restart: 'none',
        ...(before === after ? { unchanged: true as const } : {}),
      };
      return { ok: true, plan };
    },
    write(_plan, ctx) {
      writeFileSync(marker(ctx), 'widened\n', { encoding: 'utf8', mode: 0o600 });
    },
    readAfter: (ctx) => (existsSync(marker(ctx)) ? 'yes' : 'no'),
  };
}

describe('registro unico — catalogo e lettura', () => {
  it('espone le azioni iniziali (config.set, embeddings.off, embeddings.set)', () => {
    const ids = listActions()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(['config.set', 'embeddings.off', 'embeddings.set']);
  });

  it('read di embeddings.off riporta lo stato senza scrivere', () => {
    const dir = home();
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    const shown = read('embeddings.off', { home: dir, source: 'cli' });
    expect(shown.ok).toBe(true);
    if (shown.ok) expect(shown.displayed.value).toContain('ollama');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
  });
});

describe('registro unico — plan / commit su config.set', () => {
  it('setConfigKnob passa dal registro, fa backup e rilegge il valore scritto', () => {
    const dir = home();
    const outcome = setConfigKnob(dir, 'traces.retentionDays', '45');
    expect(outcome).toMatchObject({
      ok: true,
      key: 'traces.retentionDays',
      previous: '90',
      next: '45',
    });
    expect(loadConfig(dir).traces.retentionDays).toBe(45);
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups.some((name) => name.startsWith('config.json-'))).toBe(true);
  });

  it('un piano con digest diverso non scrive', () => {
    const dir = home();
    const ctx = { home: dir, source: 'cli' as const };
    const planned = plan('config.set', { key: 'traces.retentionDays', value: '30' }, ctx);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const tampered = { ...planned.plan, paramsDigest: '0'.repeat(64) };
    const written = commit(tampered, ctx, ownerCommandAuthorization(tampered, 'cli'));
    expect(written.ok).toBe(false);
    expect(loadConfig(dir).traces.retentionDays).toBe(90);
  });
});

describe('registro unico — cancello widen (ADR-0114 / ADR-0058)', () => {
  it('un widen senza conferma non scrive; owner-command e --yes non bastano', () => {
    const dir = home();
    registerAction(widenFixture());
    const ctx = { home: dir, source: 'cli' as const };
    const planned = plan('test.widen', { amount: 10 }, ctx);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const noAuth = commit(planned.plan, ctx, ownerCommandAuthorization(planned.plan, 'cli'));
    expect(noAuth.ok).toBe(false);
    if (!noAuth.ok) {
      expect(noAuth.reason).toContain('conferma esplicita monouso');
    }
    expect(existsSync(join(dir, 'widen-fixture.txt'))).toBe(false);

    // A `--yes` / `--force` flag is not a valid authorization. Even if a caller
    // smuggles one onto the object, commit looks only at kind + binding.
    const withForce = {
      ...ownerCommandAuthorization(planned.plan, 'cli'),
      force: true,
      yes: true,
    };
    const forced = commit(planned.plan, ctx, withForce);
    expect(forced.ok).toBe(false);
    expect(existsSync(join(dir, 'widen-fixture.txt'))).toBe(false);
  });

  it('un token monouso legato a actionId + digest consente la scrittura una volta sola', () => {
    const dir = home();
    registerAction(widenFixture());
    const ctx = { home: dir, source: 'telegram' as const };
    const planned = plan('test.widen', { amount: 10 }, ctx);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;

    const issued = issueSettingsApproval(dir, planned.plan, {
      principal: 'owner',
      surface: 'telegram',
    });
    const first = commit(planned.plan, ctx, {
      kind: 'single-use',
      token: issued.token,
      actionId: planned.plan.actionId,
      paramsDigest: planned.plan.paramsDigest,
      principal: 'owner',
      surface: 'telegram',
    });
    expect(first.ok).toBe(true);
    expect(readFileSync(join(dir, 'widen-fixture.txt'), 'utf8')).toBe('widened\n');

    const second = commit(planned.plan, ctx, {
      kind: 'single-use',
      token: issued.token,
      actionId: planned.plan.actionId,
      paramsDigest: planned.plan.paramsDigest,
      principal: 'owner',
      surface: 'telegram',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('già usata');
  });

  it('un token legato a parametri diversi non scrive', () => {
    const dir = home();
    registerAction(widenFixture());
    const ctx = { home: dir, source: 'cli' as const };
    const planned = plan('test.widen', { amount: 10 }, ctx);
    const other = plan('test.widen', { amount: 99 }, ctx);
    expect(planned.ok && other.ok).toBe(true);
    if (!planned.ok || !other.ok) return;

    const issued = issueSettingsApproval(dir, planned.plan, {
      principal: 'owner',
      surface: 'cli',
    });
    const written = commit(other.plan, ctx, {
      kind: 'single-use',
      token: issued.token,
      actionId: other.plan.actionId,
      paramsDigest: other.plan.paramsDigest,
      principal: 'owner',
      surface: 'cli',
    });
    expect(written.ok).toBe(false);
    expect(existsSync(join(dir, 'widen-fixture.txt'))).toBe(false);
  });

  it("owner-command da conversation è rifiutato anche su un'azione che lo ammette", () => {
    const dir = home();
    const ctx = { home: dir, source: 'conversation' as const };
    const planned = plan('embeddings.off', {}, ctx);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const written = commit(
      planned.plan,
      ctx,
      ownerCommandAuthorization(planned.plan, 'conversation'),
    );
    expect(written.ok).toBe(false);
    expect(loadConfig(dir).embedder?.enabled).not.toBe(false);
  });
});
