import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../../agent/loop/types.js';
import {
  type ControlServer,
  resolveSocketPath,
  socketPathFor,
  serveControlSocket,
} from '../gateway/control-socket.js';
import { type ForwardDeps, ForwardHost } from '../gateway/forward.js';
import { mandatoryGuards } from '../rot/guards.js';
import { ModelLane } from '../turns/model-lane.js';
import { SandboxExecutor } from './executor.js';
import { probeSandbox } from './probe.js';

/**
 * #638, falsificatore live: la corsia in sola lettura non raggiunge il
 * socket di controllo del gateway, quindi non può coniare un turno owner.
 *
 * Solo Linux: la proprietà vive in `--ro-bind / /` + il filtro seccomp
 * AF_UNIX di bwrap, che su macOS/seatbelt è un meccanismo diverso. Su macOS la
 * copertura è il test unitario (`denyRead` contiene `controlSocketGuardPaths`
 * in `core/rot/guards.test.ts`); fingere di provare bwrap da seatbelt
 * sarebbe un verde fabbricato.
 *
 * Il test specchia la produzione: guardie di produzione (`mandatoryGuards`),
 * vero socket servito, `ForwardHost` vero attaccato. Copre sia la home breve
 * sia il fallback con socket hash in temp e puntatore per home lunghe. Il
 * client dentro il sandbox prova a connettersi e a inviare una prima riga
 * `run` valida: deve fallire PRIMA che qualunque turno owner nasca (`calls`
 * resta vuoto).
 * Se un giorno questo va rosso su Linux, il deny statico non regge live —
 * ed è esattamente la prova che chiude o riapre l'issue.
 */
const host = platform();

const linuxGate: { run: boolean; why: string } = (() => {
  if (host !== 'linux') {
    return {
      run: false,
      why: 'falsificatore solo Linux (bwrap --ro-bind + filtro seccomp AF_UNIX); su macOS vale il test unitario sulla deny-list',
    };
  }
  const p = probeSandbox();
  if (p.available) return { run: true, why: `linux: ${p.mechanism} contained a real probe` };
  return { run: false, why: `linux: sandbox unavailable — ${p.reason}: ${p.detail}` };
})();

const containmentRequired = process.env['MUFFIN_REQUIRE_SANDBOX'] === '1';

describe('il falsificatore dichiara se e girato', () => {
  it('o la prova e girata, o lo skip e dichiarato', () => {
    if (linuxGate.run) {
      expect(linuxGate.why).not.toBe('');
      return;
    }
    if (containmentRequired && host === 'linux') {
      throw new Error(
        `MUFFIN_REQUIRE_SANDBOX=1 e il falsificatore del canale non e girato su Linux — ${linuxGate.why}.`,
      );
    }
    console.warn(`[sandbox] canale di controllo NON provato live — ${linuxGate.why}`);
    expect(linuxGate.why).not.toBe('');
  });
});

