import { describe, expect, it } from 'vitest';
import { SaluteSuperfici } from './salute.js';

const t = (iso: string): Date => new Date(iso);

describe('SaluteSuperfici — quanto dura un guasto, non solo che c e', () => {
  it('non conosce una superficie che nessuno ha provato a connettere', () => {
    expect(new SaluteSuperfici().stato()).toEqual([]);
  });

  it('registra la connessione con il momento in cui e avvenuta', () => {
    const s = new SaluteSuperfici();
    s.connessa('telegram', t('2026-08-29T12:30:00Z'));
    expect(s.stato()).toEqual([
      { id: 'telegram', connessa: true, da: '2026-08-29T12:30:00.000Z', fallimentiDiFila: 0 },
    ]);
  });

  /**
   * Il difetto che questo test uccide: se `da` si riscrivesse a ogni battito
   * riuscito, una superficie sana da tre ore direbbe «da 0 secondi» per sempre,
   * e «da quando» smetterebbe di essere un'informazione proprio mentre sembra
   * di averla.
   */
  it('una superficie gia connessa non si riconnette a ogni battito', () => {
    const s = new SaluteSuperfici();
    s.connessa('telegram', t('2026-08-29T12:30:00Z'));
    s.connessa('telegram', t('2026-08-29T15:00:00Z'));
    expect(s.stato()[0]?.da).toBe('2026-08-29T12:30:00.000Z');
  });

  /**
   * Il difetto che questo blocco uccide, trovato dal giudice sulla #260 e
   * riprodotto sul binario vero: fra il momento in cui `connectSurfaces` fa
   * partire il connettore e il primo `getMe` passano da qualche centesimo a
   * **due minuti**. In quella finestra il registro era vuoto, e `doctor`
   * leggeva l'assenza come «non e stata nemmeno tentata»: usciva 1 e diceva
   * all'owner di controllare `surfaces.enabled` e riavviare un gateway sano —
   * cioe di rifare partire l'handshake, che riproduce il sintomo.
   */
  it('avviata e non ancora viva non e ne connessa ne caduta', () => {
    const s = new SaluteSuperfici();
    s.inAvvio('telegram', t('2026-08-29T12:30:00Z'));
    expect(s.stato()).toEqual([
      { id: 'telegram', connessa: false, inAvvio: true, da: '2026-08-29T12:30:00.000Z', fallimentiDiFila: 0 },
    ]);
  });

  it('registrare l avvio non riporta indietro chi sta gia parlando', () => {
    const s = new SaluteSuperfici();
    s.connessa('telegram', t('2026-08-29T12:30:00Z'));
    s.inAvvio('telegram', t('2026-08-29T12:31:00Z'));
    expect(s.stato()[0]).toMatchObject({ connessa: true, da: '2026-08-29T12:30:00.000Z' });
  });

  /**
   * L'attesa non e' ancora un guasto, e sommarle gonfierebbe la durata proprio
   * nel caso lento — cioe' quello in cui la soglia di `doctor` deve decidere.
   */
  it('il guasto che segue un avvio comincia quando fallisce, non quando e partito', () => {
    const s = new SaluteSuperfici();
    s.inAvvio('telegram', t('2026-08-29T12:30:00Z'));
    s.caduta('telegram', 'TypeError (ECONNREFUSED)', t('2026-08-29T12:32:00Z'));
    expect(s.stato()[0]).toMatchObject({
      connessa: false,
      da: '2026-08-29T12:32:00.000Z',
      fallimentiDiFila: 1,
    });
    expect(s.stato()[0]?.inAvvio).toBeUndefined();
  });

  /**
   * «Abilitata ma senza owner» non si ripara riavviando il gateway. Chi
   * registra a volte sa il rimedio meglio di chi stampa, e senza questo campo
   * la riga diceva la cosa giusta col consiglio sbagliato.
   */
  it('chi registra puo portare il rimedio, quando lo sa', () => {
    const s = new SaluteSuperfici();
    s.caduta('telegram', 'abilitata ma senza owner', t('2026-08-29T12:30:00Z'), '`muffin surface enable telegram`');
    expect(s.stato()[0]?.rimedio).toBe('`muffin surface enable telegram`');
  });

  it('un fallimento porta la causa e comincia a contare', () => {
    const s = new SaluteSuperfici();
    s.caduta('telegram', 'TypeError (ECONNRESET)', t('2026-08-29T17:08:00Z'));
    expect(s.stato()).toEqual([
      {
        id: 'telegram',
        connessa: false,
        da: '2026-08-29T17:08:00.000Z',
        causa: 'TypeError (ECONNRESET)',
        fallimentiDiFila: 1,
      },
    ]);
  });

  /**
   * La distinzione che decide se questa riga vale la pena di essere letta: un
   * lampo e un guasto che dura non devono somigliarsi — ed e' la distinzione
   * che `gateway.err` non poteva fare, contando i fallimenti senza datarli. La
   * durata la porta `da`, che resta quello del **primo** della serie.
   */
  it('un guasto che dura tiene la sua data di inizio e conta i battiti', () => {
    const s = new SaluteSuperfici();
    s.caduta('telegram', 'TypeError (ECONNRESET)', t('2026-08-29T17:08:00Z'));
    s.caduta('telegram', 'TypeError (ENOTFOUND)', t('2026-08-30T12:00:00Z'));
    expect(s.stato()[0]).toMatchObject({
      da: '2026-08-29T17:08:00.000Z',
      causa: 'TypeError (ENOTFOUND)',
      fallimentiDiFila: 2,
    });
  });

  it('una riconnessione azzera il conto e la causa sparisce', () => {
    const s = new SaluteSuperfici();
    s.caduta('telegram', 'TypeError (ECONNRESET)', t('2026-08-29T17:08:00Z'));
    s.caduta('telegram', 'TypeError (ECONNRESET)', t('2026-08-29T17:08:05Z'));
    s.connessa('telegram', t('2026-08-30T12:20:00Z'));
    expect(s.stato()).toEqual([
      { id: 'telegram', connessa: true, da: '2026-08-30T12:20:00.000Z', fallimentiDiFila: 0 },
    ]);
  });

  it('e una che cade dopo essere stata su riparte a contare da adesso', () => {
    const s = new SaluteSuperfici();
    s.connessa('telegram', t('2026-08-29T12:30:00Z'));
    s.caduta('telegram', 'TypeError (ECONNRESET)', t('2026-08-29T17:08:00Z'));
    expect(s.stato()[0]).toMatchObject({ da: '2026-08-29T17:08:00.000Z', fallimentiDiFila: 1 });
  });

  it('tiene le superfici separate, in ordine stabile', () => {
    const s = new SaluteSuperfici();
    s.connessa('telegram', t('2026-08-29T12:30:00Z'));
    s.caduta('discord', 'TypeError (ECONNREFUSED)', t('2026-08-29T13:00:00Z'));
    expect(s.stato().map((x) => `${x.id}:${String(x.connessa)}`)).toEqual(['discord:false', 'telegram:true']);
  });
});
