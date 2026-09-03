import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/config.js';
import { EgressFileSchema, hostAllowed, loadEgress, type EgressPolicy } from '../net/egress.js';
import { seal } from './verify.js';

/**
 * The one function that widens `rot/egress.json` for an owner-approved
 * capability, and reseals — shared by `muffin search` and `muffin mcp add`
 * (ADR-0058).
 *
 * Before this existed, accendere una capability che parla con l'esterno erano
 * **due atti scollegati**: `muffin search tavily` scriveva la config e la
 * chiave, e nessun comando toccava mai `rot/egress.json` — misurato il
 * 03/09/2026, `grep -rn "egress.json" --include="*.ts"` fuori dai test dava
 * solo il lettore (`core/net/egress.ts`) e l'inventario. L'owner ha configurato
 * Tavily giusto, `doctor` era verde, e `web_search` restava spento perché
 * `api.tavily.com` non era nell'allowlist sigillata — lo ha scoperto grepando
 * il proprio log.
 *
 * **Perché una funzione sola e non due copie.** `muffin search` e `muffin mcp
 * add` sono la stessa domanda — "questa capability deve raggiungere questo
 * host, lo autorizzo?" — con owner e vocabolario diversi. Una porta duplicata
 * è esattamente il difetto che questo repository ha già pagato una volta
 * (`docs/decisions/0055-le-due-porte-passano-dal-kernel.md`).
 *
 * **Perché non pre-riempire l'allowlist.** Il vuoto è ciò che fa dell'elenco
 * il consenso dell'owner, non un default che sembra sicurezza. Questa
 * funzione non inferisce mai un host da un URL passato dal chiamante: prende
 * l'host esatto che il chiamante nomina (l'endpoint fisso di un provider dal
 * catalogo, o un host che l'owner ha scritto lui con `--host`), e nessun
 * altro.
 *
 * **Perché l'autorità è solo un terminale reale.** `deps.chiediConferma` è
 * assente a meno che il chiamante non lo cablasse da `isatty(0)` sul processo
 * reale — mai da un flag che un chiamante automatico potrebbe passare. Vedi
 * `core/rot/egress-shell-escalation.test.ts` per la prova che `sys.shell` (lo
 * strumento sandboxato del modello) non può mai costruire quella condizione:
 * il suo child gira con `stdio: ['ignore', 'pipe', 'pipe']`
 * (`core/sandbox/executor.ts`) — stdin non è mai un TTY — e anche se lo fosse,
 * `~/.muffin/rot` è un percorso a scrittura negata sempre nel sandbox
 * (`core/rot/guards.ts`, `mandatoryGuards`), indipendentemente dallo scope
 * passato per quella singola chiamata.
 */

export type EgressWidenDeps = {
  /** Una riga per l'owner. */
  readonly out: (line: string) => void;
  /**
   * Chiede sì/no a un terminale vero. Assente = nessun terminale interattivo
   * a cui chiedere (uno script, un test, o il figlio non-TTY di `sys.shell`):
   * in quel caso questa funzione non scrive mai nulla e stampa il rimedio a
   * mano, la stessa regola di `promptSecret`/`promptLine` (`cli/prompt.ts`).
   */
  readonly chiediConferma?: (domanda: string) => Promise<string | undefined>;
};

export type EgressWidenOutcome =
  | { readonly ok: true; readonly added: readonly string[] }
  | { readonly ok: false };

const SI_NO = /^(s(i|ì)?|y(es)?)$/i;

/**
 * `hosts` sono nomi esatti, mai wildcard dedotti qui: chi chiama decide la
 * forma (`*.example.com` è valida solo se il chiamante la scrive così).
 *
 * Una sola domanda per l'intera chiamata, anche con più host — "un atto solo"
 * vale anche quando la capability ne nomina più di uno insieme (un server MCP
 * con `--host` ripetuto).
 */
export async function widenEgressForCapability(
  home: string,
  hosts: readonly string[],
  capabilityLabel: string,
  deps: EgressWidenDeps,
): Promise<EgressWidenOutcome> {
  const { out } = deps;
  const rotDir = paths(home).rot;
  const egressFile = join(rotDir, 'egress.json');

  let policy: EgressPolicy;
  try {
    policy = loadEgress(home);
  } catch (error) {
    out(`non riesco a leggere l'allowlist: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }

  const normalizzati = [...new Set(hosts.map((h) => h.toLowerCase().replace(/\.$/, '')))];
  const mancanti = normalizzati.filter((h) => !hostAllowed(h, policy));
  if (mancanti.length === 0) return { ok: true, added: [] };

  const elenco = mancanti.join(', ');
  const plurale = mancanti.length > 1;
  const rimedioAMano = `aggiungi ${plurale ? elenco : `"${mancanti[0]}"`} all'array "allow" in ${egressFile}, poi \`muffin rot reseal\`.`;

  if (deps.chiediConferma === undefined) {
    out(`${capabilityLabel} deve raggiungere ${elenco}, non ancora nell'allowlist (${egressFile}).`);
    out(`Da qui non posso chiedere conferma — nessun terminale interattivo: ${rimedioAMano}`);
    return { ok: false };
  }

  const risposta = await deps.chiediConferma(
    `${capabilityLabel} deve poter raggiungere ${elenco}. ` +
      `${plurale ? 'Li aggiungo' : "Lo aggiungo"} all'allowlist e risigillo il root of trust adesso? [s/N] `,
  );
  const consenso = risposta !== undefined && SI_NO.test(risposta.trim());
  if (!consenso) {
    out(`Non aggiunto niente. ${rimedioAMano}`);
    return { ok: false };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(egressFile, 'utf8'));
  } catch (error) {
    out(`${egressFile}: ${error instanceof Error ? error.message : String(error)}. ${rimedioAMano}`);
    return { ok: false };
  }
  const parsed = EgressFileSchema.safeParse(raw);
  if (!parsed.success) {
    out(`${egressFile} non ha la forma attesa. ${rimedioAMano}`);
    return { ok: false };
  }

  // Ogni altra voce (e `_comment`) resta com'era: si aggiunge, non si sostituisce.
  const next = { ...parsed.data, allow: [...parsed.data.allow, ...mancanti] };
  try {
    writeFileSync(egressFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    seal(home, '1', new Date());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      out(
        `non posso scrivere in ${rotDir}: permesso negato. Se hai reso vera la modalità hardened, rifai questo ` +
          "comando con il privilegio che serve (es. `sudo`), oppure a mano: " +
          rimedioAMano,
      );
    } else {
      out(`scrittura fallita: ${error instanceof Error ? error.message : String(error)}. ${rimedioAMano}`);
    }
    return { ok: false };
  }

  out(`${elenco} aggiunt${plurale ? 'i' : 'o'} all'allowlist. Root of trust risigillato.`);
  return { ok: true, added: mancanti };
}
