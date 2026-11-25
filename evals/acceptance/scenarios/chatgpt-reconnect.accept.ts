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

function seedChatGPTProfile(inst: Install, thinking: Thinking, expired: boolean): void {
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
            expiresAt: now + (expired ? -60_000 : 3_600_000),
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
  crashBeforeDelivery = false,
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
      ...(crashBeforeDelivery ? { MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_DONE_MS: '60000' } : {}),
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
  } catch (error) {
    throw new Error(`${String(error)}\nGateway output:\n${log}`, { cause: error });
  } finally {
    gateway.kill(crashBeforeDelivery ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => gateway.kill('SIGKILL'), 3_000);
    await closed.finally(() => clearTimeout(timer));
  }
  if (crashBeforeDelivery) expect(gateway.signalCode, log).toBe('SIGKILL');
  else expect(gateway.exitCode, log).toBe(EXIT_STOPPED);
  return log;
}

describe('acceptance · #937 · ChatGPT terminal notices on Telegram', () => {
  it.each([
    {
      fault: 'refresh refused',
      thinking: 'low',
      interruption: 'after delivery',
      crashBeforeDelivery: false,
    },
    {
      fault: 'refresh refused',
      thinking: 'adaptive',
      interruption: 'after delivery',
      crashBeforeDelivery: false,
    },
    {
      fault: 'refresh refused',
      thinking: 'low',
      interruption: 'before delivery',
      crashBeforeDelivery: true,
    },
    {
      fault: 'catalog unavailable',
      thinking: 'low',
      interruption: 'before delivery',
      crashBeforeDelivery: true,
    },
    {
      fault: 'effort incompatible',
      thinking: 'low',
      interruption: 'after delivery',
      crashBeforeDelivery: false,
    },
  ] as const)(
    'delivers one notice for $fault with thinking=$thinking and restart $interruption',
    async ({ fault, thinking, crashBeforeDelivery }) => {
      const inst = await install({ main: [] });
      const telegram = await startFakeTelegram();
      try {
        const expired = fault === 'refresh refused';
        const expectedNotice = expired
          ? RECONNECT
          : fault === 'catalog unavailable'
            ? 'Non ho potuto verificare il livello di ragionamento'
            : 'Il modello non può applicare il ragionamento configurato';
        const expectedRequests = expired ? 'refresh\n' : 'models\n';
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
        seedChatGPTProfile(inst, thinking, expired);
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
  if (url.href === 'https://api.openai.com/v1/models') {
    record('models');
    if (${JSON.stringify(fault)} === 'catalog unavailable') {
      return Response.json({ error: ${JSON.stringify(CANARY)} }, { status: 503 });
    }
    return Response.json({ models: [{
      slug: 'gpt-fixture', display_name: 'Fixture', visibility: 'list',
      supported_reasoning_levels: ['high'], default_reasoning_level: 'high',
    }] });
  }
  if (url.href === 'https://api.openai.com/v1/responses') record('responses');
  throw new Error('Unstubbed network call in ChatGPT reconnect fixture');
};
`,
        );

        const readTurns = () =>
          inst.db((db) =>
            db
              .prepare('SELECT id, status, turn_outcome, delivery FROM turns WHERE input_text = ?')
              .all(REQUEST),
          ) as { id: string; status: string; turn_outcome: string; delivery: string }[];
        const readTurn = () => readTurns()[0];
        const notice = () =>
          telegram.messages().filter((message) => message.text.includes(expectedNotice));
        const verifyDelivery = async () => {
          await until(() => notice().length > 0, 4_000).catch(() => {
            throw new Error(
              `Owner received no ChatGPT terminal notice (delivery=${readTurn()?.delivery}): ${JSON.stringify(telegram.messages())}`,
            );
          });
          expect(notice()).toEqual([
            expect.objectContaining({
              chatId: OWNER,
              text: expect.stringContaining(expectedNotice),
            }),
          ]);
          if (!expired) expect(notice()[0]?.text).toContain('/think');
          await until(() => readTurn()?.delivery === 'sent');
          expect(JSON.stringify(telegram.sent())).not.toContain(CANARY);
        };
        const firstLog = await withCompiledGateway(
          inst,
          preload,
          async () => {
            telegram.deliver(privateMessage({ id: OWNER }, REQUEST));
            await until(() => readTurn()?.status === 'done');
            expect(readFileSync(calls, 'utf8')).toBe(expectedRequests);
            expect(readTurn()).toMatchObject({ status: 'done', turn_outcome: 'error' });
            if (crashBeforeDelivery) {
              // Cut the process while the committed result is waiting for its first send.
              expect(readTurn()?.delivery).toBe('pending');
              expect(telegram.messages()).toHaveLength(0);
            } else {
              await verifyDelivery();
            }
          },
          crashBeforeDelivery,
        );
        expect(firstLog).not.toContain(CANARY);

        const finished = readTurn();
        if (!finished) throw new Error('Telegram turn missing after shutdown');
        const readBack = async () => {
          const readback = await inst.muffin(['gateway', 'turn', finished.id]);
          expect(readback.code, readback.err).toBe(0);
          expect(readback.out.trim()).toBe(`turno ${finished.id.slice(0, 12)}: error`);
        };
        const restartedLog = await withCompiledGateway(inst, preload, async () => {
          if (crashBeforeDelivery) await verifyDelivery();
          await readBack();
        });
        expect(restartedLog).not.toContain(CANARY);
        if (crashBeforeDelivery) await withCompiledGateway(inst, preload, readBack);
        expect(readTurns()).toEqual([{ ...finished, delivery: 'sent' }]);
        expect(notice()).toHaveLength(1);
        expect(readFileSync(calls, 'utf8')).toBe(expectedRequests);
        expect(loadConfig(inst.home).thinking).toBe(thinking);
      } finally {
        await telegram.close();
        await inst.cleanup();
      }
    },
    120_000,
  );
});
