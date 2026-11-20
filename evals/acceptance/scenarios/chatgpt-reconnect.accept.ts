import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../../../core/config/config.js';
import type { Thinking } from '../../../core/config/thinking.js';
import { EXIT_STOPPED } from '../../../core/gateway/service.js';
import { seal } from '../../../core/rot/verify.js';
import { type Install, install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';

const CLI = join(import.meta.dirname, '../../../dist/cli/main.js');
const OWNER = 424242;
const REQUEST = 'Tell me what you can do today.';
const RECONNECT = 'muffin chatgpt login';
const CANARY = 'secret-provider-error-canary';

function seedExpiredChatGPTProfile(inst: Install, thinking: Thinking): void {
  const now = Date.now();
  writeFileSync(
    join(inst.home, 'secrets', 'chatgpt'),
    JSON.stringify({
      version: 1,
      hostId: 'urn:uuid:00000000-0000-0000-0000-000000000001',
      activeProfileId: 'acceptance-profile',
      profiles: [
        {
          id: 'acceptance-profile',
          clientId: 'synthetic-client',
          subject: 'synthetic-owner',
          tokens: {
            accessToken: 'synthetic-access-token',
            refreshToken: 'synthetic-refresh-token',
            idToken: 'synthetic-id-token',
            tokenType: 'Bearer',
            scopes: ['chatgpt.tokens.use.direct', 'offline_access', 'resource.invoke'],
            receivedAt: now - 120_000,
            idTokenReceivedAt: now - 120_000,
            expiresAt: now - 60_000,
            pendingIdentity: false,
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const config = loadConfig(inst.home);
  saveConfig(
    {
      ...config,
      provider: {
        kind: 'openai-chatgpt',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'secret://chatgpt',
      },
      models: { ...config.models, main: 'gpt-fixture' },
      thinking,
    },
    inst.home,
  );
}

async function withCompiledGateway(
  inst: Install,
  preload: string,
  run: () => Promise<void>,
): Promise<string> {
  const gateway = spawn(process.execPath, [CLI, 'gateway', 'run'], {
    cwd: inst.workspace,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(inst.workspace, '..'),
      MUFFIN_HOME: inst.home,
      MUFFIN_WORKSPACE: inst.workspace,
      XDG_CONFIG_HOME: inst.xdg,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      MUFFIN_GATEWAY_TICK_MS: '200',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(gateway, 'close');
  let log = '';
  gateway.stdout.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  gateway.stderr.setEncoding('utf8').on('data', (chunk: string) => (log += chunk));
  try {
    await until(() => {
      if (gateway.exitCode !== null) throw new Error(`Gateway exited before ready:\n${log}`);
      return /telegram: connesso/.test(log);
    });
    await run();
  } finally {
    gateway.kill('SIGTERM');
    const timer = setTimeout(() => gateway.kill('SIGKILL'), 3_000);
    await closed.finally(() => clearTimeout(timer));
  }
  expect(gateway.exitCode, log).toBe(EXIT_STOPPED);
  return log;
}

describe('acceptance · #937 · ChatGPT reconnection on Telegram', () => {
  it.each(['low', 'adaptive'] as const)(
    'delivers a reconnect notice with thinking=%s and reads back the same turn after restart',
    async (thinking) => {
      const inst = await install({ main: [] });
      const telegram = await startFakeTelegram();
      try {
        // The scene is text-only. The gateway has no reason to fetch speech weights.
        mkdirSync(join(inst.home, 'models'), { recursive: true });
        writeFileSync(join(inst.home, 'models', 'ggml-base.bin'), 'unused text-only fixture');
        const secret = await inst.muffin(['secret', 'set', 'telegram_token'], '123:synthetic');
        expect(secret.code, secret.err).toBe(0);
        const enable = await inst.muffin([
          'surface',
          'enable',
          'telegram',
          '--api-base',
          telegram.url,
          '--owner',
          String(OWNER),
        ]);
        expect(enable.code, enable.err).toBe(0);
        seedExpiredChatGPTProfile(inst, thinking);
        seal(inst.home, '1', new Date());

        const calls = join(inst.workspace, 'network.log');
        const preload = join(inst.workspace, 'chatgpt-reconnect.mjs');
        writeFileSync(calls, '');
        writeFileSync(
          preload,
          String.raw`
import { appendFileSync } from 'node:fs';
const fetchReal = globalThis.fetch;
const record = (value) => appendFileSync(${JSON.stringify(calls)}, value + '\n');
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === ${JSON.stringify(telegram.url)}) return fetchReal(input, init);
  if (url.href === 'https://auth.openai.com/api/accounts/oauth/token' &&
      init?.method === 'POST' &&
      new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
    record('refresh');
    return Response.json(
      { error: 'invalid_grant', error_description: ${JSON.stringify(CANARY)} },
      { status: 400 },
    );
  }
  if (url.href === 'https://api.openai.com/v1/responses') record('responses');
  throw new Error('Unstubbed network call in ChatGPT reconnect fixture');
};
`,
        );

        const readTurn = () =>
          inst.db((db) =>
            db
              .prepare('SELECT id, status, turn_outcome, delivery FROM turns WHERE input_text = ?')
              .get(REQUEST),
          ) as { id: string; status: string; turn_outcome: string; delivery: string } | undefined;
        const notice = () =>
          telegram.messages().filter((message) => message.text.includes(RECONNECT));
        const firstLog = await withCompiledGateway(inst, preload, async () => {
          telegram.deliver(privateMessage({ id: OWNER }, REQUEST));
          await until(() => readTurn()?.status === 'done');
          expect(readFileSync(calls, 'utf8')).toBe('refresh\n');
          expect(readTurn()).toMatchObject({ status: 'done', turn_outcome: 'error' });
          await until(() => notice().length > 0, 4_000).catch(() => {
            throw new Error(
              `Owner received no ChatGPT reconnect notice (delivery=${readTurn()?.delivery}): ${JSON.stringify(telegram.messages())}`,
            );
          });
          expect(telegram.messages(), 'owner needs a concrete reconnection instruction').toEqual(
            expect.arrayContaining([
              expect.objectContaining({ chatId: OWNER, text: expect.stringContaining(RECONNECT) }),
            ]),
          );
          await until(() => readTurn()?.delivery === 'sent');
          expect(notice()).toHaveLength(1);
          expect(JSON.stringify(telegram.sent())).not.toContain(CANARY);
        });
        expect(firstLog).not.toContain(CANARY);

        const finished = readTurn();
        if (!finished) throw new Error('Telegram turn missing after shutdown');
        await withCompiledGateway(inst, preload, async () => {
          const readback = await inst.muffin(['gateway', 'turn', finished.id]);
          expect(readback.code, readback.err).toBe(0);
          expect(readback.out.trim()).toBe(`turno ${finished.id.slice(0, 12)}: error`);
        });
        expect(readTurn()).toEqual(finished);
        expect(notice()).toHaveLength(1);
        expect(readFileSync(calls, 'utf8')).toBe('refresh\n');
      } finally {
        await telegram.close();
        await inst.cleanup();
      }
    },
    60_000,
  );
});
