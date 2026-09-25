import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import type { Principal } from '../../core/policy/types.js';
import type { ToolContext } from '../loop.js';
import { buildRuntime } from '../runtime.js';

/**
 * Declared fixture for the shell boundary (see the same mocks in
 * `tool-descriptions.test.ts`): `shell_run` is named below as examined, so the
 * claim must not depend on the host. The version mock covers bwrap < 0.12.0
 * refusing the lanes (#642); the AF_UNIX flag mock declares the *filtered*
 * Linux configuration, because the shipped one is fail-closed until socket
 * filtering is verified (#638) and would otherwise make this claim unprovable
 * on the Linux runner. The gate itself is tested in
 * `agent/sandbox-gate.test.ts`, `core/sandbox/shell-boundary.test.ts` and
 * `cli/doctor.test.ts`.
 */
vi.mock('../../core/sandbox/bubblewrap-version.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../core/sandbox/bubblewrap-version.js')>();
  return { ...mod, readBubblewrapVersion: () => 'bubblewrap 0.12.0' };
});

vi.mock('../../core/sandbox/executor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../core/sandbox/executor.js')>();
  return { ...mod, LINUX_ALLOW_ALL_UNIX_SOCKETS: false };
});

/**
 * Lo schema dichiarato e quello preteso.
 *
 * `ToolSpec.inputSchema` è quello che il modello legge; a difendere è lo schema
 * zod dentro l'handler. Sono due copie di un'intenzione sola e niente le tiene
 * d'accordo: un tool può dichiarare `required: ['url']` e non validare niente,
 * e la suite resta verde perché ogni test di quel tool gli passa argomenti
 * giusti.
 *
 * Il difetto non è ipotetico nel modo che conta: il kernel legge gli argomenti
 * **grezzi** (`resourceFor` → `args[decl.policyArgs[i]]`) prima che qualunque
 * handler giri. È difensivo — accetta solo stringhe, e un resource dichiarato
 * ma assente diventa un rifiuto — quindi da lì esce un no, mai un sì. Ma il
 * docstring di `inputSchema` diceva «validated before the kernel ever sees the
 * arguments», che era falso in tutte e due le metà, e diceva al prossimo che la
 * validazione era già risolta altrove.
 *
 * Questo file non confronta i due schemi campo per campo — sarebbe una terza
 * copia. Chiede una cosa sola, comportamentale: **se dichiari un argomento
 * obbligatorio, pretendilo davvero.**
 */
function ctx(): ToolContext {
  const principal: Principal = { kind: 'owner', connector: 'cli', externalId: 'test' };
  return {
    tenant: 'host',
    principal,
    turnId: 'turno-di-prova',
    sessionId: 'sessione-di-prova',
    taint: () => 0,
    intrinsicTaint: () => 0,
    suspend: () => {},
    replyChannel: null,
  };
}

describe('un argomento dichiarato obbligatorio è preteso davvero', () => {
  it('nessun tool accetta {} quando il suo schema dice che serve qualcosa', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-conform-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-conform-ws-')));
    try {
      const tools = runtime.deps.tools;
      // Se la lista si svuotasse, questo test passerebbe dicendo niente.
      expect(tools.length).toBeGreaterThan(4);

      const passati: string[] = [];
      // Contati, non solo saltati: una guardia che non guarda niente resta
      // verde per costruzione, ed è il modo in cui smette di difendere senza
      // che nessuno se ne accorga. È la stessa mutazione sopravvissuta al
      // primo giro in #171.
      const esaminati: string[] = [];
      for (const tool of tools) {
        const required = (tool.spec.inputSchema as { required?: unknown }).required;
        if (!Array.isArray(required) || required.length === 0) continue;
        esaminati.push(tool.spec.name);
        let rifiutato = false;
        try {
          const out = await tool.handler({}, ctx());
          rifiutato = out.isError === true;
        } catch {
          // Un throw è un rifiuto: `runTool` lo trasforma in un tool_result di
          // errore, che è esattamente ciò che il modello deve leggere.
          rifiutato = true;
        }
        if (!rifiutato) passati.push(`${tool.spec.name} (dichiara ${required.join(', ')})`);
      }
      expect(passati).toEqual([]);
      // I tre `fs` sono quelli da cui è saltato fuori il difetto, quindi sono
      // nominati: se sparissero dall'esame, l'esame non direbbe niente su di
      // loro restando verde.
      expect(esaminati).toEqual(
        expect.arrayContaining(['fs_read', 'fs_list', 'fs_write', 'shell_run']),
      );
      expect(esaminati.length).toBeGreaterThanOrEqual(5);
    } finally {
      runtime.close();
    }
  });
});
