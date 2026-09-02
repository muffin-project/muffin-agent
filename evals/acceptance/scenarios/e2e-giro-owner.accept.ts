import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { describe } from 'vitest';
import { EXIT_STOPPED } from '../../../core/gateway/service.js';
import { planUnit } from '../../../core/gateway/unit.js';
import { install, until } from '../harness.js';
import { privateMessage, startFakeTelegram } from '../telegram.js';
import { scenario } from '../scenario.js';

/**
 * A10 · The owner's actual journey, one house, one scenario.
 *
 * Every other scenario in this suite proves one ring of the chain in
 * isolation: `install()` always runs a real `muffin init` (harness.ts), but
 * nothing ever asserted what it leaves behind; `a-lifecycle.accept.ts` proves
 * a gateway survives SIGKILL, never that `muffin gateway install` produces a
 * unit the platform's own parser accepts (`core/gateway/unit.test.ts` proves
 * the *generator*, not a scenario driving the *command*); `A5` proves
 * `doctor` catches tampering, never that a clean install's warnings are the
 * ones the owner is actually told to expect; `b-telegram-pairing.accept.ts`
 * proves pairing, but stops the moment an owner exists — it never asks for a
 * real answer; `c-memory.accept.ts` proves recall across two CLI processes,
 * never that a fact that arrived over Telegram is the thing being recalled.
 * `muffin uninstall` had no scenario at all.
 *
 * The claim under test is the sentence an owner would actually say: the
 * commands they type, **in the order they type them**, take a clean machine
 * to an agent that answers on a surface, with a gateway the platform's own
 * supervisor knows how to hold up — and `uninstall` leaves nothing behind
 * except what was explicitly `--persist`ed.
 *
 * ## Why one scenario and not eight
 *
 * Splitting this into eight scenarios would mean eight installs, eight
 * gateways, eight fake Telegram servers — and it would stop being able to
 * catch the one class of defect this file exists for: a ring that only
 * breaks because of what an *earlier* ring left behind (a doctor warning that
 * only appears because the gateway has not run yet, a secret backend order
 * that only matters because `init` already wrote one copy). That is the
 * "mechanism with green tests that no real path reaches" defect
 * (harness.ts's own docstring) one level up: each ring can be green in
 * isolation while the *journey* was never driven once, in order, by anything.
 *
 * ## What this scenario does not prove
 *
 * The macOS half of ring 4 is a *fallback*, and it says so at the assertion
 * that names it: this repository's production target is a Linux VPS
 * (AGENTS.md, `docs/work/day1/requirements-status.md` A1), and only the Linux leg drives
 * the unit through the platform's supervisor-verifying parser the way an
 * owner's `systemctl --user daemon-reload` eventually would. Neither leg ever
 * asks a real supervisor to hold a process up across a reboot — that is a
 * machine-level property no CI runner (and, on macOS specifically, no
 * sandboxed process on this machine — see ring 4 below) can prove.
 */

/** The Telegram-visible owner id `config.json` records once pairing lands. */
function ownerIdFromConfig(home: string): number | undefined {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      surfaces?: { telegram?: { ownerUserId?: number } };
    };
    return c.surfaces?.telegram?.ownerUserId;
  } catch {
    return undefined;
  }
}

