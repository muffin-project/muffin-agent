---
paths:
  - "defaults/rot/**"
---

# Qui dentro un numero è una capability, non una configurazione

`defaults/rot/` è contenuto **costituzionale spedito**: identità, policy, budget,
egress. Questi file non configurano lo sviluppo — decidono cosa l'agente
installato ha il permesso di fare, su ogni installazione, **senza una riga di
codice che cambi**.

È la ragione per cui questa nota esiste: cambiare `2` in `3` dentro
`policy.json` sembra un'impostazione e invece è una modifica al confine di
sicurezza. Nessun hook, nessun test e nessun job di CI oggi nomina questa
directory: se non la riconosci come tale al momento dell'edit, non te lo dice
nessun altro.

Quindi, prima di toccare un valore qui:

- **classifica la modifica per quello che è.** Tocca authority, permessi,
  provenienza/taint, egress o segreti: è un trigger del challenge pass
  (`docs/RESEARCH.md`) e quasi mai un FAST.
- **il literal vive qui, non nella prosa.** `docs/SECURITY.md` possiede la
  *semantica* del confine; se il confine si sposta, si aggiorna anche lì. Se
  invece la prosa altrove ripete il numero, quella copia è il difetto — è già
  successo con `paramsMaxTaint`, che la mappa dichiarava `1` mentre il file
  spedito diceva `2`.
- **un'inversione di una decisione registrata è un ADR nuovo**, non una
  modifica silenziosa del valore.
- **`defaults/**` non è documentazione.** È di proposito fuori dai
  `paths-ignore` della CI: persona, voice e RoT sono prodotto.
