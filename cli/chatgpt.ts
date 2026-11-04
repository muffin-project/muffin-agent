import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import { openChatGPTBrowser } from './chatgpt-browser.js';
import { cmdModel, type ModelDeps } from './model.js';

export const CHATGPT_USAGE =
  'muffin chatgpt login [profile-id | --new] | status | models | use <model> | select <profile-id> | logout';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export type ChatGPTCommandDeps = {
  out: (line: string) => void;
  connection?: Pick<
    ChatGPTConnection,
    'signIn' | 'session' | 'profiles' | 'select' | 'disconnect' | 'listModels'
  >;
  openBrowser?: (url: string) => Promise<void>;
  verify?: ModelDeps['verify'];
};

export async function cmdChatGPT(
  home: string,
  argv: string[],
  deps: ChatGPTCommandDeps,
): Promise<number> {
  const connection = deps.connection ?? new ChatGPTConnection(home);
  const modelDeps: ModelDeps = {
    out: deps.out,
    chatgpt: connection,
    ...(deps.verify === undefined ? {} : { verify: deps.verify }),
  };
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
      return cmdModel(home, ['--list', '--provider', 'chatgpt'], modelDeps);
    }
    if (!value) {
      out(CHATGPT_USAGE);
      return 2;
    }
    // Compatibility alias only: all catalog and persistence behavior belongs
    // to the same lane-aware selector as `muffin model` and `/model`.
    return cmdModel(home, ['main', '--provider', 'chatgpt', value], modelDeps);
  } catch (error) {
    // Connection and probe errors are curated at their boundaries; never print raw responses.
    out(error instanceof Error ? error.message : 'ChatGPT connection failed.');
    return 1;
  }
}
