import { describe, expect, it, vi } from 'vitest';
import type { LocalXaiOAuthSession } from '../core/config/xai-oauth.js';
import { obtainXaiAuthorization, xaiAuthMode } from './xai-connect.js';

const TOKEN = { accessToken: 'xai-access-canary', refreshToken: 'xai-refresh-canary' };

function fakeSession(): LocalXaiOAuthSession & {
  deliver: (code: string) => void;
  closed: () => boolean;
} {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let closed = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => undefined);
  return {
    authorizeUrl: 'https://auth.x.ai/oauth2/authorize?state=s1',
    redirectUri: 'http://127.0.0.1:5555/callback',
    verifier: 'verifier-canary',
    state: 's1',
    code,
    submitPasted: (input: string) => {
      if (!input.includes('state=s1'))
        throw new Error('xAI authorization state did not match. Retry the login.');
      resolveCode(new URL(input).searchParams.get('code') ?? '');
    },
    close: async () => {
      closed = true;
      rejectCode(new Error('cancelled'));
    },
    deliver: (value: string) => resolveCode(value),
    closed: () => closed,
  };
}

describe('xaiAuthMode', () => {
  it('uses the browser locally, the device code over SSH, and nothing on a pipe', () => {
    expect(xaiAuthMode({ ssh: false, stdinIsTTY: true })).toBe('browser');
    expect(xaiAuthMode({ ssh: true, stdinIsTTY: true })).toBe('device');
    expect(xaiAuthMode({ explicit: 'code', ssh: true, stdinIsTTY: true })).toBe('code');
    expect(xaiAuthMode({ explicit: 'device', ssh: false, stdinIsTTY: false })).toBe('unavailable');
  });
});

describe('obtainXaiAuthorization', () => {
  it('browser: the loopback wins, the paste prompt is withdrawn, the code is exchanged', async () => {
    const session = fakeSession();
    const out: string[] = [];
    let promptSignal: AbortSignal | undefined;
    const exchange = vi.fn(async () => TOKEN);
    const pending = obtainXaiAuthorization({
      mode: 'browser',
      out: (line) => out.push(line),
      openBrowser: async () => session.deliver('loop-code'),
      prompt: (_q, signal) => {
        promptSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined)));
      },
      beginLocal: async () => session,
      exchange,
    });
    await expect(pending).resolves.toEqual({ token: TOKEN, method: 'oauth-pkce' });
    expect(exchange).toHaveBeenCalledWith({
      code: 'loop-code',
      verifier: 'verifier-canary',
      redirectUri: 'http://127.0.0.1:5555/callback',
    });
    expect(promptSignal?.aborted).toBe(true);
    expect(session.closed()).toBe(true);
    expect(out.join('\n')).toContain(session.authorizeUrl);
    expect(out.join('\n')).not.toMatch(/canary|loop-code/);
  });

  it('code: a bad paste is explained, a good paste finishes the login', async () => {
    const session = fakeSession();
    const out: string[] = [];
    const answers = [
      'http://127.0.0.1:5555/callback?code=x&state=wrong',
      'http://127.0.0.1:5555/callback?code=pasted&state=s1',
    ];
    const openBrowser = vi.fn(async () => {});
    const exchange = vi.fn(async () => TOKEN);
    const result = await obtainXaiAuthorization({
      mode: 'code',
      out: (line) => out.push(line),
      openBrowser,
      prompt: async () => answers.shift(),
      beginLocal: async () => session,
      exchange,
    });
    expect(result.method).toBe('oauth-pkce');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ code: 'pasted' }));
    expect(out.join('\n')).toContain('state did not match');
  });

  it('code: end of input cancels instead of hanging', async () => {
    const session = fakeSession();
    await expect(
      obtainXaiAuthorization({
        mode: 'code',
        out: () => {},
        prompt: async () => undefined,
        beginLocal: async () => session,
        exchange: vi.fn(async () => TOKEN),
      }),
    ).rejects.toThrow('cancelled');
  });

  it('device: shows the x.ai page and user code, never a token', async () => {
    const out: string[] = [];
    const result = await obtainXaiAuthorization({
      mode: 'device',
      out: (line) => out.push(line),
      requestDevice: async () => ({
        deviceCode: 'device-secret',
        userCode: 'WXYZ-1234',
        verificationUri: 'https://accounts.x.ai/device',
        expiresIn: 600,
        interval: 5,
      }),
      pollDevice: async () => TOKEN,
    });
    expect(result).toEqual({ token: TOKEN, method: 'oauth-device' });
    const text = out.join('\n');
    expect(text).toContain('https://accounts.x.ai/device');
    expect(text).toContain('WXYZ-1234');
    expect(text).not.toMatch(/device-secret|canary/);
  });
});