describe('acceptance · A10 · il giro dell owner, dalla macchina pulita alla risposta', () => {
  scenario(
    'A10',
    async () => {
      const tg = await startFakeTelegram();
      // The fact the owner states over Telegram (ring 6) and the reply the
      // second, unrelated process (ring 7) is scripted to give once memory has
      // put it back in front of the model — two script entries, same shape as
      // c-memory.accept.ts's C1, because that is exactly the property being
      // reused: a fact said in one process is recalled by a later, unrelated
      // one. The gateway tick is accelerated (A1/b-telegram-pairing precedent)
      // so pairing and delivery do not have to wait out the real 30s beat —
      // the whole scenario has a ~30s budget of its own.
      const inst = await install({
        main: [
          { text: 'certo, il tuo piatto preferito da oggi è la carbonara ai ricci di mare' },
          { text: 'sì, i ricci di mare, me lo avevi detto tu' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        // === 1. Clean install — assert what exists, never assume it ==========
        //
        // `install()` already ran `muffin init` with the key on stdin. Every
        // other scenario in this suite takes that for granted; this is the one
        // that checks it instead of inheriting the assumption.
        if (!existsSync(inst.home)) throw new Error(`home non creata da \`muffin init\`: ${inst.home}`);
        if (!existsSync(join(inst.home, 'config.json'))) {
          throw new Error(`config.json assente dopo \`muffin init\` in ${inst.home}`);
        }
        if (!existsSync(join(inst.home, 'muffin.db'))) {
          throw new Error(`muffin.db assente dopo \`muffin init\` in ${inst.home}`);
        }
        // `rot/manifest.json` is the seal's own anchor (`cli/init.ts`'s `seal()`
        // call, `core/rot/readers.ts:262`) — its presence is what "sigillato"
        // means, not a folder that merely exists.
        if (!existsSync(join(inst.home, 'rot', 'manifest.json'))) {
          throw new Error(`rot/manifest.json assente — il root of trust non risulta sigillato in ${inst.home}`);
        }
        const homeSecretPath = join(inst.home, 'secrets', 'provider_api_key');
        if (!existsSync(homeSecretPath)) {
          throw new Error(`la chiave scritta da \`muffin init\` non è nella home — fixture rotta: ${homeSecretPath}`);
        }

        // === 2. The key through the real chain ================================
        //
        // A second copy, written with `--persist` (ADR-0039's backend, outside
        // `MUFFIN_HOME`). `SECRET_BACKENDS` (core/config/config.ts) puts `home`
        // first on purpose — a per-install secret must be able to shadow a
        // shared one — so this second copy is shadowed the moment it is
        // written, and `secret set` has to say so instead of storing it
        // silently (PR #124, `bde3c02`, landed on `dev` while this slice was
        // being written — the exact "note" this scenario's own brief warned
        // might still be missing).
        const persisted = await inst.muffin(
          ['secret', 'set', 'provider_api_key', '--persist'],
          'sk-acceptance-persisted-key\n',
        );
        if (persisted.code !== 0) {
          throw new Error(`\`secret set --persist\` non riuscito: exit ${persisted.code}\n${persisted.err}`);
        }
        if (!persisted.err.includes('non verrà mai usata')) {
          throw new Error(
            `\`secret set --persist\` non avvisa che la copia home ha la precedenza (SECRET_BACKENDS, ` +
              `core/config/config.ts):\n${persisted.err}`,
          );
        }
        if (!persisted.err.includes(homeSecretPath)) {
          throw new Error(`l'avviso non nomina la copia che vince davvero (${homeSecretPath}):\n${persisted.err}`);
        }
        // Resolve the duplicate the way the owner reading that warning would:
        // keep exactly one copy. The **persistent** one is kept alive on
        // purpose — it is what ring 8 needs to still be there after
        // `uninstall` wipes the home — so it is the home copy that gives way,
        // which is also what flips "shadowed" into "the only copy left,
        // reached through the same `locateSecret` chain, never a duplicate
        // read path".
        rmSync(homeSecretPath);

        // === 3. `muffin doctor`, green for the reason it should be =============
        //
        // Not "exit 0 or bust": a brand-new install legitimately warns before
        // the gateway has ever run or a turn has ever been written (unlike the
        // owner's own machine, mid-journey there is no consolidation history,
        // no vector index yet, no gateway process — ring 5 starts it later).
        // What has to be true is that every warning is one of *these*, named,
        // and that nothing is an outright `fail`.
        const doctor = await inst.muffin(['doctor']);
        if (doctor.code === 2) throw new Error(`doctor in fail al termine dell'installazione:\n${doctor.out}`);
        const warnLines = doctor.out.split('\n').filter((l) => l.startsWith('! '));
        const expectedWarnNames = [
          // single-user is the mode `muffin init` seals by default — the one
          // declared warning the DAY-1 requirements inventory names for the owner's own, fully-run
          // machine (detection without prevention).
          'root of trust mode',
          // No chunk has ever been indexed yet — nothing has been written to
          // recall from until ring 6.
          'vector index',
          // The consolidation sweep has never fired — it runs at the end of a
          // turn, and no turn has happened yet.
          'consolidamento',
          // Ring 5 has not started the gateway yet — this is deliberately the
          // *before* picture.
          'gateway',
          // `checkSupervisor` reads this machine's real launchd/systemd state
          // (core/gateway/supervisor.ts — it has to, "is a supervisor really
          // watching" is a machine-wide question, not a `MUFFIN_HOME`-scoped
          // one) — `ok` on a machine that already has a real Muffin
          // supervised, `warn` (never `fail`) on one that does not. Either is
          // legitimate and neither is this scenario's concern.
          'supervisore',
          // Una macchina che non può contenere lo dice qui, e da #129 lo dice
          // PRIMA di eseguire invece che dentro l'uscita di un job. È il caso
          // normale in un container (il kernel di molti host nega il mount di
          // /proc dentro lo userns), cioè proprio dove questo giro gira quando
          // lo lancia `gate-linux.sh`: rifiutarlo qui renderebbe A10 rossa su
          // ogni Linux containerizzato — la piattaforma di produzione — per un
          // fatto dell'ospite, non del prodotto. Ammesso, mai in silenzio: la
          // riga viene stampata sotto, con la ragione che doctor ha dato.
          'sandbox',
          // Riguarda il **checkout** che sta girando, non l'installazione sotto
          // esame: `ok` da un albero pulito, `warn` da uno con modifiche non
          // committate sopra — cioè da qualunque macchina di sviluppo mentre si
          // scrive la slice che lo aggiunge. Stessa ragione di `supervisore`
          // qui sopra: entrambi gli esiti sono legittimi e nessuno dei due è
          // affare di questo giro. Rifiutarlo renderebbe A10 rossa a seconda di
          // `git status`, che è un test il cui risultato è una proprietà
          // dell'albero di chi lo lancia.
          'build',
          // Stessa famiglia di `build`, e per la stessa ragione misurata il
          // 28/08/2026: `findCheckoutRoot` risolve di proposito al checkout
          // **principale** (`cli/update.ts` — la prima riga di `git worktree
          // list`, perche' e' quello che `muffin update` aggiorna), mentre
          // l'`init` di questo giro copia da `dist/`. Su un worktree di slice i
          // due alberi sono diversi per costruzione, quindi la deriva che
          // doctor segnala e' fra il checkout principale e il build di chi
          // lancia — non fra l'installazione sotto esame e cio' che le e' stato
          // copiato dentro un minuto fa.
          //
          // In una home appena inizializzata quel confronto non puo' dire altro:
          // `init` ha copiato i default in questo istante, quindi non esiste una
          // modifica dell'owner da scoprire. Ammesso come `sandbox`, mai in
          // silenzio — la riga esce sotto con la ragione che doctor ha dato.
          'default',
        ];
        for (const line of warnLines) {
          if (!expectedWarnNames.some((name) => line.startsWith(`! ${name}`))) {
            throw new Error(`doctor riporta un WARN non dichiarato a questo punto del giro: "${line}"\n\n${doctor.out}`);
          }
        }
        const defaultWarn = warnLines.find((l) => l.startsWith('! default'));
        if (defaultWarn) {
          console.warn(`[A10] i default del checkout principale non sono quelli di questo build: ${defaultWarn.trim()}`);
        }
        const sandboxWarn = warnLines.find((l) => l.startsWith('! sandbox'));
        if (sandboxWarn) {
          // Dichiarato, non saltato: chi legge il log sa che il giro è passato
          // su una macchina senza contenimento, e quale ragione ha dato doctor.
          console.warn(`[A10] questa macchina non contiene, e doctor lo dice prima di eseguire: ${sandboxWarn.trim()}`);
        }
        if (!warnLines.some((l) => l.startsWith('! root of trust mode') && l.includes('single-user'))) {
          throw new Error(`doctor non nomina "root of trust mode: single-user":\n${doctor.out}`);
        }
        // The content check ring 2 sets up: after resolving the duplicate, the
        // "api key" line names exactly ONE copy — the persistent one, since
        // that is what survived — never two.
        if (!/✓ api key\s+.*\(persistent\)/.test(doctor.out)) {
          throw new Error(`doctor non risolve "api key" a una singola copia persistent dopo la pulizia:\n${doctor.out}`);
        }
        if (doctor.out.includes('esiste anche')) {
          throw new Error(`doctor nomina ancora due copie della chiave dopo che il doppione è stato risolto:\n${doctor.out}`);
        }

        // === 4. `muffin gateway install` — the unit meets the real parser =====
        //
        // Never through the CLI's own `gateway install`: `cli/gateway.ts:194`
        // (`cmdGatewayInstall`) always derives `homeDir` from the real
        // `homedir()`, on *both* platforms — `XDG_CONFIG_HOME` only reaches
        // the systemd branch (`configHome`), and the launchd branch never
        // reads it at all. So a real `muffin gateway install --write` on this
        // machine would land on the *actual* owner path, and on macOS its
        // label (`LAUNCHD_LABEL` = `ai.muffin.gateway`) is the one this
        // machine's real, live Muffin gateway is registered under — verified
        // moments ago in this same slice's own probing: `doctor`'s
        // `supervisore` line above reads this machine's real launchd state
        // for exactly that reason. This ring calls the pure planner
        // (`core/gateway/unit.ts`'s `planUnit`, the function `cmdGatewayInstall`
        // itself calls) directly, with an explicit **scratch** `homeDir` — the
        // same seam `core/gateway/unit.test.ts` already uses — and never
        // writes to a real path or shells out to `launchctl`/`systemctl`.
        const scratchHomeDir = mkdtempSync(join(inst.workspace, 'fake-homedir-'));
        const launcher = join(inst.workspace, 'fake-muffin-launcher');
        writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        // Both plans are computed on *every* machine — `planUnit` takes the
        // platform as data, not as `process.platform` — so the structural
        // assertions below run everywhere; only the two live-parser legs are
        // gated on which parser this machine actually has.
        const systemdPlan = planUnit({
          platform: 'linux',
          home: inst.home,
          exec: [launcher, 'gateway', 'run'],
          homeDir: scratchHomeDir,
          configHome: join(scratchHomeDir, '.config'),
        });
        const launchdPlan = planUnit({
          platform: 'darwin',
          home: inst.home,
          exec: [launcher, 'gateway', 'run'],
          homeDir: scratchHomeDir,
        });

        // The commands an owner would paste are instructions, and a wrong
        // instruction is a defect exactly as real as wrong code: both must
        // literally name what the plan itself computed. systemd addresses a
        // unit by directory (`mkdir -p`) plus service *name* (`systemctl
        // …<name>.service`) — never the raw file path, that is just how
        // `systemctl` works — while launchd's own verbs take the plist path
        // literally (`launchctl bootstrap … <path>`), so the two checks are
        // shaped differently on purpose, not an inconsistency.
        if (!systemdPlan.path.endsWith(join('systemd', 'user', 'muffin-gateway.service'))) {
          throw new Error(`il percorso della unit systemd non ha la forma attesa: ${systemdPlan.path}`);
        }
        if (!systemdPlan.commands.some((c) => c.includes(dirname(systemdPlan.path)))) {
          throw new Error(`i comandi stampati non creano la directory vera della unit:\n${systemdPlan.commands.join('\n')}`);
        }
        if (!systemdPlan.commands.some((c) => c.includes(basename(systemdPlan.path)))) {
          throw new Error(`i comandi systemctl non nominano il vero nome della unit:\n${systemdPlan.commands.join('\n')}`);
        }
        if (!launchdPlan.path.endsWith(join('Library', 'LaunchAgents', 'ai.muffin.gateway.plist'))) {
          throw new Error(`il percorso del plist non ha la forma attesa: ${launchdPlan.path}`);
        }
        if (!launchdPlan.commands.some((c) => c.includes(launchdPlan.path))) {
          throw new Error(`i comandi stampati non nominano il vero percorso del plist:\n${launchdPlan.commands.join('\n')}`);
        }
        // Isolation itself, checked rather than assumed: neither plan may ever
        // point at this machine's real home — the exact failure mode ring 4's
        // own docstring warns `cmdGatewayInstall` cannot avoid.
        const realHomeDir = homedir();
        for (const p of [systemdPlan.path, launchdPlan.path]) {
          if (p.startsWith(realHomeDir) && !p.startsWith(scratchHomeDir)) {
            throw new Error(`la unit generata punta alla home reale di questa macchina, non allo scratch — ${p}`);
          }
        }

        const requireSystemd = process.env['MUFFIN_REQUIRE_SYSTEMD'] === '1';
        let linuxLegWhy = '';
        if (process.platform === 'linux' || requireSystemd) {
          const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
          const haveParser = probe.error === undefined && probe.status === 0;
          if (!haveParser) {
            if (requireSystemd) {
              throw new Error(
                `MUFFIN_REQUIRE_SYSTEMD=1 ma systemd-analyze non è eseguibile qui (${probe.error?.message ?? `exit ${String(probe.status)}`}): la unit di produzione resterebbe non verificata`,
              );
            }
            linuxLegWhy = 'systemd-analyze non è eseguibile su questo runner Linux';
          } else {
            const file = join(scratchHomeDir, 'muffin-gateway.service');
            writeFileSync(file, systemdPlan.text);
            const verify = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
            if (`${verify.stdout ?? ''}${verify.stderr ?? ''}`.trim() !== '' || verify.status !== 0) {
              throw new Error(
                `systemd-analyze verify rifiuta la unit generata:\n${verify.stdout}\n${verify.stderr}`,
              );
            }
            linuxLegWhy = 'eseguita: systemd-analyze verify ha accettato la unit generata';
          }
        } else {
          // Declared, not silently skipped: this is the leg that matters —
          // Linux is where Muffin actually lives (AGENTS.md) — and it is not
          // running on this machine.
          console.warn(
            `[A10] gamba Linux (systemd-analyze verify) SALTATA: piattaforma corrente è ${process.platform}, non linux`,
          );
          linuxLegWhy = `saltata: piattaforma corrente è ${process.platform}, non linux (imposta MUFFIN_REQUIRE_SYSTEMD=1 su un runner Linux per forzarla)`;
        }
        if (linuxLegWhy === '') throw new Error('la gamba Linux non ha dichiarato perché è stata eseguita o saltata');

        let darwinLegWhy = '';
        if (process.platform === 'darwin') {
          const plistFile = join(scratchHomeDir, 'ai.muffin.gateway.plist');
          writeFileSync(plistFile, launchdPlan.text);
          const lint = spawnSync('plutil', ['-lint', plistFile], { encoding: 'utf8' });
          if (!`${lint.stdout}${lint.stderr}`.includes('OK')) {
            throw new Error(`plutil -lint rifiuta il plist generato:\n${lint.stdout}${lint.stderr}`);
          }
          darwinLegWhy = 'eseguita: plutil -lint ha accettato il plist generato (solo il testo — vedi il docstring sopra: mai launchctl, mai il path reale)';
        } else {
          console.warn(`[A10] gamba macOS (plutil -lint) SALTATA: piattaforma corrente è ${process.platform}, non darwin`);
          darwinLegWhy = `saltata: piattaforma corrente è ${process.platform}, non darwin`;
        }
        if (darwinLegWhy === '') throw new Error('la gamba macOS non ha dichiarato perché è stata eseguita o saltata');
        // Exactly one of the two live-parser legs must have actually run: this
        // machine has exactly one platform, and a report where both are
        // "skipped" would mean the gate silently proved nothing at all.
        if (!linuxLegWhy.startsWith('eseguita') && !darwinLegWhy.startsWith('eseguita')) {
          throw new Error(
            `nessuna delle due gambe del parser di piattaforma è girata per davvero — linux: ${linuxLegWhy}; darwin: ${darwinLegWhy}`,
          );
        }

        // === 5/6. A live gateway, Telegram paired, a real answer delivered ====
        //
        // Surface + secret set up before the gateway boots — `SurfaceRegistry`
        // reads them at startup, same order as b-telegram-pairing.accept.ts.
        const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-acceptance-token');
        if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
        const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
        if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
        const pairingCode = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
        if (!pairingCode) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);

        const gw = await inst.gateway();
        try {
          await gw.waitFor(/muffin gateway/, 20_000);

          // Ring 5's own claim: the live process is up, and `gateway status`
          // — the command an owner actually types — sees it.
          const status = await inst.muffin(['gateway', 'status']);
          if (status.code !== 0) throw new Error(`\`gateway status\` non vede il gateway vivo: exit ${status.code}\n${status.out}`);
          if (!/^attivo · pid \d+/.test(status.out)) {
            throw new Error(`\`gateway status\` non ha la forma attesa: ${status.out}`);
          }

          // Ring 6: an owner, proven by the pairing code, asks a real question
          // and gets a real, delivered answer — not "the pairing confirmation
          // exists", which b-telegram-pairing.accept.ts already proves.
          tg.deliver(privateMessage({ id: 999, name: 'Owner' }, pairingCode));
          await until(() => ownerIdFromConfig(inst.home) !== undefined, 20_000);
          if (ownerIdFromConfig(inst.home) !== 999) {
            throw new Error(`owner atteso 999, trovato ${String(ownerIdFromConfig(inst.home))}`);
          }

          tg.deliver(privateMessage({ id: 999, name: 'Owner' }, 'qual è il mio piatto preferito da oggi?'));
          // By text, not by position: DAY-1 requirement B13 means a real turn can now
          // also send a `sendMessage` for its own progress status line (the
          // pairing confirmation above is a real message too) before the
          // real answer, and `FakeTelegram.messages()` is a flat log of every
          // `sendMessage` ever made — it does not collapse the status line's
          // later `editMessageText`/`deleteMessage` calls out of that log the
          // way a real Telegram client would. So the answer is identified by
          // its own content, wherever it lands among however many status
          // updates happened to fire during a real (if fast) gateway turn.
          await until(() => tg.messages().some((m) => m.text.includes('ricci di mare')), 20_000);
          const reply = tg.messages().find((m) => m.text.includes('ricci di mare'));
          if (!reply) {
            throw new Error(`la risposta consegnata su Telegram non contiene il testo atteso: ${JSON.stringify(tg.messages())}`);
          }

          // The durable row, not just what the fake bot happened to receive:
          // `delivery` has to say `sent`, the way B8 proves the negative case.
          const turnRow = inst.db((db) =>
            db.prepare(`SELECT id, delivery, tenant, surface FROM turns ORDER BY created_at DESC LIMIT 1`).get() as
              | { id: string; delivery: string | null; tenant: string; surface: string }
              | undefined,
          );
          if (!turnRow) throw new Error('nessuna riga turns dopo la conversazione Telegram');
          if (turnRow.surface !== 'telegram' || turnRow.tenant !== 'host') {
            throw new Error(`il turno non risulta sulla superficie/tenant attesi: ${JSON.stringify(turnRow)}`);
          }
          if (turnRow.delivery !== 'sent') {
            throw new Error(`il turno Telegram non risulta consegnato (delivery=${String(turnRow.delivery)}): ${JSON.stringify(turnRow)}`);
          }

          // === 7. The memory the journey should have left behind ==============
          //
          // First, the episode itself — durable, tenant-scoped evidence, not
          // an inference from what a later process happens to recall.
          const episode = inst.db((db) =>
            db
              .prepare(`SELECT connector, role FROM episodes WHERE tenant_id = 'host' AND content LIKE '%ricci di mare%'`)
              .get() as { connector: string; role: string } | undefined,
          );
          if (!episode) throw new Error('nessun episodio con il fatto detto su Telegram — la memoria non lo ha acquisito');

          // Then the property that actually matters to the owner: a second,
          // unrelated process remembers it — same shape as c-memory.accept.ts's
          // C1, reused here across a surface boundary instead of a session one.
          const recall = await inst.muffin(['run', '--session', 'a10-recall', '--timeout', '20', 'qual è il mio piatto preferito?']);
          if (recall.code !== 0) throw new Error(`il turno di richiamo: exit ${recall.code}\n${recall.err}`);
          const sentToRecall = inst.provider.main().at(-1);
          if (!sentToRecall) throw new Error('il turno di richiamo non ha mai chiamato il modello');
          if (!sentToRecall.transcript.includes('ricci di mare')) {
            throw new Error(
              `il richiamo di memoria non ha riportato il fatto detto su Telegram in un processo CLI separato:\n${sentToRecall.transcript}`,
            );
          }
        } finally {
          // A real owner stops the gateway before wiping the home — never
          // leaves it running against a database that is about to disappear.
          const exitCode = await gw.stop();
          if (exitCode !== EXIT_STOPPED) {
            throw new Error(`atteso EXIT_STOPPED (${EXIT_STOPPED}) da un gateway drenato via SIGTERM, ricevuto ${exitCode}`);
          }
        }

        // === 8. `muffin uninstall` — nothing left but what was `--persist`ed ==
        //
        // Piloted the way an owner actually would: `--yes` on the flag, never
        // `rm` on the directory. Driving the interactive prompt itself is not
        // possible from here — `promptLine` (cli/prompt.ts) resolves
        // `undefined` the instant `!input.isTTY`, and a spawned child's stdin
        // is a pipe on every platform this suite runs on, never a TTY — so
        // without `--yes` the command would correctly *refuse* on a pipe
        // (exit 78, "Rifiuto di cancellare senza conferma su una pipe"),
        // which is the right behaviour for a destructive command and not a
        // gap this scenario needs to route around.
        const uninstall = await inst.muffin(['uninstall', '--yes']);
        if (uninstall.code !== 0) throw new Error(`uninstall: exit ${uninstall.code}\n${uninstall.out}${uninstall.err}`);
        if (existsSync(inst.home)) throw new Error(`la home esiste ancora dopo \`muffin uninstall --yes\`: ${inst.home}`);

        // The persisted copy (ring 2's own resolution: the one that survived
        // the duplicate, kept alive precisely for this check) is untouched —
        // ADR-0039's whole point.
        const persistentSecretPath = /→ (.+)\s*$/m.exec(persisted.out.trim())?.[1];
        if (!persistentSecretPath) throw new Error(`impossibile risalire al percorso persistente dall'output del passo 2:\n${persisted.out}`);
        if (!existsSync(persistentSecretPath)) {
          throw new Error(`il segreto --persist non è sopravvissuto a \`muffin uninstall\` (ADR-0039): ${persistentSecretPath}`);
        }
        if (!uninstall.err.includes(persistentSecretPath)) {
          throw new Error(`\`uninstall\` non dice che la chiave persistente resta, o non ne nomina il percorso:\n${uninstall.err}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    30_000,
  );
});
