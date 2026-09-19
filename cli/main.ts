#!/usr/bin/env node
import { existsSync, readFileSync, readSync, rmSync } from 'node:fs';
import { isatty } from 'node:tty';
import { parseArgs } from 'node:util';
import { formatReport, runDoctor } from './doctor.js';
import { styleFor } from './ui.js';
import { ALL_API_KEY_NAMES, LEGACY_API_KEY_NAME } from '../core/config/providers.js';
import { cmdUndo } from './undo.js';
import { cmdOrientamento } from './orientamento.js';
import { cmdEffects } from './effects.js';
import { defaultModels, isSameOrNestedPath, resolveLocalHome, runInit } from './init.js';
import { SandboxExecutor } from '../core/sandbox/executor.js';
import { seal, verify } from '../core/rot/verify.js';
import { buildHardenPlan, formatHardenPlan } from '../core/rot/harden.js';
import { formatSpan, formatTurn, readSpans } from './trace.js';
import { runHeadless } from './run.js';
import { runRepl } from './repl.js';
import {
  cmdMemoryCheck,
  cmdMemoryExtract,
  cmdMemoryPin,
  cmdMemoryReview,
  cmdMemoryReviewKeep,
  cmdMemorySearch,
  cmdMemoryStats,
  cmdMemoryUnpin,
  cmdMemoryWhy,
  MEMORY_USAGE,
} from './memory.js';
import { checkTemporalWindow, EVERY_INSTANT, normaliseDate } from '../core/memory/recall.js';
import { cmdVaultAdd, cmdVaultCheck, cmdVaultLs, cmdVaultReindex, VAULT_USAGE } from './vault.js';
import { cmdSurfaceDefault, cmdSurfaceDisable, cmdSurfaceEnable, cmdSurfaceList, SURFACE_USAGE } from './surface.js';
import { cmdMcpAdd, cmdMcpList, cmdMcpRemove, MCP_USAGE } from './mcp.js';
import { cmdAdopt } from './adopt.js';
import { cmdJobsAdd, cmdJobsCap, cmdJobsList, cmdJobsRemove, JOBS_USAGE } from './jobs.js';
import {
  cmdGatewayInstall,
  cmdGatewayRestart,
  cmdGatewayRun,
  cmdGatewayStart,
  cmdGatewayStatus,
  cmdGatewayStop,
  cmdGatewayTurn,
  GATEWAY_USAGE,
} from './gateway.js';
import { cmdObserve } from './observe.js';
import { cmdBackup, cmdRestore } from './backup.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdUpdate, describeBuild } from './update.js';
import { cmdConfig } from './config.js';
import { cmdModel } from './model.js';
import { cmdSearch } from './search-setup.js';
import type { TrustTier } from '../core/policy/types.js';
import {
  loadConfig,
  locateSecret,
  locateSecretAll,
  paths,
  writeAuthoritativeSecret,
  ConfigError,
  type ProviderKind,
} from '../core/config/config.js';
import { promptLine, promptSecret } from './prompt.js';
import { cmdPromptShow, cmdPromptVersion, PROMPT_USAGE } from './prompt-show.js';
import {
  askLocalOrApi,
  askModelChoice,
  chooseProvider,
  describeModelChoice,
  describeProviderChoice,
  describeSandboxProbe,
  describeSupervisor,
  keyHint,
  localModelChoices,
  looksLikeTelegramToken,
  OPENROUTER_MODEL_FAMILIES,
  DEFAULT_LOCAL_RUNTIME_URL,
  probeLocalRuntime,
  type ModelChoiceReason,
} from './onboarding.js';
import { allHelp, canonicalCommand, completion, primaryHelp } from './command-surface.js';

/**
 * Entry point.
 *
 * stdout carries the answer, stderr carries everything else, and the exit code
 * means something — this thing has to be scriptable before it is conversational.
 */

/**
 * package.json sits one level above `cli/` in source but two levels above once
 * compiled to `dist/cli/`. Walk up until we find it so `--version` answers the
 * same whether run via tsx or the built `muffin` bin.
 */
function readOwnVersion(): string {
  let dir = new URL('./', import.meta.url);
  let declared = '0.0.0';
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')) as { version: string };
      declared = pkg.version;
      break;
    } catch {
      dir = new URL('../', dir);
    }
  }
  // `0.0.0` da solo non identifica niente, e questo progetto non si distribuisce
  // per release numerate: `muffin update` costruisce `.releases/<sha>`, quindi
  // il commit **è** la versione. Vedi `describeBuild`.
  const build = describeBuild(dirname(fileURLToPath(import.meta.url)));
  if (build === null) return `${declared} (build sconosciuta: nessun checkout Git)`;
  return `${declared} (${build.sha.slice(0, 12)}${build.dirty ? '+modificato' : ''}, ${build.date})`;
}

/**
 * Load a .env from the working directory if present — a development convenience
 * for non-secret variables (`MUFFIN_HOME` above all, which is how dev and prod
 * are separated). Real environment variables win (verified against Node 22:
 * loadEnvFile does not override an already-set value); a missing file is a
 * no-op, so production — which ships no .env — is untouched. Node 22 native, no
 * dotenv dependency.
 *
 * **It is no longer where the model key goes** (ADR-0039 amends ADR-0030). The
 * key survived a `muffin uninstall` by living here, which worked — and put the
 * plaintext key inside `root`, the directory `fs_read` is scoped to, at a taint
 * ceiling of 3. `muffin secret set --persist` replaces it. The loader stays,
 * because `MUFFIN_HOME` in a `.env` is a real convenience and carries nothing
 * secret; a key left here anyway still works, and is on the tools' deny-read
 * list so it cannot be read back by the agent.
 */
function loadDotenvIfPresent(): void {
  const envPath = `${process.cwd()}/.env`;
  if (!existsSync(envPath)) return;
  const load = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  try {
    load?.(envPath);
  } catch {
    // A malformed .env must not stop the CLI from starting.
  }
}

/**
 * `--stream`/`--no-stream` → the explicit override `runRepl`'s own
 * `opts.stream` takes — absent means "decide from `process.stdout.isTTY`",
 * which is what a real terminal always gets. `--stream` exists for the
 * mirror-image case autodetection cannot see: a pipe that still wants the
 * progressive text (`muffin repl --stream | tee log`, and the acceptance
 * scenario for B11, which drives the real binary over a pipe and has no TTY
 * to autodetect from). `--no-stream` wins if a script passes both — the
 * conservative direction, matching how a config hierarchy resolves a
 * conflicting pair elsewhere in this CLI (flag beats flag, most restrictive
 * beats least).
 */
function streamOverride(argv: string[]): boolean | undefined {
  if (argv.includes('--no-stream')) return false;
  if (argv.includes('--stream')) return true;
  return undefined;
}

