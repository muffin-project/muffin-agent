---
name: studia-un-documento
description: Leggi davvero un PDF, un DOCX o una dispensa e lavoraci sopra — riassunti, domande, spiegazioni, ripasso. Usala quando l'owner ti passa un file da studiare o chiede aiuto con qualcosa che sta su un documento, invece di rispondere a memoria.
metadata:
  origine: procedura reale di questo repo, non generica
---

# Studiare un documento

La differenza fra rispondere su un documento e rispondere *a memoria di averlo
visto* è tutta qui. Un documento in Muffin entra **intero** (ADR-0043): non
viene troncato, e resta leggibile per intervalli esatti anche mesi dopo.

## 1. Farlo entrare

Se il file è sul disco e non è ancora in memoria:

```
muffin vault add <percorso-del-file>
```

`muffin vault ls` dice cosa è già indicizzato. Se il documento è già lì, non
riaggiungerlo: cercalo.

## 2. Trovarlo

```
memory_search con una frase presa dal documento, non con il nome del file
```

Il risultato annuncia il documento con un **indice** — di che pagine è fatto,
e cosa c'è dove. Quell'indice è la mappa: serve per sapere *cosa* chiedere,
non è il contenuto.

## 3. Leggerlo per davvero

```
document_read con `path`, e `da`/`a` presi dall'indice
```

Leggi l'intervallo che ti serve, non il documento intero: le pagine che non
c'entrano occupano contesto e basta. Se una risposta dipende da una pagina che
non hai letto, **leggila** — non interpolare fra due pagine che hai.

## 4. Rispondere in modo che serva a studiare

- Cita da dove viene ogni affermazione (pagina o sezione). Se l'owner sta
  studiando, deve poter tornare al punto.
- Quando qualcosa non è nel documento, dillo. «Il documento non lo dice» è una
  risposta utile; inventarlo è il modo più veloce di rendere inutile tutto il
  resto.
- Se chiede un ripasso, fai domande **sul documento**, e controlla le risposte
  rileggendo l'intervallo, non a memoria.

## Sessioni lunghe

Una conversazione lunga perde i messaggi più vecchi dal contesto, di proposito.
Ciò che conta va ritrovato con `memory_search`, non ricordato: se ti accorgi di
non avere più sotto gli occhi un pezzo del documento, rileggilo.
