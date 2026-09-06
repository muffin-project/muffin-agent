import { describe, expect, it } from 'vitest';
import { puntaTmpdirAlloScratch } from './executor.js';

/**
 * Le tre forme in cui `@anthropic-ai/sandbox-runtime` consegna `TMPDIR`,
 * fabbricate dalla forma misurata e non dalla vera macchina: la prova viva è
 * `confine-sola-lettura.test.ts`, che gira su bwrap nel job `verifica` di
 * ci:local e su seatbelt in locale. Qui si prova la *lettura* dell'argv, cioè
 * il pezzo che il 06/09 era sbagliato mentre la prova viva era rossa.
 */
describe('puntaTmpdirAlloScratch', () => {
  const scratch = '/tmp/muffin-exec-abc123';

  it('Linux: la riga di bwrap è una stringa sola dopo `-c`, e il valore cambia lì', () => {
    const riga =
      'bwrap --ro-bind / / --tmpfs /tmp --setenv SANDBOX_RUNTIME 1 --setenv TMPDIR /tmp/claude --unshare-net -- bash -c \'echo ok > "$TMPDIR/nota" && TMPDIR=/x make\'';
    const out = puntaTmpdirAlloScratch(['/bin/bash', '-c', riga], scratch);
    const riscritta = out[2] ?? '';
    expect(riscritta).toContain(`--setenv TMPDIR ${scratch} --unshare-net`);
    expect(riscritta).not.toContain('/tmp/claude');
    // Il comando del modello, dopo il `--`, è intatto byte per byte.
    expect(riscritta.slice(riscritta.indexOf(' -- '))).toBe(riga.slice(riga.indexOf(' -- ')));
  });

  it('Linux: un valore in apici singoli (CLAUDE_CODE_TMPDIR con uno spazio) si sostituisce intero', () => {
    const riga = "bwrap --setenv TMPDIR '/tmp/con spazio' -- bash -c 'true'";
    const out = puntaTmpdirAlloScratch(['/bin/bash', '-c', riga], '/tmp/scratch con spazio');
    expect(out[2]).toBe("bwrap --setenv TMPDIR '/tmp/scratch con spazio' -- bash -c 'true'");
  });

  it('Linux: un `--setenv TMPDIR` scritto dal modello, dopo il `--`, non si tocca', () => {
    const riga = "bwrap --unshare-net -- bash -c 'echo --setenv TMPDIR /tmp/claude'";
    const out = puntaTmpdirAlloScratch(['/bin/bash', '-c', riga], scratch);
    expect(out[2]).toBe(riga);
  });

  it('macOS: il prefisso `env SANDBOX_RUNTIME=1 TMPDIR=…` cambia, il resto della riga no', () => {
    const riga =
      "env SANDBOX_RUNTIME=1 TMPDIR=/tmp/claude /usr/bin/sandbox-exec -p x bash -c 'echo TMPDIR=/y'";
    const out = puntaTmpdirAlloScratch(['/bin/bash', '-c', riga], scratch);
    expect(out[2]).toBe(riga.replace('TMPDIR=/tmp/claude', `TMPDIR=${scratch}`));
  });

  it('elementi separati: la coppia prima del `-c` cambia, il comando dopo no', () => {
    const out = puntaTmpdirAlloScratch(
      [
        'bwrap',
        '--setenv',
        'TMPDIR',
        '/tmp/claude',
        '--',
        'bash',
        '-c',
        '--setenv TMPDIR /tmp/claude',
      ],
      scratch,
    );
    expect(out[3]).toBe(scratch);
    expect(out[7]).toBe('--setenv TMPDIR /tmp/claude');
  });
});
