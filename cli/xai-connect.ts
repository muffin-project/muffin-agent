import { createInterface } from 'node:readline';
import {
  beginLocalXaiOAuth,
  exchangeXaiAuthorizationCode,
  pollXaiDeviceToken,
  requestXaiDeviceAuthorization,
  type XaiLoginMethod,
  type XaiTokenResponse,
} from '../core/config/xai-oauth.js';
import { openConsentBrowser } from './browser.js';

export type XaiAuthMode = 'browser' | 'code' | 'device' | 'unavailable';

/**
 * Browser loopback on a local terminal; device code over SSH (nothing to paste
 * back, no tunnel); no login on a pipe. An explicit flag always wins on a TTY.
 */
export function xaiAuthMode(input: {
  explicit?: 'browser' | 'code' | 'device' | undefined;
  ssh: boolean;
  stdinIsTTY: boolean;
}): XaiAuthMode {
  if (!input.stdinIsTTY) return 'unavailable';
  if (input.explicit) return input.explicit;
  return input.ssh ? 'device' : 'browser';
}

/** A line from the terminal that the caller can withdraw when the browser wins the race. */
export type AbortablePrompt = (
  question: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

export const terminalPrompt: AbortablePrompt = (question, signal) =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY || signal.aborted) return resolve(undefined);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const done = (value: string | undefined) => {
      signal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => done(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    rl.on('close', () => resolve(undefined));
    rl.question(question, (answer) => done(answer.trim()));
  });

export type ObtainXaiDeps = {
  mode: 'browser' | 'code' | 'device';
  out: (line: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  prompt?: AbortablePrompt;
  beginLocal?: typeof beginLocalXaiOAuth;
  exchange?: typeof exchangeXaiAuthorizationCode;
  requestDevice?: typeof requestXaiDeviceAuthorization;
  pollDevice?: typeof pollXaiDeviceToken;
};

/**
 * Runs the login and returns the token set; the caller stores it. Nothing
 * secret (verifier, code, tokens) is ever passed to `out`.
 */
export async function obtainXaiAuthorization(
  deps: ObtainXaiDeps,
): Promise<{ token: XaiTokenResponse; method: XaiLoginMethod }> {
  if (deps.mode === 'device') {
    const device = await (deps.requestDevice ?? requestXaiDeviceAuthorization)();
    deps.out('Open this address on any device, sign in to xAI and approve Muffin:');
    deps.out(device.verificationUriComplete ?? device.verificationUri);
    deps.out(`Code: ${device.userCode}`);
    deps.out('Waiting for approval…');
    const token = await (deps.pollDevice ?? pollXaiDeviceToken)(device);
    return { token, method: 'oauth-device' };
  }

  const session = await (deps.beginLocal ?? beginLocalXaiOAuth)();
  const prompt = deps.prompt ?? terminalPrompt;
  const stopPrompt = new AbortController();
  try {
    deps.out('Authorize Muffin with your xAI account. Tokens are never printed.');
    deps.out(session.authorizeUrl);
    if (deps.mode === 'browser') {
      try {
        await (deps.openBrowser ?? openConsentBrowser)(session.authorizeUrl);
      } catch {
        deps.out('Could not open a browser. Open the address above.');
      }
    }
    deps.out(
      deps.mode === 'browser'
        ? 'If the browser cannot reach this machine, paste the address it lands on here.'
        : 'After approving, the browser lands on a 127.0.0.1 address that may not load: copy that whole address and paste it here.',
    );
    // Loopback and paste race; whichever delivers a valid code first wins.
    void (async () => {
      for (;;) {
        const pasted = await prompt('Callback URL or code: ', stopPrompt.signal);
        if (pasted === undefined) {
          if (deps.mode === 'code' && !stopPrompt.signal.aborted) {
            await session.close();
          }
          return;
        }
        if (pasted === '') continue;
        try {
          session.submitPasted(pasted);
          return;
        } catch (error) {
          deps.out(error instanceof Error ? error.message : 'xAI authorization code is invalid');
        }
      }
    })();
    const code = await session.code;
    stopPrompt.abort();
    const token = await (deps.exchange ?? exchangeXaiAuthorizationCode)({
      code,
      verifier: session.verifier,
      redirectUri: session.redirectUri,
    });
    return { token, method: 'oauth-pkce' };
  } finally {
    stopPrompt.abort();
    await session.close();
  }
}
