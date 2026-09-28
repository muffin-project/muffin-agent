# ADR-0091 — La lettura dell'intera macchina è una disclosure irreversibile

**Stato:** accettato · 2026-09-22 · lane #645 · evidenza:
`docs/evidence/shell-containment-2026-09-21.md` §5 (misura Linux 2026-09-22)

## Contesto

ADR-0074 punto 4 ha diviso la shell in due corsie e reso quella in sola
lettura `reversible: 'yes'`: niente scrittura fuori dallo scratch, niente
rete, quindi niente da disfare — e il kernel la lasciava passare senza
chiedere a nessuno.

Il 2026-09-22 la misura su Linux (bwrap + srt 0.0.71 pinnato, #645) ha
mostrato l'assunzione che restava: le letture coprono **l'intera macchina**
men meno la `denyRead` finita (canary fuori workspace letto da `~`, da
`/var/tmp` e dal disco dell'host con `runReadOnly` di produzione), e srt
0.0.71 non ha allowlist di lettura — uno scope di lettura limitato al
workspace non è costruibile in questa lane. Parsing della stringa del comando
per bloccare i path assoluti è teatro bypassabile (scelta C, rifiutata).

Una lettura che arriva al modello è **disclosure**: i byte sono nel contesto
da quel momento e non tornano indietro. La regola di ADR-0074 non cambia —
`ask` ⇔ irreversibile — ma questa capability sta dalla parte irreversibile
della riga. Postura chiesta dall'owner (#645): finché la confidentiality
boundary non è garantita, `sys.shell` non è certificata come libera di
girare; niente warning o documentazione al posto del gate.

## Decisione

1. **`shellCapability.reversible`: `'yes'` → `'no'`.** Con la riga `host`
   (`asksForIrreversible: true`) il kernel chiede all'owner **ogni volta**,
   a ogni taint sotto il soffitto, in single-user come in hardened; un
   principal autonomo accoda come ogni altra irreversibile. Le due corsie
   della shell stanno di nuovo dalla stessa parte della regola ADR-0074.
2. **Decisione iniziale, superseded 2026-09-25 dopo l'audit di #650:**
   `risk: 'low'` e `rerunnable: true` si basavano sull'assunto che, non
   scrivendo su disco, la shell non potesse duplicare effetti. La misura
   successiva del confine Linux ha confermato che socket AF_UNIX raggiungibili
   (oltre al socket gateway deny-listed) possono interagire con servizi
   locali. Un comando può quindi mutare un servizio e un resume potrebbe
   ripeterlo se manca la riga di outcome. La capability ora è
   `risk: 'high'` e `rerunnable: false`: safe mode e budget la bloccano secondo
   le regole esistenti, mentre una chiamata dall'esito incerto si ferma come
   “maybe done” e non viene lanciata di nuovo. `reversible: 'no'` continua a
   imporre l'ask dell'owner per ogni chiamata (ADR-0074).
3. **Tutto ciò che dichiarava il contrario si aggiorna nello stesso commit**:
   descrizioni dei due tool, WORK_RULES v1/v2 (pin SHA ri-catturati e rapporto
   ri-misurato), `doctor` («capability che non si annulla»), SECURITY §9.1/§9.2,
   il contract dell'evidenza. Il canary `it.fails` resta: lo scope di lettura
   è ancora allow-by-default, e flipping richiede allow-scoping reale.

## Conseguenze

- Ogni `shell_run` passa da un `ask` il cui prompt nomina cosa non si torna
  indietro («cambia questa macchina — sys.shell») più il comando. L'attrito
  che ADR-0074 ha tolto per le 35 approvazioni-di-riflesso torna sulla sola
  corsia di lettura: accettato col gate, non nascosto — le descrizioni del
  tool dicono al modello che la domanda c'è, così preferisce `fs_read` e gli
  altri tool dedicati prima di arrivare qui.
- Un esito mancante dopo una chiamata shell non prova che il comando non sia
  partito: il resume dichiara l'esito incerto e lascia la riconciliazione
  all'owner invece di rieseguire un possibile effetto su un servizio locale.
- `fakeApprove` degli eval resta il misuratore: misura il gate e il
  follow-through, non lo sostituisce in produzione.
- Ciò che la ribalta: srt (o un sostituto) con allowlist di lettura o Unix
  socket bloccabili su Ubuntu 24.04 → lo scope di lettura diventa
  costruibile, e una nuova ADR può riportare la corsia scoped a
  `reversible: 'yes'` con la misura che lo giustifica. Il contrario — la
  §5(1) rossa su Linux — chiude ulteriormente, mai silenziosamente.
