import type { VerificationResult, verifyInferenceRoute } from '../agent/providers/verify.js';
import { verifyInferenceRoute as verifyRoute } from '../agent/providers/verify.js';
import {
  type KeyAuthMethod,
  type KeyAuthProfile,
  managedProfileId,
  rememberKeyProfile,
} from '../core/config/auth-profile.js';
import { type InferenceLane, loadConfig, writeAuthoritativeSecret } from '../core/config/config.js';
import {
  beginHeadlessOpenRouterOAuth,
  beginLocalOpenRouterOAuth,
  exchangeOpenRouterAuthorizationCode,
} from '../core/config/openrouter-oauth.js';
import { openConsentBrowser } from './browser.js';
import { promptLine, promptSecret } from './prompt.js';

const CODE_MAX = 8_192;

export type OpenRouterAuthMode = 'browser' | 'code' | 'unavailable';

/** Browser on a local TTY; pasted code on SSH; no OAuth on a pipe. */
export function openRouterAuthMode(input: {
  explicit?: 'browser' | 'code' | undefined;
  ssh: boolean;
  stdinIsTTY: boolean;
}): OpenRouterAuthMode {
  if (!input.stdinIsTTY) return 'unavailable';
  if (input.explicit) return input.explicit;
  if (input.ssh) return 'code';
  return 'browser';
}

export type ObtainOpenRouterDeps = {
  mode: 'browser' | 'code';
  out: (line: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  promptCode?: (question: string) => Promise<string | undefined>;
  beginLocal?: typeof beginLocalOpenRouterOAuth;
  beginHeadless?: typeof beginHeadlessOpenRouterOAuth;
  exchange?: typeof exchangeOpenRouterAuthorizationCode;
  keyLabel?: string;
};

/**
 * Runs PKCE and returns the user-scoped key. The caller stores it.
 * The verifier and the key are never written to `out`.
 */
export async function obtainOpenRouterAuthorization(deps: ObtainOpenRouterDeps): Promise<string> {
  const exchange = deps.exchange ?? exchangeOpenRouterAuthorizationCode;
  const label = deps.keyLabel ?? 'Muffin';
  if (deps.mode === 'code') {
    const session = (deps.beginHeadless ?? beginHeadlessOpenRouterOAuth)(label);
    deps.out('Open this address and paste the one-time code OpenRouter shows.');
    deps.out(session.authorizeUrl);
    const pasted = (await (deps.promptCode ?? promptLine)('OpenRouter code: '))?.trim();
    if (!pasted) throw new Error('OpenRouter authorization cancelled');
    assertCode(pasted);
    return exchange({ code: pasted, verifier: session.verifier });
  }

  const session = await (deps.beginLocal ?? beginLocalOpenRouterOAuth)({ keyLabel: label });
  try {
    deps.out('Authorize OpenRouter in your browser. The API key is never printed.');
    deps.out(session.authorizeUrl);
    try {
      await (deps.openBrowser ?? openConsentBrowser)(session.authorizeUrl);
    } catch {
      deps.out('Could not open a browser. Open the address above on this machine.');
    }
    const code = (await session.code).trim();
    assertCode(code);
    return exchange({ code, verifier: session.verifier });
  } finally {
    await session.close();
  }
}

function assertCode(code: string): void {
  if (code.length === 0 || code.length > CODE_MAX || /[\r\n]/.test(code)) {
    throw new Error('OpenRouter authorization code is invalid');
  }
}

export async function ensureOpenRouterSecret(input: {
  home: string;
  secretName: string;
  out: (line: string) => void;
  ask: (question: string) => Promise<string | undefined>;
  promptKey?: (question: string) => Promise<string | undefined>;
  obtain?: typeof obtainOpenRouterAuthorization;
  ssh?: boolean;
  stdinIsTTY?: boolean;
  mode?: 'browser' | 'code' | undefined;
}): Promise<KeyAuthMethod | 'cancelled'> {
  const obtain = input.obtain ?? obtainOpenRouterAuthorization;
  for (;;) {
    const answer = await input.ask(
      'OpenRouter: [1] autorizza nel browser o con un codice (consigliato) [2] incolla una chiave API\nScelta [1]: ',
    );
    if (answer === undefined) return 'cancelled';
    if (answer === '' || answer === '1') {
      const mode = openRouterAuthMode({
        explicit: input.mode,
        ssh: input.ssh ?? false,
        stdinIsTTY: input.stdinIsTTY ?? true,
      });
      if (mode === 'unavailable') {
        input.out('OpenRouter OAuth vuole un terminale. In headless: echo -n "$KEY" | muffin init');
        return 'cancelled';
      }
      try {
        const key = await obtain({ mode, out: input.out });
        storeOpenRouterKey(input.home, input.secretName, key, 'oauth-pkce');
        return 'oauth-pkce';
      } catch (error) {
        input.out(
          safeLine(error instanceof Error ? error.message : 'OpenRouter authorization failed'),
        );
        return 'cancelled';
      }
    }
    if (answer === '2') {
      const key = await (input.promptKey ?? promptSecret)(
        'Chiave OpenRouter (nascosta — invio vuoto chiede conferma): ',
      );
      if (!key) return 'cancelled';
      storeOpenRouterKey(input.home, input.secretName, key, 'api-key');
      return 'api-key';
    }
    input.out('Scegli 1 o 2.');
  }
}

export function storeOpenRouterKey(
  home: string,
  secretName: string,
  key: string,
  method: KeyAuthMethod,
): void {
  writeAuthoritativeSecret(secretName, key, home);
  const id = managedProfileId('openrouter', secretName);
  if (id === null) return;
  const profile: KeyAuthProfile = { id, provider: 'openrouter', method, secretName };
  rememberKeyProfile(home, profile);
}

export async function probeSavedRoute(
  home: string,
  out: (line: string) => void,
  options: {
    verify?: typeof verifyInferenceRoute;
    lane?: InferenceLane;
    model?: string;
    style?: 'it' | 'en';
    /** Appended when the probed model is not the configured one. */
    extra?: string;
  } = {},
): Promise<number> {
  const verify = options.verify ?? verifyRoute;
  const lane = options.lane ?? 'main';
  const style = options.style ?? 'it';
  let result: VerificationResult;
  try {
    const config = loadConfig(home);
    result = await verify({
      home,
      config,
      lane,
      model: options.model ?? config.models[lane],
      timeoutMs: 60_000,
    });
  } catch (error) {
    const detail = safeLine(error instanceof Error ? error.message : 'probe failed');
    out(
      style === 'en'
        ? `Configured, not working — ${detail}`
        : `! inferenza    configurato, non funzionante — ${detail}`,
    );
    return 1;
  }
  const text = safeLine(result.diagnostic);
  const remedy = result.remedy ? ` — ${safeLine(result.remedy)}` : '';
  const extra = options.extra ?? '';
  if (result.status === 'working' && extra === '') {
    out(style === 'en' ? `Probe: working — ${text}.` : `✓ inferenza    working — ${text}`);
    return 0;
  }
  if (result.status === 'working') {
    out(`Configured, not the saved route — ${extra}`);
    return 1;
  }
  out(
    style === 'en'
      ? `Configured, not working — ${text}${remedy}${extra === '' ? '' : ` ${extra}`}`
      : `! inferenza    configurato, non funzionante — ${text}${remedy}`,
  );
  return 1;
}

export function safeLine(text: string): string {
  if (/sk-or-|sk-ant-|code_verifier|verifier/i.test(text)) return 'probe failed';
  return text;
}
