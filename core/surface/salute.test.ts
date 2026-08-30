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
   * lampo e un guasto di diciannove ore non devono somigliarsi. La durata la
   * porta `da`, che resta quello del **primo** fallimento della serie.
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