async function main(rawArgv: string[]): Promise<number> {
  loadDotenvIfPresent();
  // Stripped before the switch below, not parsed per-branch, so reading them
  // is the same whether they ride with a bare `muffin` (`command` ends up
  // `undefined`, not the flag string) or with `muffin repl`.
  const stream = streamOverride(rawArgv);
  // `--debug` come `--stream`: tolto qui e non parsato per-ramo, così vale sia
  // per il `muffin` nudo (dove `command` resta `undefined` invece di diventare
  // la stringa del flag) sia per `muffin repl`.
  const debug = rawArgv.includes('--debug');
  const argv = rawArgv.filter((a) => a !== '--no-stream' && a !== '--stream' && a !== '--debug');
  const [typed, ...rest] = argv;
  // Resolved once, here, so every branch below — including the error path —
  // only ever sees canonical command names. `typed` itself is undefined for a
  // bare `muffin`, which must not become the string "undefined" in a lookup.
  const command = typed !== undefined ? canonicalCommand(typed) : typed;
  switch (command) {
    case 'run':
      return cmdRun(rest);
    case 'repl':
      return runRepl(paths().home, { ...(stream !== undefined ? { stream } : {}), ...(debug ? { debug } : {}) });
    case 'init':
      return cmdInit(rest);
    case 'config':
      return cmdConfig(paths().home, rest);
    case 'model': {
      const style = styleFor(process.stdout);
      process.stdout.write(`${style.header('muffin model')}\n`);
      return cmdModel(paths().home, rest, { out: (l) => process.stdout.write(`${l}\n`) });
    }
    case 'search':
      // `readKey` legge stdin **solo** quando un motore e' stato nominato: senza
      // questa pigrizia, `muffin search` da solo si bloccherebbe su un
      // terminale in attesa di una chiave che nessuno sta per dare.
      process.stdout.write(`${styleFor(process.stdout).header('muffin search')}\n`);
      return cmdSearch(paths().home, rest, {
        out: (l) => process.stdout.write(`${l}\n`),
        secretBackend: 'persistent',
        // Su un terminale stdin non e' una pipe: leggerlo vorrebbe dire
        // aspettare byte che nessuno sta scrivendo, e poi stampare un errore
        // di scadenza al posto della domanda. `isatty(0)` divide i due mondi,
        // la stessa guardia di `readKeyFromStdin`.
        readKey: () => {
          if (isatty(0)) return '';
          try {
            return readAllStdin();
          } catch {
            return '';
          }
        },
        // Il terminale la chiede e non la mostra. Lo stesso `promptSecret` di
        // `muffin init`: la chiave non tocca mai una riga di comando, quindi
        // non entra ne' nella history ne' in un `ps`. Le parole della domanda
        // sono di `cmdSearch`, che sa cosa sta chiedendo; qui c'e' solo il
        // terminale a cui chiederla.
        ...(isatty(0)
          ? {
              chiediChiave: (domanda: string) => promptSecret(domanda),
              // Stessa guardia, per l'unica domanda che allarga
              // `rot/egress.json`: solo un terminale vero la vede.
              chiediConferma: (domanda: string) => promptLine(domanda),
            }
          : {}),
      });
    case 'doctor':
      return cmdDoctor(rest);
    case 'adopt': {
      const style = styleFor(process.stdout);
      process.stdout.write(`${style.header('muffin adopt', paths().home)}\n`);
      return cmdAdopt(paths().home, rest, { out: (l) => process.stdout.write(`${l}\n`), style });
    }
    case 'backup':
      return cmdBackup(rest);
    case 'restore':
      return cmdRestore(rest);
    case 'update':
      return cmdUpdate(rest);
    case 'rot':
      return cmdRot(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    case 'memory':
      return cmdMemory(rest);
    case 'vault':
      return cmdVault(rest);
    case 'surface':
      return cmdSurface(rest);
    case 'mcp':
      return cmdMcp(rest);
    case 'jobs':
      return cmdJobs(rest);
    case 'gateway':
      return cmdGateway(rest);
    case 'observe':
      return cmdObserve(paths().home, rest);
    case 'prompt':
      return cmdPrompt(rest);
    case 'secret':
      return cmdSecret(rest);
    case 'trace':
      return cmdTrace(rest);
    case 'resume': {
      const target = rest.find((a) => !a.startsWith('--'));
      if (target === undefined || rest.includes('--help') || rest.includes('-h')) {
        process.stderr.write(`usage: muffin resume <turn-id> [--json]\n`);
        return 78;
      }
      const { runResume } = await import('./resume.js');
      return runResume({ turnId: target, ...(rest.includes('--json') ? { json: true } : {}) });
    }
    case 'undo':
      return cmdUndo(rest);
    case 'orientamento':
      return cmdOrientamento(rest);
    case 'effects':
      return cmdEffects(rest);
    case 'completion': {
      const script = completion(rest[0] ?? '');
      if (script === null) {
        process.stderr.write('usage: muffin completion <bash|zsh|fish>\n');
        return 78;
      }
      process.stdout.write(script);
      return 0;
    }
    case 'help':
      process.stdout.write(rest.includes('--all') ? allHelp() : primaryHelp());
      return 0;
    case undefined: {
      // Bare `muffin` opens the REPL — but on a first run there is no config to
      // open it with. Detect that and route into setup instead of failing with a
      // stack trace the user cannot act on.
      if (!existsSync(paths().config)) return firstRun();
      return runRepl(paths().home, { ...(stream !== undefined ? { stream } : {}), ...(debug ? { debug } : {}) });
    }
    case '--help':
    case '-h':
      process.stdout.write(primaryHelp());
      return 0;
    case '--version':
    case '-v': {
      // GNU baseline: every CLI answers --version (docs/PRACTICES.md#prior-art-before-durable-shape).
      process.stdout.write(`muffin ${readOwnVersion()}\n`);
      return 0;
    }
    default:
      process.stderr.write(`comando sconosciuto: ${typed}\n\n${primaryHelp()}`);
      return 78;
  }
}

/**
 * La chiave da stdin quando `muffin init` gira in una pipe; `undefined` quando
 * stdin e un terminale (allora si usa il prompt nascosto) o e vuoto.
 *
 * `readFileSync(0)` e non un readline: e la stessa lettura di
 * `muffin secret set`, e un `init` in CI non ha un TTY su cui aprire un prompt.
 */
/**
 * Tutto stdin, anche quando fd 0 e non-bloccante e il produttore e lento.
 *
 * Il difetto che questa funzione esiste per chiudere, misurato due volte dal
 * judge di questa slice: `readFileSync(0)` su fd 0 non-bloccante lancia
 * **EAGAIN** appena i dati non sono ancora arrivati, e il `catch` intorno lo
 * leggeva come «nessuna chiave» — quindi `pass show`, `op read`, `gpg -d`
 * fallivano **in silenzio**, e il fail-closed di `MUFFIN_API_KEY` rimandava a
 * una porta che non si apre.
 *
 * Il fd resta non-bloccante e non c'e niente da fare qui: lo mette
 * `process.stdin`, toccato a import time nel grafo dei moduli (bisect del
 * judge: `import('./repl.js')` basta). `isatty(0)` sposta la guardia, non il
 * problema; `openSync('/dev/stdin')` nemmeno — eredita la stessa open file
 * description. Quindi si ritenta, con una scadenza, e un errore di lettura non
 * diventa mai «nessun valore».
 */
function readAllStdin(primoByteMs = 3_000, poiMs = 60_000): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let visto = 0;
  // Due scadenze, e la differenza conta: **prima** del primo byte si aspetta
  // poco, perche il caso comune di un'attesa infinita e uno stdin ereditato e
  // muto (CI, un servizio) — e restare fermi trenta secondi in silenzio e la
  // cosa che fa credere a chi guarda che il comando sia piantato. **Dopo** il
  // primo byte si aspetta a lungo, perche un produttore vero (`pass show`,
  // `gpg -d`, un blob grosso) puo metterci. La scadenza si rinnova a ogni
  // chunk: un flusso lungo non e un flusso fermo.
  let deadline = Date.now() + primoByteMs;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buf, 0, buf.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EOF') break;
      if (code !== 'EAGAIN') throw error;
      if (Date.now() > deadline) {
        throw new Error(
          visto === 0
            ? `stdin non ha prodotto niente entro ${Math.round(primoByteMs / 1000)}s`
            : `stdin si e fermato dopo ${visto} byte e non ha chiuso entro ${Math.round(poiMs / 1000)}s`,
        );
      }
      Atomics.wait(wait, 0, 0, 20); // 20ms, senza bruciare la CPU
      continue;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
    visto += read;
    deadline = Date.now() + poiMs;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readKeyFromStdin(): string | undefined {
  if (isatty(0)) return undefined;
  const value = readAllStdin().trim();
  return value === '' ? undefined : value;
}

async function cmdInit(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      hardened: { type: 'boolean' },
      force: { type: 'boolean' },
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'light-model': { type: 'string' },
      'api-key': { type: 'string' },
      local: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (!values.local && positionals.length > 0) {
    process.stderr.write(`muffin init: argomento posizionale "${positionals[0]}" ha senso solo con --local\n`);
    return 78;
  }

  const providerFlag = values.provider as ProviderKind | undefined;
  if (providerFlag && providerFlag !== 'anthropic' && providerFlag !== 'openai-compat') {
    process.stderr.write(`--provider deve essere anthropic o openai-compat\n`);
    return 78;
  }

  // --local (DAY-1 requirement A9): a throwaway second home for a "fresh install"
  // rehearsal, resolved and guarded before anything below reads or writes
  // through it. `home` replaces every default `paths().home` call for the
  // rest of this function; when `--local` is absent it is that same default,
  // so the non-local path behaves exactly as before.
  const realHome = paths().home;
  let home = realHome;
  if (values.local) {
    const local = resolveLocalHome(positionals[0]);
    if (isSameOrNestedPath(local, realHome)) {
      process.stderr.write(
        `--local ${local} coincide con la home reale (${realHome}) o ci sta dentro — rifiuto.\n` +
          `Scegli una directory fuori da ${realHome}.\n`,
      );
      return 78;
    }
    home = local;
  }

  // "Durante l'installazione deve capire la macchina" (owner, verbatim) —
  // before any question, not instead of doctor. `SandboxExecutor.verify()`
  // runs a real init + contained round trip through the SAME door the runtime
  // uses (`SandboxManager`), not just the narrower probe — until now only
  // `muffin doctor` ever read even the narrower result, so a first run learned
  // about a broken sandbox by running a *second* command; a probe-only read
  // here would also have missed the 26/08/2026 container where the probe was
  // green and the real invocation still could not mount `/proc`. Headless is
  // untouched: nothing here prints or blocks off a TTY.
  if (process.stdin.isTTY) {
    const sandboxExecutor = new SandboxExecutor({ denyWrite: [], denyRead: [] });
    process.stderr.write(describeSandboxProbe(await sandboxExecutor.verify()));
    await sandboxExecutor.close();
    process.stderr.write(describeSupervisor(process.platform));
  }

  // Acquire the key: flag > env > an already-stored secret > an interactive
  // prompt on a terminal. A missing key is not fatal — runInit records the step
  // as incomplete and the user can re-run — but on a TTY we ask rather than
  // fail, which is the whole point of a first run (the init.ts docstring
  // promised this; it was never implemented).
  //
  // The stored-secret step is what makes `muffin uninstall --yes && muffin init`
  // a loop again now that the key no longer has to sit in a `.env` the agent can
  // read: `--persist` put it outside the home the wipe reaches, so the chain
  // answers and nothing is prompted or copied. `--local` reads that very same
  // chain against its own `home` below — never a copy (ADR-0030's `--local`
  // amendment).
  // **Mai da argv** (direttiva owner 2026-08-18, ADR-0048 §revisione). Un valore
  // in `argv` sta nella shell history e nel `ps` di chiunque sulla macchina, ed
  // è un segreto anche prima di essere registrato nel backend: `--api-key
  // CHIAVE` non è deprecato con un avviso — è **rifiutato**, perché un avviso
  // arriva quando la chiave è già finita nella history. Stessa forma che
  // `muffin secret set` ha sempre avuto (vedi `cmdSecret`).
  if (values['api-key'] !== undefined) {
    process.stderr.write(
      `--api-key non accetta piu un valore: una chiave in argv finisce nella shell history e nel ps di chiunque.\n` +
        `  Passala da stdin:  echo -n "$KEY" | muffin init\n` +
        `  Oppure lancia muffin init in un terminale e incollala al prompt nascosto.\n` +
        `  Se e gia stata usata cosi, ruotala.\n`,
    );
    return 78;
  }
  // **Nemmeno dall'environment** (decisione owner 2026-08-18). `environ` ha
  // permessi piu stretti di `cmdline`, ma la forma non cambia: un env generico
  // e un vettore generico, e la garanzia dice che il valore va dal backend dei
  // segreti al consumatore privilegiato al sink di autenticazione, senza
  // passare da model, env generico, argv, risultati di tool, DB, log, superfici
  // o approvazioni. Fail closed, e il messaggio nomina **solo la variabile**:
  // mai il valore, mai la lunghezza, mai un prefisso.
  if (process.env['MUFFIN_API_KEY'] !== undefined) {
    /**
     * Si rifiuta **la sorgente**, non il comando.
     *
     * La distinzione e' stata misurata sull'installazione dell'owner il
     * 27/08: la chiave era gia' registrata e valida — `doctor` diceva `✓ api
     * key secret://provider_api_key (persistent), 73 chars` — la variabile
     * d'ambiente era un residuo che non c'entrava con l'operazione richiesta, e
     * `init` si e' rifiutato di fare **qualunque cosa**, uscendo 78.
     *
     * Fail-closed sulla sorgente resta intero: quel valore non viene letto ne'
     * qui ne' altrove, ed e' l'unica cosa che la decisione dell'owner del 18/08
     * chiedeva. Rifiutare anche il comando non aggiungeva nessuna garanzia —
     * aggiungeva un'installazione che non si puo' riparare finche' qualcuno non
     * si ricorda di una variabile esportata mesi prima.
     *
     * L'avvertimento resta forte e resta primo, perche' una variabile
     * d'ambiente con dentro una chiave e' comunque una chiave da ruotare.
     */
    // Ogni nome, non uno: questa riga gira prima che esista un `config.json`,
    // quindi non c'e' ancora un provider da cui dedurre come si chiami la chiave.
    const dove = values.local === undefined ? paths().home : home;
    const gia = ALL_API_KEY_NAMES.map((n) => locateSecret(`secret://${n}`, dove)).find((l) => l !== null) ?? null;
    process.stderr.write(
      `MUFFIN_API_KEY non e piu una sorgente supportata: l'environment e un vettore generico, e un segreto non ci passa.\n` +
        `  Togli la variabile dall'ambiente (e dalla shell rc, se e li) e ruota la chiave se e stata esposta.\n`,
    );
    if (gia === null) {
      process.stderr.write(
        `  Registrala una volta:  echo -n "$KEY" | muffin secret set ${LEGACY_API_KEY_NAME} --persist\n` +
          `  Oppure passala a init:  echo -n "$KEY" | muffin init\n`,
      );
      return 78;
    }
    // Una chiave registrata c'e' gia': il comando non ha bisogno di quella
    // variabile per fare il suo lavoro, e fermarsi qui non protegge niente.
    process.stderr.write(`  (una chiave registrata c'e' gia' in ${gia.path} — proseguo senza guardare la variabile)\n`);
  }
  // stdin quando non e un terminale: il percorso di script e CI, lo stesso che
  // `secret set` usa da sempre.
  let apiKey: string | undefined;
  try {
    apiKey = readKeyFromStdin();
  } catch (error) {
    // Come `cmdSecret`: uno stack trace di Node non e un messaggio, e questa e
    // la prima cosa che una macchina nuova vede.
    process.stderr.write(`non riesco a leggere stdin: ${error instanceof Error ? error.message : String(error)}\n`);
    return 78;
  }
  const stored = apiKey
    ? null
    : (ALL_API_KEY_NAMES.map((n) => locateSecret(`secret://${n}`, home)).find((l) => l !== null) ?? null);
  if (stored) {
    process.stderr.write(`✓ chiave già presente (${stored.backend}): ${stored.path}\n`);
  }

  // Locale-o-API (owner, verbatim: "chiedere se si vuole andare in locale o in
  // API") — asked only when nothing already answers it: an explicit
  // --provider/--base-url, or a key already on file (fresh or stored), both
  // already decide the provider under ADR-0036, and asking again would be
  // exactly the "decide silently, then ask anyway" shape that ADR forbids in
  // the other direction. `askLocalOrApi` itself only runs when a probe found
  // something to offer, so there is never a question with one real answer.
  let localRuntime: { baseUrl: string; models: readonly string[] } | undefined;
  if (process.stdin.isTTY && !providerFlag && values['base-url'] === undefined && !apiKey && !stored) {
    // L'endpoint sondato e' sovrascrivibile, e non e' una comodita': senza,
    // *cosa* questo ramo esercita dipende da se chi lo esegue ha ollama acceso.
    // E' precisamente cosi' che il blocco su Ctrl+D e' rimasto invisibile —
    // con ollama spento la domanda sul runtime non esiste, e la seconda
    // domanda diventa la prima. Serve anche a chi tiene un runtime su una
    // porta diversa da quella indovinata.
    const probe = await probeLocalRuntime(process.env['MUFFIN_LOCAL_RUNTIME_URL'] ?? DEFAULT_LOCAL_RUNTIME_URL);
    if (probe.available) localRuntime = await askLocalOrApi(probe);
  }

  if (!localRuntime && !apiKey && !stored && process.stdin.isTTY) {
    process.stderr.write(keyHint(providerFlag, values['base-url']));
    apiKey = await promptSecret('Chiave API (nascosta — incollala, o invio per saltare): ');
  }

  // A local runtime needs no key from the owner, but `readSecret` at boot
  // (agent/runtime.ts) still requires *something* to be on file for
  // `provider.apiKeyRef` — an empty secret is a hard failure there, not a
  // degrade. Writing this placeholder through the same `apiKey` option a real
  // key travels through is not new secret-handling, just a harmless value
  // flowing through the existing one; skipped whenever a real key already
  // answers (fresh, stored, or the owner pasted one instead of going local).
  if (localRuntime && !apiKey && !stored) {
    apiKey = 'local-runtime-no-key-needed';
  }

  // Caught regardless of --provider: a pasted Telegram token is not a key for
  // any provider, so there is no reading of an explicit flag that should still
  // let it through and fail confusingly at the first call to the model.
  if (apiKey && looksLikeTelegramToken(apiKey)) {
    process.stderr.write(
      `! sembra il token di un bot Telegram, non una chiave del modello — non la salvo.\n` +
        `  La chiave del modello è OpenRouter (sk-or-…) o Anthropic (sk-ant-…): https://openrouter.ai/keys\n` +
        `  Il token del bot va altrove: muffin secret set telegram_token\n`,
    );
    apiKey = undefined;
  }

  // The provider is inferred from the key's prefix, so a key that is only
  // *stored* still has to be looked at — otherwise the dev loop this whole
  // change exists to preserve would start writing `anthropic` for an OpenRouter
  // key the moment the `.env` went away. Read, never printed, never re-written
  // (`runInit` gets no `apiKey`, so nothing is copied). One function decides
  // (`chooseProvider`) and one function says what it decided
  // (`describeProviderChoice`) — ADR-0036: ask only what cannot be inferred,
  // and never decide silently.
  const keyForInference = apiKey ?? (stored ? readFileSync(stored.path, 'utf8').trim() : undefined);
  // `localRuntime` already decided the provider (a probe, not a key prefix) —
  // `chooseProvider` never sees it, same as an explicit --provider always
  // wins over inference. `describeProviderChoice` still says it out loud
  // through the same call, via the 'local' reason.
  const choice = localRuntime
    ? { provider: 'openai-compat' as const, baseUrl: localRuntime.baseUrl, reason: 'local' as const }
    : chooseProvider(providerFlag, keyForInference, values['base-url']);
  process.stderr.write(describeProviderChoice(choice, keyForInference));

  // Modello (owner, verbatim: "chiedere che modello si vuole usare") — asked
  // only when nothing already names one, and only on a TTY; headless keeps
  // today's compiled default from `defaultModels`. Anthropic diretto gets no
  // question at all: one family, nothing to choose among.
  let mainModel = values.model;
  let lightModel = values['light-model'];
  let modelReason: ModelChoiceReason = mainModel || lightModel ? 'explicit' : 'default';
  if (!mainModel && process.stdin.isTTY) {
    const pick = localRuntime
      ? await askModelChoice(
          localModelChoices(localRuntime.models),
          `\nModello (tra quelli offerti da ${localRuntime.baseUrl}):`,
        )
      : choice.provider === 'openai-compat'
        ? await askModelChoice(OPENROUTER_MODEL_FAMILIES, '\nChe famiglia di modello?')
        : undefined;
    if (pick) {
      mainModel = pick.main;
      lightModel ??= pick.light;
      modelReason = 'chosen';
    }
  }
  const resolvedModels = defaultModels({
    provider: choice.provider,
    ...(mainModel ? { mainModel } : {}),
    ...(lightModel ? { lightModel } : {}),
  });
  process.stderr.write(describeModelChoice(resolvedModels.main, resolvedModels.light, modelReason));

  const steps = runInit({
    ...(values.hardened ? { hardened: true } : {}),
    ...(values.force ? { force: true } : {}),
    provider: choice.provider,
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
    ...(mainModel ? { mainModel } : {}),
    ...(lightModel ? { lightModel } : {}),
    ...(apiKey ? { apiKey } : {}),
    // The interactive owner flow has one durable source of truth. `runInit`
    // keeps its home default for isolated programmatic fixtures and legacy API
    // callers; the public CLI must not create a competing copy.
    secretBackend: 'persistent',
    home,
  });

  for (const s of steps) process.stderr.write(`${s.done ? '✓' : '!'} ${s.name.padEnd(16)} ${s.detail}\n`);
  const incomplete = steps.filter((s) => !s.done);
  if (incomplete.length > 0) {
    process.stderr.write(`\nRilancia \`muffin init\` quando è risolto — riprende da dove si era fermato.\n`);
    return 1;
  }

  if (values.local) {
    // Never `offerGateway()` here: it installs a *system* unit pointed at
    // `paths().home` unconditionally (`cli/gateway.ts`'s `planUnit`) — the
    // real home, not this one — which is exactly backwards for a directory
    // that exists to be thrown away.
    process.stderr.write(`\nPer usarla: export MUFFIN_HOME=${home}\n`);
  } else {
    await offerGateway();
  }
  process.stderr.write(`\nOra: muffin doctor\n`);
  return 0;
}

/**
 * The one question that decides whether Muffin is a process or a command.
 *
 * ADR-0035 says to print the unit rather than enable it silently, and that is
 * right about consent and wrong about ergonomics: a manual step at the end of a
 * setup is a step nobody takes — owner, verbatim, about exactly these commands:
 * *"non lancerò mai quei comandi a mano."* A gateway nobody installs leaves the
 * scheduler where it was, which is the defect this whole slice exists to close.
 *
 * So it is asked here, once, inside a setup the owner is already sitting
 * through — still their explicit act, just at the moment they are present. Off
 * a TTY it prints the command instead and installs nothing: `promptLine`
 * returns undefined on a pipe, which is the same rule `cmdInit` uses for the
 * API key and `install.sh` uses for the wizard. An installer that wrote a
 * service unit into a scripted run would be doing exactly what the ADR forbids.
 */
async function offerGateway(): Promise<void> {
  const answer = await promptLine(
    '\nInstallo il gateway, così i job girano anche a finestra chiusa? [Y/n] ',
  );
  if (answer === undefined) {
    process.stderr.write(`\nPer far girare i job senza una finestra aperta:\n  muffin gateway install --write\n`);
    return;
  }
  if (answer !== '' && !/^(y(es)?|s(i|ì)?)$/i.test(answer)) {
    // `--start` nominato qui e non eseguito sopra: è la stessa distinzione
    // della riga sotto, vista dall'altro lato. Chi dice no adesso deve poter
    // sapere che esiste un comando solo, non quattro da copiare.
    process.stderr.write(`Va bene. Quando vuoi:\n  muffin gateway install --start\n`);
    return;
  }
  // `--write` and not the enable: writing the file is what the owner just
  // agreed to, and loading it into the supervisor stays their command. The
  // difference matters — one is a file in their home, the other is a service.
  await cmdGatewayInstall(paths().home, ['--write']);
}

/**
 * A bare `muffin` with no config is someone's first run. Ask before doing
 * anything (Hermes' pattern — not a silent launch, not a bare error), and off a
 * terminal print the one command to run instead of hanging on a pipe.
 */
async function firstRun(): Promise<number> {
  const answer = await promptLine('Muffin non è ancora configurato su questa macchina. Lo configuro ora? [Y/n] ');
  if (answer === undefined) {
    process.stderr.write('Muffin non è configurato. Esegui:\n  muffin init\n');
    return 78;
  }
  if (answer !== '' && !/^(y(es)?|s(i|ì)?)$/i.test(answer)) {
    process.stderr.write('Esegui `muffin init` quando vuoi.\n');
    return 0;
  }
  const code = await cmdInit([]);
  if (code !== 0) return code; // init ha già detto cosa manca
  process.stderr.write('\nAvvio Muffin.\n');
  return runRepl();
}

async function cmdUninstall(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean' } }, allowPositionals: false });
  const home = paths().home;
  if (!existsSync(home)) {
    process.stderr.write(`Niente da rimuovere: ${home} non esiste.\n`);
    return 0;
  }
  // Deleting keys and memory is not something a pipe should trigger by accident.
  if (!values.yes) {
    const answer = await promptLine(`Cancello ${home} e tutto il suo contenuto — config, chiavi, memoria? [y/N] `);
    if (answer === undefined) {
      process.stderr.write(`Rifiuto di cancellare senza conferma su una pipe. Rilancia con --yes.\n`);
      return 78;
    }
    if (!/^(y(es)?|s(i|ì)?)$/i.test(answer)) {
      process.stderr.write(`Annullato.\n`);
      return 0;
    }
  }
  // Every backend, not the first one that answers: a home copy shadows the
  // persistent one in the read chain, and the whole point of this line is the
  // copy that the wipe does *not* reach.
  // Ogni nome, e ogni backend. Una copia persistente che sopravvive alla
  // cancellazione va nominata anche se sta sotto un nome che questa
  // installazione non usava piu': e' esattamente la credenziale che
  // resterebbe li senza che nessuno se lo ricordi.
  const persistent = ALL_API_KEY_NAMES.flatMap((n) => locateSecretAll(`secret://${n}`, home)).find(
    (l) => l.backend === 'persistent',
  );
  rmSync(home, { recursive: true, force: true });
  process.stderr.write(`Rimosso ${home}.\n`);
  // The message used to say "config, keys, memory" and that is now half true:
  // a `--persist` key lives outside this directory on purpose — it is what makes
  // `uninstall && init` a loop instead of a re-paste. Saying so is the price of
  // the convenience; an uninstall that quietly leaves a credential behind is the
  // kind of surprise that ends trust in the command.
  if (persistent) {
    process.stderr.write(
      `La chiave persistente resta: ${persistent.path}\n` +
        `  (è ciò che fa ritrovare la chiave a \`muffin init\`; cancellala a mano se non la vuoi)\n`,
    );
  }
  process.stderr.write(`Il comando muffin resta installato; per rimuovere anche quello: ./install.sh --uninstall\n`);
  return 0;
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, online: { type: 'boolean' } },
    allowPositionals: false,
  });
  const report = await runDoctor(paths().home, values.online ? { online: true } : {});
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const style = styleFor(process.stdout);
    // L'intestazione dice **dove comincia questo comando**: senza, l'output di
    // `doctor` e quello del comando prima sono un blocco solo, e in uno
    // scrollback lungo non c'e' modo di dire dove finisce uno e comincia
    // l'altro. Mai in `--json`, che ha un solo lettore e non e' umano.
    process.stdout.write(`${style.header('muffin doctor', paths().home)}\n${formatReport(report, style)}\n`);
  }
  return report.exitCode;
}

