# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Muffin è installato e in uso (25/08/2026).** La milestone RETURN TO OWNER è
chiusa: S1–S4 in `M5-BIS.md` §RETURN, che possiede il dettaglio: qui resta solo
ciò che serve per scegliere il prossimo lavoro.

**Stato dell'installazione reale**, provato sulla macchina dell'owner:
`~/.muffin` (database di agosto, 29 tabelle, schema v1), provider OpenRouter
con `qwen/qwen3.8-27b` e `qwen/qwen3.7-flash`, gateway vivo sotto launchd, un
job schedulato eseguito da solo. Backup validato prima della migrazione.

**Regola di stop attiva.** Niente sviluppo pre-dogfood: il prossimo lavoro
nasce da un failure osservato usando Muffin, da una requirement owner già
decisa, da una migrazione che rimandare renderebbe costosa, o da un rischio
concreto su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** Telegram non è ancora abilitato (serve il token del
bot); `doctor` segnala due chiavi API, in `~/.muffin/secrets/` (quella usata) e
in `~/.config/muffin/secrets/` — cancellare quella che non si vuole ruotare; il
job di prova `922ac8b7` riparte ogni giorno alle 18:24 finché non lo si toglie
(`muffin jobs remove 922ac8b7`).

**Fatto il 25/08 sera:** job **script** (#106, CRITICAL, 3 giri di judge —
esattamente-una-volta attraverso i crash, fail-closed senza sandbox, prima
migrazione vera + `ensureColumn` difensivo); guard sul ripristino distruttivo
(#107); Linux-first (#110: la unit systemd passa da `systemd-analyze` in CI,
`SuccessExitStatus`, `doctor` chiede `is-failed`, gate `MUFFIN_REQUIRE_*`);
`strumenti.yml` (CI sugli hook); `knip.json` + 3 dipendenze morte rimosse.

**Coda decisa dall'owner (25/08):** 1) installazione che **interroga** la
macchina — locale o API, quale modello, probe sandbox/supervisore in `init`;
si porta dietro 2 reperti audit (rimedio AppArmor nell'installer, `doctor`
onesto sul seccomp saltato su Linux); 2) note di avanzamento sui turni lunghi
(un turno sospeso riprende i messaggi, non un sommario); 3) probe bubblewrap
senza controllo positivo + TMPDIR (confine contenimento, judge). Direttive
trasversali: Linux prima (VPS), modificare>aggiungere, difese permanenti.

**Follow-up registrati (non slice).** Dal primo uso reale: REPL muore su input
non-TTY; manca `sys.inspect` (E7, tre ricorsi a `sys.shell` in sei turni, su
`muffin run` vicolo cieco); `doctor` su home pre-boot dà rimedio sbagliato su
database esistente. Dai judge: N eventi → 1 composizione senza assembler;
`possibly_sent` non distingue crash da in-volo; catch di `cmdRestore` con
stack; TOCTOU gateway; repl-lock assente; finestra pairing; Discord `handle()`
non bound. Da knip/jscpd (25/08): ~52 export orfani da de-esportare; cablaggio
runtime duplicato `cli/gateway.ts`↔`cli/repl.ts` (già costato il bug del
giro 1 di #106: la copia REPL era rimasta senza esecutore) e coppie
discord↔telegram nei connettori — dedup con trigger, non estrazioni premature.

**Branch aperti:** nessuno. #84 (README pubblico) è stata aggiornata a HEAD
(fact-check senza claim falsi) e mergiata il 26/08 — in `dev`, che resta
privato: il lancio è un'altra decisione.

**Truth maintenance:** M5-BIS possiede status Gate e classificazione RETURN;
PERCORSO §0 possiede l'ordine, ed è chiuso. Le righe A6/A7/A8 e D12/E6 hanno il
meccanismo in HEAD e restano BLOCKER di Gate solo per i residui DOGFOOD.

**Owner decision pendente:** nessuna.
