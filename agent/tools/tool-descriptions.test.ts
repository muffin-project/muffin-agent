import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../runtime.js';

/**
 * DAY-1 D13 — il tool dedicato prima della shell.
 *
 * La misura del 04/09 (docs/evidence/character-baseline-2026-09-04.md) e la
 * revisione del design (docs/evidence/tool-design-2026-08-26.md §4,
 * "Descrizioni a due velocità") hanno trovato lo stesso difetto da due lati:
 * `shell_run` spiegava il contenimento, e le altre descrizioni erano una riga
 * senza dire quando usarle e quando no — quindi un modello che deve scegliere
 * fra `fs_read` e un `cat` in `shell_run` non aveva, nel testo, una ragione
 * per preferire il primo. La guida Anthropic (`define-tools`, "Best practices
 * for tool definitions") chiede esplicitamente che una descrizione dica «cosa
 * fa il tool, quando va usato (e quando no), cosa restituisce» — l'esempio
 * "buono" è `get_stock_price`, che dice anche cosa il tool NON fa.
 *
 * Questo file non giudica la prosa — sarebbe fragile e soggettivo — controlla
 * una **forma**: ogni tool esposto al modello dichiara esplicitamente un
 * "quando" (Use it when / Usalo quando) e un "quando no" (Not for / Non per).
 * `shell_run` in più deve nominare almeno alcuni dei tool dedicati che lo
 * precedono, perché la riga "solo se nessun tool dedicato copre il caso" è la
 * claim di D13 e senza i nomi è solo un'affermazione di principio.
 *
 * I tool MCP sono esclusi: il loro `description` lo scrive il server esterno,
 * non questo repository, e non è nostro da far conformare.
 */

const WHEN_MARKERS = [/Use it when/, /Usalo quando/];
const NOT_FOR_MARKERS = [/Not for/, /Non per/];

function hasMarker(text: string, markers: readonly RegExp[]): boolean {
  return markers.some((re) => re.test(text));
}

describe('ogni tool esposto dice quando usarlo e quando no', () => {
  it('nessuna descrizione manca del "quando" o del "quando no" (o il loro equivalente italiano)', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-tooldesc-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-tooldesc-ws-')));
    try {
      const tools = runtime.deps.tools.filter((t) => !t.spec.name.startsWith('mcp_'));
      // Se la lista si svuotasse o l'esclusione MCP diventasse un colabrodo,
      // questo test passerebbe dicendo niente — lo stesso guardrail di
      // schema-conformance.test.ts.
      expect(tools.length).toBeGreaterThan(8);

      const senzaQuando: string[] = [];
      const senzaQuandoNo: string[] = [];
      for (const tool of tools) {
        const desc = String(tool.spec.description ?? '');
        if (!hasMarker(desc, WHEN_MARKERS)) senzaQuando.push(tool.spec.name);
        if (!hasMarker(desc, NOT_FOR_MARKERS)) senzaQuandoNo.push(tool.spec.name);
      }
      expect(senzaQuando).toEqual([]);
      expect(senzaQuandoNo).toEqual([]);

      // Nominati esplicitamente, come in schema-conformance.test.ts: se
      // sparissero dalla lista esaminata, l'esame non direbbe più niente su
      // di loro pur restando verde.
      const nomi = tools.map((t) => t.spec.name);
      expect(nomi).toEqual(
        expect.arrayContaining(['fs_read', 'fs_search', 'process_list', 'sys_inspect', 'shell_run', 'shell_run_write']),
      );
    } finally {
      runtime.close();
    }
  });

  it('le due corsie della shell nominano i tool dedicati, e dicono quale delle due è il ripiego', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-tooldesc-shell-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-tooldesc-shell-ws-')));
    try {
      const shell = runtime.deps.tools.find((t) => t.spec.name === 'shell_run');
      const write = runtime.deps.tools.find((t) => t.spec.name === 'shell_run_write');
      // Non skippato in silenzio: se il sandbox non è disponibile su questa
      // macchina, la claim di D13 non è verificabile e il test lo dice invece
      // di passare per assenza di prove (schema-conformance.test.ts nomina
      // shell_run allo stesso modo, quindi ci si aspetta che sia registrato
      // in questo harness).
      expect(shell, 'shell_run non registrato: sandbox non disponibile su questo host, la claim D13 non è provata qui').toBeDefined();
      expect(write, 'shell_run_write non registrato: le due corsie si registrano insieme o per niente').toBeDefined();
      const desc = String(shell!.spec.description ?? '');
      const descWrite = String(write!.spec.description ?? '');

      // Dal 06/09 (ADR-0074 §4) «last resort» non è più la shell: è la shell
      // **che scrive**. Spostare la frase è metà del punto — l'altra metà è
      // che la corsia in sola lettura si dichiari come scelta di default,
      // altrimenti il modello continua a leggere «shell = ultima spiaggia» e
      // a chiedere il permesso per un `ls`, che è il difetto misurato.
      expect(descWrite).toMatch(/last resort/i);
      expect(desc).not.toMatch(/last resort/i);
      expect(desc).toMatch(/default way to run a command/i);

      // Almeno tre dei tool dedicati che il capitolo D13 chiede di nominare,
      // uno per ciascuna famiglia (file, processo, propriocezione): togliere
      // la sezione che li nomina fa cadere questa riga.
      for (const dedicated of ['fs_read', 'process_list', 'sys_inspect']) {
        expect(desc, `shell_run non nomina ${dedicated}`).toContain(dedicated);
      }
      // E il rinvio fra le due, in tutte e due le direzioni: senza, il modello
      // sa che esistono due porte e non quale prendere.
      expect(desc, 'shell_run non dice dove andare quando serve scrivere').toContain('shell_run_write');
      expect(descWrite, 'shell_run_write non rimanda alla corsia che non chiede').toContain('shell_run');
    } finally {
      runtime.close();
    }
  });
});