function cmdRot(argv: string[]): number {
  const [sub] = argv;
  let mode: 'hardened' | 'single-user' = 'single-user';
  try {
    mode = loadConfig().rot.mode;
  } catch (error) {
    process.stderr.write(`${(error as ConfigError).message}\n`);
    return 78;
  }

  if (sub === 'verify') {
    const outcome = verify(paths().home, mode);
    if (outcome.ok) {
      process.stdout.write(`root of trust intact: ${outcome.fileCount} files, mode ${outcome.mode}\n`);
      return 0;
    }
    process.stderr.write(
      `root of trust diverged (${outcome.reason}):\n` +
        outcome.diverged.map((f) => `  ${f}\n`).join('') +
        `→ ${outcome.remedy}\n`,
    );
    return outcome.action === 'refuse' ? 2 : 1;
  }

  if (sub === 'reseal') {
    // The one failure this command was built to produce, and the only one it
    // used to answer with a Node stack trace.
    //
    // `muffin rot harden` tells the owner, correctly, that after hardening
    // "`muffin rot reseal` ti servirà un privilegio che oggi non ti serve"
    // (`core/rot/harden.ts`). Following that advice and forgetting `sudo` is
    // therefore the expected mistake, not an exotic one — and `main()` has no
    // top-level catch, so the reward for doing what we asked was a raw
    // `Error: EACCES` with a stack. Named by the judge on PR #138.
    try {
      const manifest = seal(paths().home, '1', new Date());
      process.stdout.write(`resealed ${manifest.files.length} files — the change is now yours and declared\n`);
      return 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        process.stderr.write(
          `non posso riscrivere il sigillo in ${paths().home}/rot: permesso negato.\n` +
            'Se hai reso vera la modalità hardened, il RoT non è più tuo ed è voluto: ' +
            'rifai questo comando con il privilegio che serve (es. `sudo`).\n',
        );
        return 77; // EX_NOPERM
      }
      process.stderr.write(`reseal fallito: ${(error as Error).message}\n`);
      return 74; // EX_IOERR
    }
  }

  if (sub === 'harden') {
    // Explains and proposes, never executes — see core/rot/harden.ts. Every
    // line of the plan goes to stdout ("stdout carries the answer", this
    // file's own header above), the same as `muffin doctor`: this command's
    // whole job is the printed report, not a side comment on some other
    // action.
    const plan = buildHardenPlan(paths().home, mode);
    process.stdout.write(formatHardenPlan(plan));
    if (!plan.owner.known) return 2;
    return plan.done ? 0 : 1;
  }

  process.stderr.write(`usage: muffin rot verify | reseal | harden\n`);
  return 78;
}