describe.runIf(linuxGate.run)(
  `runReadOnly non raggiunge il socket di controllo (${linuxGate.why})`,
  () => {
    it.each([
      { label: 'home breve', longHome: false },
      { label: 'fallback hash in temp per home lunga', longHome: true },
    ])('$label: connettersi al gateway fallisce, e nessun turno owner nasce', async ({ longHome }) => {
      const base = mkdtempSync(join(tmpdir(), 'muffin-canale-'));
      const home = longHome ? join(base, 'h'.repeat(100)) : join(base, 'home');
      const workspace = join(base, 'workspace');
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });

      // Il gateway vero, con un runtime che registrerebbe la chiamata.
      const lane = new ModelLane();
      const calls: string[] = [];
      const risultato = (turnId: string): TurnResult => ({
        text: 'fatto',
        iterations: 1,
        traceId: turnId,
        turnId,
        stopped: 'answered',
        taint: 0,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      const deps: ForwardDeps = {
        modelLane: lane,
        stillOwner: () => true,
        turns: { get: () => null },
        openSession: (id: string) => ({ id, file: join(home, 'sessions', `${id}.jsonl`) }),
        execute: async (input) => {
          calls.push(input.id ?? '?');
          return risultato(input.id ?? '?');
        },
        model: () => 'modello-prova',
        log: () => {},
      };
      const forward = new ForwardHost(deps);
      let server: ControlServer | null = null;
      const executor = new SandboxExecutor(mandatoryGuards(home, workspace));
      let previousUmask: number | undefined;
      try {
        if (longHome) previousUmask = process.umask(0o022);
        server = await serveControlSocket(home, () => null, {
          onStream: (sock: Socket, first: Record<string, unknown>) =>
            forward.handleRun(sock, first),
        });
        if (previousUmask !== undefined) {
          process.umask(previousUmask);
          previousUmask = undefined;
        }
        const socketPath = resolveSocketPath(home);
        expect(socketPath).toBe(server.path);
        const guardPaths = mandatoryGuards(home, workspace).denyRead;
        expect(guardPaths).toContain(socketPath);
        const { pointer } = socketPathFor(home);
        if (longHome) {
          expect(pointer).not.toBeNull();
          expect(dirname(socketPath)).toContain('m-');
          expect(guardPaths).toContain(pointer);
        } else {
          expect(pointer).toBeNull();
        }

        // Controllo positivo: dall'host il socket risponde.
        const hostRaggiunge = await new Promise<boolean>((resolve) => {
          const s = connect(socketPath, () => {
            s.destroy();
            resolve(true);
          });
          s.on('error', () => resolve(false));
          s.setTimeout(3_000, () => {
            s.destroy();
            resolve(false);
          });
        });
        expect(
          hostRaggiunge,
          'il controllo positivo e caduto: il socket non risponde nemmeno dall\u2019host',
        ).toBe(true);
        if (longHome) {
          const ownerUid = process.getuid?.();
          if (ownerUid === undefined) throw new Error('long-home socket proof requires a POSIX uid');
          const socketStat = statSync(socketPath);
          const directoryStat = statSync(dirname(socketPath));
          expect(socketStat.isSocket()).toBe(true);
          expect(socketStat.uid).toBe(ownerUid);
          expect(socketStat.mode & 0o777).toBe(0o600);
          expect(directoryStat.isDirectory()).toBe(true);
          expect(directoryStat.uid).toBe(ownerUid);
          expect(directoryStat.mode & 0o777).toBe(0o700);

          // Different-UID proof, separate from the same-UID sandbox check.
          // GitHub's Linux runner has passwordless sudo; a local runner without
          // that facility records a skip unless the CI requirement is enabled.
          const nobody = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' });
          const nobodyUid = Number(nobody.stdout.trim());
          const canSwitchUid = nobody.status === 0 && nobodyUid !== ownerUid;
          const otherUid = canSwitchUid
            ? spawnSync(
                'sudo',
                [
                  '-n',
                  '-u',
                  'nobody',
                  '--',
                  process.execPath,
                  '-e',
                  `const net=require('node:net');const c=net.connect(process.argv[1]);c.once('connect',()=>{console.error('CONNECTED');process.exit(0)});c.once('error',e=>{console.error('DENIED:'+e.code);process.exit(e.code==='EACCES'||e.code==='ENOENT'?1:2)});setTimeout(()=>{console.error('TIMEOUT');process.exit(3)},3000);`,
                  socketPath,
                ],
                { encoding: 'utf8', timeout: 5_000 },
              )
            : null;
          const otherUidOutput = `${otherUid?.stdout ?? ''}\n${otherUid?.stderr ?? ''}`;
          const otherUidDenied = otherUid?.status === 1 && /DENIED:(?:EACCES|ENOENT)/.test(otherUidOutput);
          if (!otherUidDenied) {
            const detail = `non-owner socket check did not prove denial: ${otherUidOutput.trim()}`;
            if (containmentRequired) throw new Error(detail);
            console.warn(`[sandbox] ${detail}`);
          }
        }

        // Il client che gira DENTRO il sandbox: connette e prova un `run`.
        const sonda = join(workspace, 'sonda-unix.js');
        writeFileSync(
          sonda,
          `const fs = require('node:fs');
const net = require('node:net');
const sock = process.argv[2];
const pointer = process.argv[3];
if (pointer) {
  try {
    fs.readFileSync(pointer, 'utf8');
    console.error('POINTER_VISIBLE');
  } catch (e) {
    console.error('POINTER_HIDDEN:' + e.code);
  }
}
const c = net.connect(sock);
c.setEncoding('utf8');
c.on('connect', () => {
  c.write(JSON.stringify({ verb: 'run', protocol: 2, id: 'sock-evil-1', text: 'fai danni', sessionId: 'sess-1' }) + '\\n');
});
c.on('data', () => {});
c.on('error', (e) => { console.error('NEGATO:' + e.code); process.exit(1); });
setTimeout(() => { console.error('NEGATO:timeout'); process.exit(2); }, 5000);
`,
        );
        const pointerArg = pointer === null ? '' : ` '${pointer}'`;
        const r = await executor.runReadOnly({
          command: `node '${sonda}' '${socketPath}'${pointerArg}`,
          cwd: workspace,
        });
        expect(r.stdout).not.toContain('started');
        expect(r.code).not.toBe(0);
        // A sandbox setup or command-launch failure is not proof of socket
        // denial: require the client itself to report the connect errno.
        // ECONNREFUSED is valid too: the host just proved this exact path is
        // listening, while the sandbox client still cannot connect to it.
        // EPERM is the strongest of the four and comes from the layer below
        // `denyRead`: since `networkOff()` requests srt's AF_UNIX seccomp
        // filter, `socket(AF_UNIX, …)` itself is refused before the deny
        // list is ever consulted (measured on the Linux runner, 2026-09-26).
        expect(r.stderr).toMatch(/NEGATO:(?:EACCES|ENOENT|ECONNREFUSED|EPERM)\b/);
        expect(r.stderr).not.toContain('NEGATO:timeout');
        if (pointer !== null) {
          expect(r.stderr).toMatch(/POINTER_HIDDEN:(?:EACCES|ENOENT)\b/);
          expect(r.stderr).not.toContain('POINTER_VISIBLE');
        }
        // E nessun turno owner e nato nel frattempo.
        expect(calls).toHaveLength(0);
        expect(forward.query('sock-evil-1')).toEqual({ found: false });
      } finally {
        if (previousUmask !== undefined) process.umask(previousUmask);
        await executor.close();
        await server?.close();
      }
    }, 30_000);
  },
);
