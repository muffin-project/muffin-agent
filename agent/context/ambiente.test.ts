import { describe, expect, it } from 'vitest';
import { ambienteSection, MAX_VOCI_CWD, type IstanzaFacts } from './assemble.js';

const QUANDO = new Date('2026-08-28T04:59:00Z');
const base = { adesso: QUANDO, surface: 'cli', classe: 'owner' as const, model: 'qwen/qwen3.8-27b', profilo: 'consumer-local', timeZone: 'Europe/Rome' };

/**
 * Che momento è, e dove stai parlando.
 *
 * Il difetto che questi test tengono chiuso è stato misurato su uno schermo
 * vero il 28/08/2026: alla domanda «che giorno e che ora sono adesso?», Muffin
 * ha provato a eseguire `date` con `sys.shell` — cioè ha chiesto un permesso
 * all'owner per sapere l'ora. Non era una stranezza del modello: nel prompt la
 * data non c'era, in nessuna forma. Un agente con memoria, uno scheduler, dei
 * `todo` con scadenze e una persona che dice «posso riprendere qualcosa dopo
 * ore o giorni» non sapeva in che giorno fosse.
 */


describe('la data entra nel contesto', () => {
  it('dice giorno della settimana, data, ora e fuso', () => {
    const s = ambienteSection({ ...base, surface: 'cli', timeZone: 'Europe/Rome' });
    expect(s).toContain('venerdì');
    expect(s).toContain('28 agosto 2026');
    expect(s).toContain('06:59'); // 04:59Z a Roma d'estate
    expect(s).toContain('Europe/Rome');
  });

  /**
   * «Le 4:59» senza fuso non è un momento, ed è la metà che si dimentica: un
   * agente che gira su una VPS in un fuso e parla con un owner in un altro
   * risponderebbe l'ora giusta della macchina sbagliata.
   */
  it('e lo stesso istante in due fusi non è la stessa ora', () => {
    const roma = ambienteSection({ ...base, surface: 'cli', timeZone: 'Europe/Rome' });
    const tokyo = ambienteSection({ ...base, surface: 'cli', timeZone: 'Asia/Tokyo' });
    expect(roma).not.toBe(tokyo);
    expect(tokyo).toContain('Asia/Tokyo');
  });

  /**
   * Locale esplicito: quello di sistema su questa macchina è `en-US`
   * (misurato), e un agente che parla italiano non deve leggere «Friday» per
   * sapere che giorno è.
   */
  it('e lo dice in italiano, non nel locale della macchina', () => {
    const s = ambienteSection({ ...base, surface: 'cli', timeZone: 'Europe/Rome' });
    expect(s).not.toContain('Friday');
    expect(s).not.toContain('August');
  });
});

describe('e la superficie pure', () => {
  /**
   * `voice.md` ha una regola che **dipende** da questo — «non uso LaTeX nei
   * messaggi destinati a superfici che non lo renderizzano» — e fino a questo
   * momento era insoddisfacibile: la regola c'era, il dato per applicarla no.
   */
  it('dice dove stai parlando, con la parola di una persona', () => {
    expect(ambienteSection({ ...base, surface: 'cli', timeZone: 'Europe/Rome' })).toContain('un terminale');
    expect(ambienteSection({ ...base, surface: 'telegram', timeZone: 'Europe/Rome' })).toContain('Telegram');
  });

  /** Una superficie che ancora non esiste si nomina da sé, invece di sparire. */
  it('e una superficie che non conosce la chiama col suo nome', () => {
    expect(ambienteSection({ ...base, surface: 'matrix', timeZone: 'Europe/Rome' })).toContain('matrix');
  });
});

describe('dove sta, e perché non altrove', () => {
  /**
   * Sta nella coda volatile, mai in `systemPrompts`. I prompt di sistema si
   * assemblano una volta all'avvio proprio per restare un prefisso cacheable
   * byte per byte, e un orologio lì davanti è letteralmente l'errore che la
   * documentazione di Anthropic sul prompt caching chiama per nome — «il
   * breakpoint su contenuto che cambia a ogni richiesta».
   *
   * Qui si prova la proprietà che lo rende collocabile solo lì: **cambia**.
   */
  it('due istanti diversi danno due testi diversi', () => {
    const a = ambienteSection({ ...base, adesso: new Date('2026-08-28T04:59:00Z'), surface: 'cli', timeZone: 'Europe/Rome' });
    const b = ambienteSection({ ...base, adesso: new Date('2026-08-28T05:59:00Z'), surface: 'cli', timeZone: 'Europe/Rome' });
    expect(a).not.toBe(b);
  });

  /** È una sezione con la sua intestazione, come le altre della coda. */
  it('ed è una sezione, non una riga sciolta in mezzo al testo', () => {
    expect(ambienteSection({ ...base, surface: 'cli', timeZone: 'Europe/Rome' }).startsWith('## Questo turno')).toBe(true);
  });
});

describe("l'offset UTC, non solo il nome del fuso", () => {
  /**
   * È Hermes ad averlo argomentato meglio, e ha ragione: il nome IANA da solo
   * obbliga a sapere se in quel momento vige l'ora legale. I tool che accettano
   * istanti rifiutano i datetime naive, e vicino a un cambio d'ora indovinare
   * fra due sigle scrive il record sul giorno sbagliato **in silenzio**.
   */
  it('lo dice, e cambia con l ora legale', () => {
    const estate = ambienteSection({ ...base, adesso: new Date('2026-08-28T04:59:00Z') });
    const inverno = ambienteSection({ ...base, adesso: new Date('2026-01-28T04:59:00Z') });
    expect(estate).toContain('UTC+02:00');
    expect(inverno).toContain('UTC+01:00');
  });

  it('e a UTC lo dice per intero, invece di dire solo «GMT»', () => {
    const s = ambienteSection({ ...base, timeZone: 'UTC' });
    expect(s).toContain('UTC+00:00');
  });
});