async function cmdMemory(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;

  if (sub === 'why') {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`usage: muffin memory why <fact-id>\n`);
      return 78;
    }
    return cmdMemoryWhy(home, id);
  }

  if (sub === 'stats') return cmdMemoryStats(home);

  if (sub === 'review') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { verbose: { type: 'boolean' } },
      allowPositionals: true,
    });
    const [verb, id] = positionals;
    if (verb === undefined) return cmdMemoryReview(home, values.verbose === true);
    if (verb !== 'keep') {
      process.stderr.write(`usage: muffin memory review [keep <fact-id>] [--verbose]\n`);
      return 78;
    }
    const factId = Number(id);
    if (!Number.isInteger(factId) || factId <= 0) {
      process.stderr.write(`usage: muffin memory review keep <fact-id>\n`);
      return 78;
    }
    return cmdMemoryReviewKeep(home, factId);
  }

  if (sub === 'extract') {
    const { values } = parseArgs({ args: rest, options: { limit: { type: 'string' } } });
    return cmdMemoryExtract(home, Number(values.limit ?? 200));
  }

  if (sub === 'check') {
    const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
    return cmdMemoryCheck(home, values.json === true);
  }

  if (sub === 'pin' || sub === 'unpin') {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write(`usage: muffin memory ${sub} <fact-id>\n`);
      return 78;
    }
    return sub === 'pin' ? cmdMemoryPin(home, id) : cmdMemoryUnpin(home, id);
  }

  if (sub === 'search') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        n: { type: 'string', short: 'n' },
        history: { type: 'boolean' },
        'as-of': { type: 'string' },
        surface: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        around: { type: 'string' },
      },
      allowPositionals: true,
    });
    const query = positionals.join(' ').trim();
    if (query === '') {
      process.stderr.write(`usage: muffin memory search "<query>"\n`);
      return 78;
    }
    // Parsed here rather than deeper down, and rejected rather than coerced: a
    // date SQLite cannot compare turns every temporal predicate false, and the
    // search would come back empty looking like "I never knew that" instead of
    // like "you typed a date I cannot read".
    const asOf = normaliseDate(values['as-of'], 'end');
    const since = normaliseDate(values.since, 'start');
    const until = normaliseDate(values.until, 'end');
    for (const [flag, raw, parsed] of [
      ['--as-of', values['as-of'], asOf],
      ['--since', values.since, since],
      ['--until', values.until, until],
    ] as const) {
      if (raw !== undefined && parsed === undefined) {
        process.stderr.write(`${flag}: "${raw}" non è una data leggibile (usa 2026-05 o 2026-05-14)\n`);
        return 78;
      }
    }
    // Semantic checks, once every raw string has already parsed: a window that
    // can never contain anything, and an instant that has not happened yet.
    // Both would otherwise reach `recall()` and come back with either zero rows
    // (indistinguishable from amnesia) or today's facts (a prediction wearing a
    // memory's clothes) — `--history` resolves to `EVERY_INSTANT` here only to
    // keep that value out of the future check, which exempts it by name.
    const windowError = checkTemporalWindow({ asOf: asOf ?? (values.history ? EVERY_INSTANT : undefined), since, until });
    if (windowError === 'empty-window') {
      process.stderr.write(`--since è dopo --until: quella finestra non può contenere niente\n`);
      return 78;
    }
    if (windowError === 'future-asof') {
      process.stderr.write(`--as-of è nel futuro: posso raccontare solo cosa credevo, non cosa crederò\n`);
      return 78;
    }
    return cmdMemorySearch(home, query, {
      ...(values.n ? { limit: Number(values.n) } : {}),
      ...(values.history ? { history: true } : {}),
      ...(asOf ? { asOf } : {}),
      ...(values.surface ? { surface: values.surface } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(values.around ? { around: Number(values.around) } : {}),
    });
  }

  process.stderr.write(MEMORY_USAGE);
  return 78;
}

