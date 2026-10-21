import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELIVERED, notDelivered, type DeliveryOutcome, type FileSpec } from '../../core/surface/types.js';
import { toolContext } from '../fixtures/tool-context.js';
import type { FsScope } from './fs.js';
import { makeSendFileTool } from './deliver.js';

/**
 * `ToolContext` for this file's one variable — `replyChannel` — over the
 * fixture's stable defaults for everything `send_file` does not touch
 * (`turnId`, `sessionId`, `taint`, `suspend`).
 */
const ctx = (replyChannel: string | null) => toolContext({ replyChannel });

/**
 * `send_file` — the model-facing caller B14 was missing.
 *
 * The property under test is the one the module docstring names: a failed
 * delivery must never read as "inviato", and the channel a file goes to must
 * be the *turn's* channel (`ctx.replyChannel`), never something the tool
 * invents or ignores. Both are wiring properties, not logic properties — the
 * kind PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate asks to be proven by a call that fails without the seam,
 * not just by a call that succeeds with it.
 */

function harness(over: { deliverFile?: (channel: string, file: FileSpec) => Promise<DeliveryOutcome> } = {}) {
  // Two roots, as production has had since G4: the project the agent writes
  // into (`root`) and the vault an owner's attachment lands in (`vault`).
  const root = mkdtempSync(join(tmpdir(), 'muffin-send-file-project-'));
  // Named `vault` on purpose: production's vault root is `<home>/vault`, and
  // the double-prefix bug is exactly a model writing `vault/<path>`.
  const vault = join(mkdtempSync(join(tmpdir(), 'muffin-send-file-')), 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(root, 'report.pdf'), 'contenuto finto');
  const projectScope: FsScope = { root, denyWrite: [], denyRead: [] };
  const vaultScope: FsScope = { root: vault, denyWrite: [], denyRead: [] };
  const calls: { channel: string; file: FileSpec }[] = [];
  const deliverFile =
    over.deliverFile ??
    (async (channel: string, file: FileSpec) => {
      calls.push({ channel, file });
      return DELIVERED;
    });
  const tool = makeSendFileTool({ scopes: [projectScope, vaultScope], deliverFile });
  return { tool, calls, root, vault };
}

describe('send_file', () => {
  it('routes to the exact channel the turn arrived on, not a fixed or guessed one', async () => {
    const h = harness();
    await h.tool.handler({ path: 'report.pdf' }, ctx('telegram:555'));
    await h.tool.handler({ path: 'report.pdf' }, ctx('discord:777'));

    expect(h.calls.map((c) => c.channel)).toEqual(['telegram:555', 'discord:777']);
  });

  it('sends the resolved absolute path and the plain filename, never the raw model-supplied string as the filename', async () => {
    const h = harness();
    await h.tool.handler({ path: 'report.pdf' }, ctx('cli'));

    // Compared against the resolved realpath, not the raw mkdtempSync path:
    // `resolveInScope` follows symlinks on purpose (`fs.ts`'s containment
    // depends on it), and on macOS `$TMPDIR` itself is a symlink into
    // `/private`.
    expect(h.calls[0]?.file.absolutePath).toBe(join(realpathSync(h.root), 'report.pdf'));
    expect(h.calls[0]?.file.filename).toBe('report.pdf');
  });

  it('sends a file the agent just wrote in the project root, not only files already in the vault', async () => {
    const h = harness();
    const outcome = await h.tool.handler({ path: 'report.pdf' }, ctx('cli'));

    expect(outcome.isError).toBeUndefined();
    expect(h.calls[0]?.file.absolutePath).toBe(join(realpathSync(h.root), 'report.pdf'));
  });

  it('still sends a file that lives in the vault, the owner-attachment case B14 was built for', async () => {
    const h = harness();
    writeFileSync(join(h.vault, 'ricevuto.txt'), 'allegato dell owner');

    const outcome = await h.tool.handler({ path: 'ricevuto.txt' }, ctx('telegram:555'));

    expect(outcome.isError).toBeUndefined();
    expect(h.calls[0]?.file.absolutePath).toBe(join(realpathSync(h.vault), 'ricevuto.txt'));
  });

  it('accepts the leading vault/ a model writes even though the ingest line is already relative to the vault', async () => {
    const h = harness();
    writeFileSync(join(h.vault, 'ingested.txt'), 'allegato con prefisso');

    const outcome = await h.tool.handler({ path: 'vault/ingested.txt' }, ctx('cli'));

    expect(outcome.isError).toBeUndefined();
    expect(h.calls[0]?.file.absolutePath).toBe(join(realpathSync(h.vault), 'ingested.txt'));
  });

  it('refuses with no channel to reach, and does not call deliverFile at all', async () => {
    const h = harness();
    const outcome = await h.tool.handler({ path: 'report.pdf' }, ctx(null));

    expect(outcome.isError).toBe(true);
    expect(outcome.content).not.toMatch(/inviato/); // never claims success
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a path outside the vault scope, and does not call deliverFile at all', async () => {
    const h = harness();
    const outcome = await h.tool.handler({ path: '../../etc/passwd' }, ctx('cli'));

    expect(outcome.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('a failed delivery reads as failed, with the reason, never as success', async () => {
    // The whole point of this slice, applied to attachments the way B8 applied
    // it to text: DeliveryOutcome is a value the tool must pass through
    // honestly, not an outcome it is free to reinterpret.
    const h = harness({ deliverFile: async () => notDelivered('discord ha rifiutato: 413') });
    const outcome = await h.tool.handler({ path: 'report.pdf' }, ctx('discord:1'));

    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain('413');
    expect(outcome.content).not.toMatch(/^inviato/);
  });

  it('a successful delivery says so, naming the file', async () => {
    const h = harness();
    const outcome = await h.tool.handler({ path: 'report.pdf' }, ctx('cli'));

    expect(outcome.isError).toBeUndefined();
    expect(outcome.content).toContain('report.pdf');
  });

  it('rejects malformed arguments before touching the filesystem or the registry', async () => {
    const h = harness();
    const outcome = await h.tool.handler({}, ctx('cli'));

    expect(outcome.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('every outcome states tier 0 — its own words and an echo of the caller-supplied path, never file content', async () => {
    const h = harness();
    const results = await Promise.all([
      h.tool.handler({ path: 'report.pdf' }, ctx('cli')),
      h.tool.handler({}, ctx('cli')),
      h.tool.handler({ path: '../escape' }, ctx('cli')),
    ]);
    for (const r of results) expect(r.tier).toBe(0);
  });
});