describe('con chi stai parlando', () => {
  /**
   * È la distinzione su cui gira tutto il resto: `voice.md` §«Quando parlo in
   * gruppo» chiede di occupare meno spazio, ed è la stessa linea su cui il
   * prompt cambia classe. Il modello non sapeva quale dei due fosse.
   */
  it('distingue il canale privato dell owner da una stanza', () => {
    expect(ambienteSection({ ...base, classe: 'owner' })).toContain("in privato con l'owner");
    const gruppo = ambienteSection({ ...base, classe: 'group' });
    expect(gruppo).toContain('altre persone');
    expect(gruppo).not.toContain("in privato con l'owner");
  });
});

describe('primo incontro', () => {
  it('is a volatile owner-only instruction, not another durable profile', () => {
    const fresh = ambienteSection({ ...base, firstEncounter: true });
    expect(fresh).toContain('primo incontro');
    expect(fresh).toContain('al massimo una domanda');
    expect(ambienteSection({ ...base, classe: 'group', firstEncounter: true })).not.toContain('primo incontro');
  });
});

describe('con cosa stai rispondendo', () => {
  /**
   * «Non so quale modello mi esegue» è una risposta che Muffin dava e che non
   * deve dare. E il profilo non è cosmesi: decide quanti tool vede e quante
   * chiamate può fare in un turno, cioè cosa è ragionevole tentare.
   */
  it('dice il modello e il profilo', () => {
    const s = ambienteSection({ ...base, model: 'qwen/qwen3.8-27b', profilo: 'consumer-local' });
    expect(s).toContain('qwen/qwen3.8-27b');
    expect(s).toContain('consumer-local');
  });
});

/**
 * L'estensione di `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0:
 * due righe di fatti d'istanza, sourced come `sys_inspect` li legge — non
 * ricalcolati qui, solo formattati.
 */
describe('istanza (docs/evidence/orizzonte-del-turno-2026-09-03.md Parte 0)', () => {
  const istanza: IstanzaFacts = {
    cwd: '/home/owner/progetti/muffin',
    voci: ['agent', 'cli', 'core', 'docs', 'package.json'],
    provider: 'openrouter',
    jobAttivi: 2,
    safeMode: null,
  };

  it('assente di default: il blocco resta quello di prima', () => {
    const s = ambienteSection({ ...base, classe: 'owner' });
    expect(s).not.toContain('Cartella di lavoro');
    expect(s).not.toContain('Istanza:');
  });

  it("dice la working directory, le sue voci di primo livello, il provider, i job attivi e il RoT", () => {
    const s = ambienteSection({ ...base, classe: 'owner', istanza });
    expect(s).toContain('Cartella di lavoro: /home/owner/progetti/muffin');
    expect(s).toContain('agent, cli, core, docs, package.json');
    expect(s).toContain('Istanza: openrouter · 2 job attivi · RoT integro.');
  });

  it('una directory vuota lo dice, invece di una riga senza voci', () => {
    const s = ambienteSection({ ...base, classe: 'owner', istanza: { ...istanza, voci: [] } });
    expect(s).toContain('0 elementi di primo livello: (vuota)');
  });

  it('il SAFE MODE sostituisce "RoT integro" con la ragione', () => {
    const s = ambienteSection({
      ...base,
      classe: 'owner',
      istanza: { ...istanza, safeMode: { reason: 'identity.md modificato' } },
    });
    expect(s).toContain('SAFE MODE (identity.md modificato)');
    expect(s).not.toContain('RoT integro');
  });

  /**
   * Il tetto sulle voci mostrate — la stessa ragione di `fs_list` che limita,
   * qui applicata a un blocco che vive in **ogni** turno: senza un tetto
   * questa sezione ricrea nel budget dei token il problema che la slice chiude
   * nel budget dei tool.
   */
  it('più voci del tetto vengono tagliate, e il taglio si dice come conteggio', () => {
    const tante = Array.from({ length: MAX_VOCI_CWD + 5 }, (_, i) => `voce-${i}`);
    const s = ambienteSection({ ...base, classe: 'owner', istanza: { ...istanza, voci: tante } });
    expect(s).toContain(`${tante.length} elementi di primo livello`);
    expect(s).toContain('+5 altre');
    // La prima voce oltre il tetto non compare per nome nell'elenco mostrato.
    expect(s).not.toContain('voce-12');
  });

  /**
   * **La proprietà che rende questa sezione collocabile solo nella coda
   * volatile e mai in `systemPrompts`**: un membro di gruppo non vede
   * l'istanza — stessa ragione di `inspectCapability.hostOnly` — anche quando
   * il chiamante gliela passa. Non è un secondo controllo di sicurezza (quello
   * lo fa `visibleTools`/il kernel per `sys_inspect`); è che qui non c'è una
   * riga in meno da dimenticare di negare, perché la classe la nasconde da
   * sola.
   */
  it("una classe 'group' non vede l'istanza, anche se passata", () => {
    const s = ambienteSection({ ...base, classe: 'group', istanza });
    expect(s).not.toContain('Cartella di lavoro');
    expect(s).not.toContain('Istanza:');
    expect(s).not.toContain('openrouter');
  });
});