/**
 * `prompt` has two sub-verbs: `show`, what the model would really receive, and
 * `version`, which of the two assemblies it receives. A dispatcher rather than
 * a top-level `cmdPromptShow` in the switch above so a further sub-verb (say,
 * `prompt diff` against a previous snapshot) has somewhere to land without
 * touching `main`'s own switch again — the same shape `cmdMemory`/`cmdVault`
 * already use for their own sub-verbs.
 */
function cmdPrompt(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub === 'show') return cmdPromptShow(paths().home, rest);
  if (sub === 'version') return cmdPromptVersion(paths().home, rest);
  process.stderr.write(PROMPT_USAGE);
  return 78;
}

async function cmdVault(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { tier: { type: 'string' } },
    allowPositionals: true,
  });

  const tier = Number(values.tier ?? 0);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    process.stderr.write(`--tier deve essere 0, 1, 2 o 3\n`);
    return 78;
  }

  if (sub === 'reindex') return cmdVaultReindex(home, tier as TrustTier);
  if (sub === 'ls') return cmdVaultLs(home);
  if (sub === 'check') return cmdVaultCheck(home);
  if (sub === 'add') {
    const file = positionals[0];
    if (!file) {
      process.stderr.write(`usage: muffin vault add <file> [--tier N]\n`);
      return 78;
    }
    return cmdVaultAdd(home, file, tier as TrustTier);
  }

  process.stderr.write(VAULT_USAGE);
  return 78;
}

