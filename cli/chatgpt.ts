import { spawn } from 'node:child_process';
import { verifyInferenceRoute } from '../agent/providers/verify.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { type Config, loadConfig, saveConfig } from '../core/config/config.js';

export const CHATGPT_USAGE =
  'muffin chatgpt login [profile-id | --new] | status | models | use <model> | select <profile-id> | logout';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** No shell and no credential URL in stdout; browser owns account consent. */
export async function openChatGPTBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('Unable to open the sign-in browser.')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Unable to open the sign-in browser.')),
    );
  });
}

export type ChatGPTCommandDeps = {
  out: (line: string) => void;
  connection?: Pick<
    ChatGPTConnection,
    'signIn' | 'session' | 'profiles' | 'select' | 'disconnect' | 'listModels'
  >;
  openBrowser?: (url: string) => Promise<void>;
  verify?: typeof verifyInferenceRoute;
};

export async function cmdChatGPT(
  home: string,
  argv: string[],
  deps: ChatGPTCommandDeps,
): Promise<number> {
  const connection = deps.connection ?? new ChatGPTConnection(home);
  const [command = 'status', value, extra] = argv;
  const out = deps.out;
  if (
    extra !== undefined ||
    !['login', 'status', 'models', 'use', 'select', 'logout'].includes(command)
  ) {
    out(CHATGPT_USAGE);
    return 2;
  }
  try {
    if (command === 'login') {
      if (value?.startsWith('--') && value !== '--new') {
        out(CHATGPT_USAGE);
        return 2;
      }
      out('Continue with ChatGPT — authorize Muffin in your browser.');
      await connection.signIn({
        openBrowser: deps.openBrowser ?? openChatGPTBrowser,
        ...(value === '--new' ? { newProfile: true } : value ? { profileId: value } : {}),
      });
      out('Connection saved. Select and verify a model with `muffin chatgpt use <model>`.');
      out(`Manage plan usage and credit permissions: ${CHATGPT_USAGE_URL}`);
      return 0;
    }
    if (command === 'logout') {
      if (value !== undefined) {
        out(CHATGPT_USAGE);
        return 2;
      }
      const result = await connection.disconnect();
      out(
        result.remoteRevoked
          ? 'Signed out; renewable session revoked.'
          : 'Signed out locally; remote revocation unconfirmed. Disconnect Muffin in ChatGPT Settings.',
      );
      return 0;
    }
    if (command === 'select') {
      if (!value) {
        out(CHATGPT_USAGE);
        return 2;
      }
      await connection.select(value);
      out('Account selected. Verify the pinned model before running Muffin.');
      return 0;
    }
    if (command === 'status') {
      if (value !== undefined) {
        out(CHATGPT_USAGE);
        return 2;
      }
      out(JSON.stringify(await connection.session()));
      for (const profile of await connection.profiles()) out(JSON.stringify(profile));
      out(`Manage usage: ${CHATGPT_USAGE_URL}`);
      return 0;
    }
    if (command === 'models') {
      if (value !== undefined) {
        out(CHATGPT_USAGE);
        return 2;
      }
      for (const model of await connection.listModels())
        out(`${model.slug} — ${model.displayName}`);
      return 0;
    }
    if (!value) {
      out(CHATGPT_USAGE);
      return 2;
    }
    // Read config before inference or replacement; login never overwrites it.
    const current = loadConfig(home);
    const models = await connection.listModels();
    if (!models.some((model) => model.slug === value)) {
      out('Model absent from this account catalog. Configuration preserved.');
      return 1;
    }
    const candidate: Config = {
      ...current,
      provider: {
        kind: 'openai-chatgpt',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: 'secret://chatgpt',
      },
      models: { main: value, light: value },
    };
    const verified = await (deps.verify ?? verifyInferenceRoute)({
      home,
      config: candidate,
      timeoutMs: 60_000,
    });
    if (verified.status !== 'working' || verified.resolvedModel !== value) {
      out(`Model verification failed: ${verified.diagnostic}. Configuration preserved.`);
      return 1;
    }
    // Structured memory has its own explicit low policy, independent of main
    // /think. Verify it before persisting either lane on this plan route.
    const lightVerified = await (deps.verify ?? verifyInferenceRoute)({
      home,
      config: candidate,
      model: value,
      thinking: 'low',
      timeoutMs: 60_000,
    });
    if (lightVerified.status !== 'working' || lightVerified.resolvedModel !== value) {
      out(`Memory lane verification failed: ${lightVerified.diagnostic}. Configuration preserved.`);
      return 1;
    }
    saveConfig(candidate, home);
    out(`Using ChatGPT plan: ${value} for main and light. No model/provider fallback.`);
    out(`Manage plan usage and credit permissions: ${CHATGPT_USAGE_URL}`);
    return 0;
  } catch (error) {
    // Connection and probe errors are curated at their boundaries; never print raw responses.
    out(error instanceof Error ? error.message : 'ChatGPT connection failed.');
    return 1;
  }
}
