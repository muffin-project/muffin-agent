import { describe, expect, it } from 'vitest';
import { createNotifier, WATCHDOG_FRACTION } from './notify.js';

/**
 * The supervision protocol, with no supervisor anywhere near it.
 *
 * Every test here runs on macOS, which has no systemd at all — which is the
 * point twice over: the module has to be pure enough to drive from a fake env
 * and a fake sink, and the dev machine has to be able to start a gateway with
 * none of this present. ADR-0035 quotes Hermes on the second one: *"a missing
 * socket must never prevent the gateway from starting"*.
 */

const sink = (): { sent: string[]; send: (p: string) => void } => {
  const sent: string[] = [];
  return { sent, send: (p) => sent.push(p) };
};

describe('notifier without a supervisor', () => {
  it('is a no-op, and says so, when NOTIFY_SOCKET is absent', () => {
    const s = sink();
    const n = createNotifier({}, s.send);

    n.ready('in attesa');
    n.status('job in corso');
    n.watchdog();
    n.stopping();

    expect(n.supervised).toBe(false);
    expect(n.watchdogIntervalMs).toBeNull();
    // Not "it sent nothing harmful": it never reached the transport at all. On a
    // dev machine the transport is a process spawn that does not exist.
    expect(s.sent).toEqual([]);
  });

  it('treats an empty NOTIFY_SOCKET as absent', () => {
    expect(createNotifier({ NOTIFY_SOCKET: '' }, sink().send).supervised).toBe(false);
  });
});

describe('notifier under a supervisor', () => {
  const env = { NOTIFY_SOCKET: '/run/user/1000/systemd/notify' };

  it('sends READY=1 with the status in one datagram', () => {
    const s = sink();
    createNotifier(env, s.send).ready('in attesa');

    // One datagram, not two: systemd reads a datagram as a whole variable
    // block, and splitting them makes "ready" and "what it is doing" arrive as
    // separate events with a window in between where the status is the old one.
    expect(s.sent).toEqual(['READY=1\nSTATUS=in attesa']);
  });

  it('sends the watchdog ping and the stopping notice', () => {
    const s = sink();
    const n = createNotifier(env, s.send);
    n.watchdog();
    n.stopping('drenaggio');
    expect(s.sent).toEqual(['WATCHDOG=1', 'STOPPING=1\nSTATUS=drenaggio']);
  });

  it('reads the ping cadence from WATCHDOG_USEC, at a fraction of it', () => {
    // The interval is systemd's to declare, never ours to assume: the unit says
    // WatchdogSec and systemd passes it down in microseconds. Pinging at the
    // full interval races the deadline — one slow tick and the process is killed
    // while healthy.
    const n = createNotifier({ ...env, WATCHDOG_USEC: '60000000' }, sink().send);
    expect(n.watchdogIntervalMs).toBe(60_000 * WATCHDOG_FRACTION);
  });

  it('does not take the watchdog when WATCHDOG_PID names another process', () => {
    // systemd sets WATCHDOG_PID so an inherited environment does not turn every
    // child into a second thing pinging the watchdog. A child that keeps the
    // watchdog alive is precisely the failure the watchdog exists to catch.
    const n = createNotifier({ ...env, WATCHDOG_USEC: '60000000', WATCHDOG_PID: String(process.pid + 1) }, sink().send);
    expect(n.watchdogIntervalMs).toBeNull();
  });

  it('takes the watchdog when WATCHDOG_PID is ours', () => {
    const n = createNotifier({ ...env, WATCHDOG_USEC: '60000000', WATCHDOG_PID: String(process.pid) }, sink().send);
    expect(n.watchdogIntervalMs).toBe(30_000);
  });

  it('ignores a WATCHDOG_USEC that is not a positive number', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      expect(createNotifier({ ...env, WATCHDOG_USEC: bad }, sink().send).watchdogIntervalMs).toBeNull();
    }
  });

  it('flattens a status that would otherwise inject a second variable', () => {
    // The wire format is newline-separated `KEY=value`, so a newline inside a
    // status is not a formatting blemish: it is a second assignment. A job goal
    // echoed into the status could otherwise send `READY=1` on its own, and the
    // status text is the one field here that carries model-adjacent input.
    const s = sink();
    createNotifier(env, s.send).status('riga\nREADY=1\nancora');
    expect(s.sent).toEqual(['STATUS=riga READY=1 ancora']);
  });

  it('survives a transport that throws, and reports it once', () => {
    // ENOENT on the transport is the realistic case (no `systemd-notify` on the
    // host). It must not take the gateway down — but it must not be silent
    // either: without the ping systemd kills a healthy process every
    // WatchdogSec, which reads as a crash loop with no cause anywhere.
    let calls = 0;
    const n = createNotifier(env, () => {
      calls += 1;
      throw new Error('spawn systemd-notify ENOENT');
    });

    expect(() => n.ready('in attesa')).not.toThrow();
    expect(() => n.watchdog()).not.toThrow();
    expect(calls).toBe(2);
    expect(n.problem()).toContain('ENOENT');
  });
});