async function cmdGateway(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'run') return cmdGatewayRun(home);
  if (sub === 'status' || sub === undefined) return cmdGatewayStatus(home);
  if (sub === 'turn' && rest[0]) return cmdGatewayTurn(home, rest[0]);
  if (sub === 'stop') return cmdGatewayStop(home);
  if (sub === 'start') return cmdGatewayStart(home);
  if (sub === 'restart') return cmdGatewayRestart(home);
  if (sub === 'install') return cmdGatewayInstall(home, rest);
  process.stderr.write(GATEWAY_USAGE);
  return 78;
}

function cmdJobs(argv: string[]): number {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) return cmdJobsList(home);
  if (sub === 'add') return cmdJobsAdd(home, rest);
  if (sub === 'cap' && rest[0] && rest[1]) return cmdJobsCap(home, rest[0], rest[1]);
  if (sub === 'remove' && rest[0]) return cmdJobsRemove(home, rest[0]);
  process.stderr.write(JOBS_USAGE);
  return 78;
}

async function cmdMcp(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) {
    return cmdMcpList(home, rest.includes('--verify'));
  }
  if (sub === 'remove' && rest[0]) return cmdMcpRemove(home, rest[0]);
  if (sub === 'add' && rest[0]) {
    const name = rest[0];
    // Everything after `--` is the server's own command line, untouched — its
    // flags are not ours to parse. Before it: only repeatable --env K=V.
    const sep = rest.indexOf('--');
    const flags = sep === -1 ? rest.slice(1) : rest.slice(1, sep);
    const commandLine = sep === -1 ? [] : rest.slice(sep + 1);
    const env: Record<string, string> = {};
    const hosts: string[] = [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--host' && flags[i + 1] !== undefined) {
        hosts.push(flags[i + 1]!);
        i++;
        continue;
      }
      if (flags[i] !== '--env' || !flags[i + 1]?.includes('=')) {
        process.stderr.write(MCP_USAGE);
        return 78;
      }
      const eq = flags[i + 1]!.indexOf('=');
      const key = flags[i + 1]!.slice(0, eq);
      const value = flags[i + 1]!.slice(eq + 1);
      // Solo riferimenti, mai valori (direttiva owner 2026-08-18): `--env
      // GITHUB_TOKEN=ghp_…` metteva il token nel `ps` di chiunque e nella shell
      // history, ed era l'unico modo documentato di dare una chiave a un server
      // MCP. Ora si registra con `muffin secret set` (stdin) e qui viaggia il
      // nome: `--env GITHUB_TOKEN=secret://mcp_gh_token`, risolto al momento
      // della connessione dentro il sink privilegiato (`core/mcp/connect.ts`).
      if (!value.startsWith('secret://')) {
        process.stderr.write(
          `--env ${key}=… non accetta un valore: finirebbe nel ps di chiunque e nella shell history.\n` +
            `  Registra il segreto:  echo -n "$TOKEN" | muffin secret set mcp_${key.toLowerCase()}\n` +
            `  Poi passa il riferimento:  --env ${key}=secret://mcp_${key.toLowerCase()}\n` +
            `  Un valore che non è un segreto (un flag, un percorso) mettilo negli argomenti del comando, dopo --.\n`,
        );
        return 78;
      }
      env[key] = value;
      i++;
    }
    return cmdMcpAdd(home, name, commandLine[0], commandLine.slice(1), env, hosts, {
      out: (l) => process.stdout.write(`${l}\n`),
      // Stessa guardia di `muffin search`: solo su un terminale vero si chiede
      // conferma, mai su una pipe/script/il figlio non-TTY di `sys.shell`.
      ...(isatty(0) ? { chiediConferma: (domanda: string) => promptLine(domanda) } : {}),
    });
  }
  process.stderr.write(MCP_USAGE);
  return 78;
}

