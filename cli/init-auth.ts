import { PROVIDERS } from '../core/config/providers.js';
import {
  obtainOpenRouterAuthorization,
  openRouterAuthMode,
  safeLine,
} from './openrouter-connect.js';
import { promptLine, promptSecret } from './prompt.js';

export type InitCredential =
  | { kind: 'key'; apiKey: string; method: 'oauth-pkce' | 'api-key' }
  | { kind: 'skip' }
  | { kind: 'cancelled' };

const YES = /^(y|yes|s|si|sì)$/i;

/**
 * TTY onboarding choice. Empty Enter is OpenRouter OAuth, not a silent skip.
 * Headless callers never reach this: init reads the key from stdin instead.
 */
export async function acquireInitCredential(deps: {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  stderr: (text: string) => void;
  obtain?: typeof obtainOpenRouterAuthorization;
  promptForSecret?: typeof promptSecret;
  promptForLine?: typeof promptLine;
  ssh?: boolean;
  stdinIsTTY?: boolean;
}): Promise<InitCredential> {
  const ask = deps.promptForLine ?? promptLine;
  const secret = deps.promptForSecret ?? promptSecret;
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  for (;;) {
    const answer = await ask(
      '\nCollega il modello. OAuth è la strada consigliata; la chiave è il ripiego.\n' +
        '  [1] OpenRouter — browser, oppure un codice se sei in SSH\n' +
        '  [2] Incolla una chiave API (OpenRouter o Anthropic)\n' +
        '  [3] Salta per ora\n' +
        '  Piano ChatGPT: muffin chatgpt login\n' +
        '  Anthropic: solo chiave Console/API, nessun login claude.ai\n' +
        'Scelta [1]: ',
      input,
      output,
    );
    // EOF is the old "no answer" path: init continues and records the key as
    // missing. A failed OAuth attempt is the case that stops, below.
    if (answer === undefined) return { kind: 'skip' };
    if (answer === '' || answer === '1') {
      const mode = openRouterAuthMode({
        ssh: deps.ssh ?? false,
        stdinIsTTY: deps.stdinIsTTY ?? input.isTTY === true,
      });
      if (mode === 'unavailable') {
        deps.stderr(
          'OpenRouter OAuth vuole un terminale. In headless: echo -n "$KEY" | muffin init\n',
        );
        return { kind: 'cancelled' };
      }
      try {
        const apiKey = await (deps.obtain ?? obtainOpenRouterAuthorization)({
          mode,
          out: (line) => deps.stderr(`${line}\n`),
        });
        return { kind: 'key', apiKey, method: 'oauth-pkce' };
      } catch (error) {
        deps.stderr(
          `${safeLine(error instanceof Error ? error.message : 'OpenRouter authorization failed')}\n`,
        );
        return { kind: 'cancelled' };
      }
    }
    if (answer === '2') {
      deps.stderr(
        'Incolla una chiave OpenRouter (sk-or-…) o Anthropic (sk-ant-…). ' +
          `OpenRouter: ${PROVIDERS.openrouter.keysUrl}\n`,
      );
      const apiKey = await secret(
        'Chiave API (nascosta — invio vuoto chiede conferma): ',
        input,
        output,
      );
      if (!apiKey) return { kind: 'skip' };
      return { kind: 'key', apiKey, method: 'api-key' };
    }
    if (answer === '3') {
      const confirm = await ask('Saltare il collegamento? [y/N] ', input, output);
      if (confirm === undefined) return { kind: 'skip' };
      if (YES.test(confirm)) return { kind: 'skip' };
      continue;
    }
    deps.stderr('Scegli 1, 2 o 3.\n');
  }
}