async function cmdSurface(argv: string[]): Promise<number> {
  const [sub, id, ...rest] = argv;
  const home = paths().home;
  if (sub === 'list' || sub === undefined) return cmdSurfaceList(home);
  if (sub === 'enable' && id) {
    const { values } = parseArgs({
      args: rest,
      options: { owner: { type: 'string' }, 'api-base': { type: 'string' } },
    });
    return cmdSurfaceEnable(
      home,
      id,
      values.owner,
      values['api-base'],
      isatty(0) ? (question) => promptSecret(question) : undefined,
    );
  }
  if (sub === 'disable' && id) return cmdSurfaceDisable(home, id);
  // ADR-0060: la manopola che `surfaces.default` dichiarava da sempre e che
  // nessun comando poteva girare.
  if (sub === 'default' && id) return cmdSurfaceDefault(home, id);
  process.stderr.write(SURFACE_USAGE);
  return 78;
}

function cmdSecret(argv: string[]): number {
  const [sub, ...rest] = argv;
  const name = rest.find((a) => !a.startsWith('-'));
  if (sub !== 'set' || !name) {
    process.stderr.write(`usage: muffin secret set NAME  (value on stdin)\n`);
    return 78;
  }
  // Read from stdin, never from argv: a key in a shell argument is a key in the
  // shell history and in every `ps` on the machine.
  let value = '';
  try {
    value = readAllStdin().trim();
  } catch (error) {
    // Un errore di lettura non e «nessun valore»: dirlo com'e, invece di
    // suggerire una pipe che l'utente ha appena usato.
    process.stderr.write(`non riesco a leggere stdin: ${error instanceof Error ? error.message : String(error)}\n`);
    return 78;
  }
  if (!value) {
    process.stderr.write(`no value on stdin — pipe it: echo -n "$KEY" | muffin secret set ${name}\n`);
    return 78;
  }
  // The durable store is the sole target for a newly supplied value. `--persist`
  // remains accepted as a compatibility no-op, never a choice an owner needs.
  const at = writeAuthoritativeSecret(name, value, paths().home);
  process.stdout.write(`stored ${name} (0600), ${value.length} chars → ${at}\n`);
  // A legacy installation may still have a second copy under its old home.
  // Do not silently pretend that it disappeared: make the remaining migration
  // visible, but never create a new competing copy from this command.
  const copies = locateSecretAll(`secret://${name}`, paths().home);
  const winner = copies[0];
  if (copies.length > 1 && winner) {
    process.stderr.write(
      winner.path === at
        ? `! esiste anche ${copies[1]?.path}, che da ora non viene più letta — cancellala, così resta una sola chiave da ruotare\n`
        : `! questa copia non verrà mai usata: ${winner.path} ha la precedenza. Cancella quella che non vuoi (${winner.path}), oppure riscrivi il segreto lì\n`,
    );
  }
  return 0;
}

function cmdTrace(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub !== 'tail' && sub !== 'grep' && sub !== 'turn') {
    process.stderr.write(
      `usage: muffin trace tail [-n N] [--errors] | muffin trace grep PATTERN | muffin trace turn <id>\n`,
    );
    return 78;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      n: { type: 'string', short: 'n' },
      errors: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const pattern = sub === 'grep' ? positionals[0] : undefined;
  if (sub === 'grep' && !pattern) {
    process.stderr.write(`usage: muffin trace grep PATTERN\n`);
    return 78;
  }
  // `turn` takes the id a finished turn prints — twelve characters of the
  // thirty-two, matched as a prefix in `readSpans`. It replaces an undocumented
  // `--trace` flag that took the *whole* id and so could never be fed the one
  // the product hands you.
  const turnId = sub === 'turn' ? positionals[0] : undefined;
  if (sub === 'turn' && !turnId) {
    process.stderr.write(`usage: muffin trace turn <id>   (l'id che il turno stampa: "trace c22cb4445952")\n`);
    return 78;
  }

  const spans = readSpans(paths().home, {
    // A turn is asked for whole: its own steps, not the last N of them.
    limit: turnId ? 10_000 : Number(values.n ?? 40),
    ...(pattern ? { pattern } : {}),
    ...(turnId ? { traceId: turnId } : {}),
    ...(values.errors ? { errorsOnly: true } : {}),
  });

  if (spans.length === 0) {
    process.stderr.write(turnId ? `nessuno span per il turno ${turnId}\n` : `no spans matched\n`);
    return 1;
  }
  process.stdout.write(
    values.json
      ? `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`
      : turnId
        ? formatTurn(spans)
        : `${spans.map(formatSpan).join('\n')}\n`,
  );
  return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
      session: { type: 'string' },
      timeout: { type: 'string' },
      // Ripetibile: piu' immagini nello stesso turno sono un caso normale
      // («cosa e' cambiato fra queste due?») ed entrambe le API lo prevedono.
      image: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  });
  const goal = positionals.join(' ').trim();
  if (goal === '') {
    process.stderr.write(`usage: muffin run "<goal>" [--image FILE]\n`);
    return 78;
  }
  return runHeadless({
    goal,
    ...(values.json ? { json: true } : {}),
    ...(values.session ? { sessionId: values.session } : {}),
    ...(values.timeout ? { timeoutSeconds: Number(values.timeout) } : {}),
    ...(values.image && values.image.length > 0 ? { images: values.image } : {}),
  });
}

/**
 * The last line of defence, and the reason it is here rather than at the third
 * call site that needed it.
 *
 * Three separate reviews found the same shape: a command hits an ordinary
 * filesystem error — `EACCES` resealing a root of trust that hardening has
 * correctly made read-only, `EACCES` reading a defaults file — and the owner's
 * reward is a raw Node stack trace. Each time the repair was a `try/catch` at
 * that one call site, and each time the next new path arrived without it.
 * Catching per-site treats the symptom; the defect is that `main` could throw
 * at all.
 *
 * So: any error that reaches here becomes a sentence and an exit code. This is
 * a floor, not a substitute for handling — a command that knows *why* the error
 * happened still says so itself (see `cmdRot`'s reseal branch, which explains
 * that a denied write is the hardening working), and a per-item failure that
 * should only degrade one line of a report still has to be caught where that
 * line is built. What this guarantees is only that the worst case is readable.
 */
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  process.stderr.write(`muffin: ${err.message ?? String(error)}\n`);
  if (process.env.MUFFIN_DEBUG === '1' && err.stack) process.stderr.write(`${err.stack}\n`);
  else process.stderr.write('(per la traccia completa: MUFFIN_DEBUG=1)\n');
  process.exitCode = err.code === 'EACCES' || err.code === 'EPERM' ? 77 : 70; // EX_NOPERM / EX_SOFTWARE
}
