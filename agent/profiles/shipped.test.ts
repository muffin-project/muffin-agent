import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfiles, selectProfile } from './profile.js';

/**
 * The shipped JSON profiles, pinned verbatim.
 *
 * Nothing referenced them: every cascade test builds its own profile object, so
 * the judge reverted frontier to the exact behaviour the recovery slice exists
 * to end — four identical nudges' little sibling, nudge-nudge — and 563 tests
 * stayed green. Emptying consumer-local's cascade entirely also stayed green.
 * The reachability chain of that slice STARTS at these files, and step one was
 * the unpinned one.
 *
 * Verbatim, not shape-only: the cascade's order is behaviour now (attempt N is
 * strategy N), so a reorder is as real a change as a removal, and a JSON edit
 * must fail something before it silently changes what a weak model gets.
 */

describe('shipped profiles', () => {
  const profiles = loadProfiles();

  it('all load, through the same parser production uses', () => {
    expect(profiles.map((p) => p.name).sort()).toEqual(['consumer-local', 'consumer-qwen3', 'frontier']);
  });

  it('frontier: a nudge and one retry, in that order', () => {
    const frontier = profiles.find((p) => p.name === 'frontier');
    expect(frontier?.recovery).toEqual(['nudge', 'retryOnce']);
    expect(frontier?.thinking).toBe('adaptive');
  });

  /**
   * Changed deliberately, and this is the note the next reader needs: it used to
   * pin `thinking: 'allowed'` and `frontier` used to declare it.
   *
   * `'allowed'` was a permission for a thinking *budget*, and the budget shape
   * (`{type:'enabled', budget_tokens}`) is a 400 on every model the globs above
   * match. So the old pin was not protecting behaviour — it was protecting a
   * word for a request we could never legally send. The pin stays verbatim
   * (ADR-0037); the vocabulary under it is the thing that moved.
   */
  it('frontier: the two request knobs the 5-series actually has', () => {
    const frontier = profiles.find((p) => p.name === 'frontier');
    // Not 'allowed', and not absent: on these models thinking is on unless
    // disabled, so the declaration has to name a mode the wire understands.
    expect(frontier?.thinking).toBe('adaptive');
    // temperature is a 400 on Opus 4.7 and later. The default install
    // (`muffin init` → claude-sonnet-5 → this profile) depends on this value.
    expect(frontier?.sampling).toBe('model-default');
  });

  it('consumer-local: the full cascade, in the declared order', () => {
    const consumer = profiles.find((p) => p.name === 'consumer-local');
    // `requireTool` last (ADR-0082): the wire escalation that answers the
    // Gemma stall — `stop` + prose + zero calls — after the gentler rungs ran.
    expect(consumer?.recovery).toEqual(['nudge', 'reinjectTools', 'retryOnce', 'strictJson', 'requireTool']);
    // `adaptive` dal 27/08, per decisione dell'owner, e il cambio è vero: da
    // #167 l'adapter openai-compat manda davvero `reasoning:{effort:none}` su
    // OpenRouter, quindi `off` su una famiglia a reasoning ibrido spegneva il
    // ragionamento sul turno di conversazione invece di non fare niente.
    // `adaptive` non chiede nessun livello, e da #789 l'adapter onora anche i
    // livelli: resta il valore giusto QUI perché questa famiglia non ne condivide
    // uno — `xhigh` è del solo qwen3 (catalogo OpenRouter 01/10/2026:
    // `gpt-oss-120b` `['high','medium','low']`, `mistral-small-2603`
    // `['high','none']`), e pinnarlo condiviso sarebbe un errore di
    // configurazione hard a ogni turno loro.
    expect(consumer?.thinking).toBe('adaptive');
    // Small local models wander without it, and every server they run on takes it.
    expect(consumer?.sampling).toBe('deterministic');
  });

  it('consumer-qwen3: xhigh — the model own default, made explicit', () => {
    const qwen3 = profiles.find((p) => p.name === 'consumer-qwen3');
    // Non `off` (l'evidenza negativa dell'owner riguardava quello: la
    // conversazione rimbalzava) e non un abbassamento: #498 resta aperta per
    // l'A/B di `medium`/`low`. `xhigh` è ciò che il modello fa da solo quando
    // non gli si dice niente (`default_effort: 'xhigh'` su ogni qwen3.8 del
    // catalogo OpenRouter; il template Qwen3.8 di vLLM accetta
    // `xhigh|medium|low`): la spesa non cambia, cambia che la manopola ha un
    // livello da mostrare e la richiesta lo dichiara.
    expect(qwen3?.thinking).toBe('xhigh');
    // Il rovescio dichiarato del pinnare un livello: `adaptive` non può mai
    // fallire, un livello sì se il server cambia l'insieme accettato. Vedi le
    // note del file.
    // Everything else is a copy of consumer-local, kept aligned by hand: the
    // silent tool cut of 27/08 is the measured cost of letting them drift.
    const consumer = profiles.find((p) => p.name === 'consumer-local');
    expect(qwen3?.recovery).toEqual(consumer?.recovery);
    expect(qwen3?.sampling).toBe(consumer?.sampling);
    expect(qwen3?.maxToolsExposed).toBe(consumer?.maxToolsExposed);
    expect(qwen3?.maxToolCallsPerTurn).toBe(consumer?.maxToolCallsPerTurn);
    expect(qwen3?.toolResultBudgetChars).toBe(consumer?.toolResultBudgetChars);
    expect(qwen3?.execution).toEqual(consumer?.execution);
  });

  it('consumer-local: has no arbitrary call ceiling and allows a 15-minute horizon', () => {
    const consumer = profiles.find((p) => p.name === 'consumer-local');

    // Multi-step work is bounded by time, spend and explicit cancellation,
    // not by an arbitrary number of tool calls.
    expect(consumer?.maxToolCallsPerTurn).toBeNull();
    expect(consumer?.execution).toMatchObject({
      turnWallDeadlineMs: 900_000,
      activeModelBudgetMs: 900_000,
    });
  });

  it('consumer-local: compacts tool results earlier than the global default', () => {
    // Misurato il 30/09/2026 sull'installazione dell'owner: un debug pip da 17
    // call è morto due volte in `model_deadline` a 32k token in ingresso con
    // TTFT fino a 35s, mentre il budget di compattazione (60k char) non è mai
    // scattato — tarato sui numeri Anthropic per modelli frontier, non su un
    // qwen via OpenRouter con 90s di deadline per chiamata. Questo profilo
    // compatta da 16k char (~4k token di risultati): i risultati recenti, quelli
    // su cui il modello sta ragionando, restano; il resto diventa placeholder
    // con la via del re-read.
    const consumer = profiles.find((p) => p.name === 'consumer-local');
    expect(consumer?.toolResultBudgetChars).toBe(16_000);
  });

  it('frontier: no per-profile compaction budget, inherits the global default', () => {
    // Il profilo forte (deadline 120s, modello frontier) tiene il default: il
    // campo assente nel JSON si materializza dal loader, mai come undefined.
    const frontier = profiles.find((p) => p.name === 'frontier');
    expect(frontier?.toolResultBudgetChars).toBe(60_000);
  });

  it('a profile written before the compaction budget existed inherits the global default', () => {
    // Come `sampling`: il default è ciò che il loop faceva prima che il campo
    // esistesse, così un profilo di terze parti non acquisisce in silenzio un
    // comportamento nuovo all'upgrade.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'old.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'old',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: [],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(problems).toEqual([]);
    expect(loaded[0]?.toolResultBudgetChars).toBe(60_000);
  });

  it('a profile from before `sampling` existed keeps the behaviour it had', () => {
    // The field is defaulted rather than required precisely so a third-party
    // profile does not silently acquire a new request shape on upgrade.
    // `deterministic` is what the loop hardcoded before the field existed.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'old.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'old',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: [],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(problems).toEqual([]);
    expect(loaded[0]?.sampling).toBe('deterministic');
  });

  it('a profile still saying `allowed` is refused, not quietly reinterpreted', () => {
    // The alternative was an alias mapping 'allowed' → 'adaptive'. Rejected: it
    // would keep a word alive that names a budget the API deleted, and this
    // repo's failure mode is exactly the mechanism that keeps appearing to work.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'legacy.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'legacy',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'allowed',
        recovery: [],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(loaded).toEqual([]);
    expect(problems[0]).toContain('legacy.json');
  });

  it('names the field, not just that something was invalid', () => {
    // D4 (judge, 2026-08-13): measured on the wire, this message used to be
    // exactly `profilo frontier.json scartato: Invalid option: expected one
    // of "off"|"adaptive"` — the zod message on its own, naming neither the
    // field nor (downstream, before D3/D4's doctor fix) the cost of the drop.
    // zod's own issue carries the path; the boundary just was not reading it.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'frontier.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'frontier',
        match: ['*claude-sonnet-5*'],
        maxToolsExposed: 24,
        maxToolCallsPerTurn: 30,
        thinking: 'allowed', // stale, pre-ADR-0037 vocabulary
        sampling: 'model-default',
        recovery: ['nudge', 'retryOnce'],
        notes: '',
      }),
    );
    loadProfiles(tmp, (line) => problems.push(line));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('thinking');
  });

  it('the models the owner actually runs select the profiles meant for them', () => {
    // The join between the JSON's glob and the configured model id: a rename on
    // either side breaks selection silently, and selection decides everything
    // downstream — cap, thinking, cascade.
    expect(selectProfile('anthropic/claude-sonnet-5', profiles).name).toBe('frontier');
    expect(selectProfile('qwen/qwen3-max', profiles).name).toBe('consumer-qwen3');
    expect(selectProfile('qwen/qwen3.8-flash-next', profiles).name).toBe('consumer-qwen3');
    // Il confine dello split del 01/10/2026: il resto della famiglia consumer
    // NON deve ereditare il livello di qwen3, e qwen3 non deve cadere sul
    // fallback conservativo.
    expect(selectProfile('openai/gpt-oss-120b', profiles).name).toBe('consumer-local');
    expect(selectProfile('google/gemma-4-31b-it', profiles).name).toBe('consumer-local');
    expect(selectProfile('some-model-nobody-knows', profiles).name).toBe('conservative');
  });

  it('claude-opus-4-7 and claude-opus-4-8 land on frontier, not the 400 they used to get', () => {
    // N4 (judge, 2026-08-13): both are real, current, shipped model ids
    // (verified against the live model list) that reject temperature same as
    // Opus 5 — before this glob, an owner on either one got CONSERVATIVE,
    // sampling=deterministic, temperature:0, a 400 on every single turn.
    expect(selectProfile('claude-opus-4-7', profiles).name).toBe('frontier');
    expect(selectProfile('claude-opus-4-8', profiles).name).toBe('frontier');
  });

  it('claude-mythos-5 still falls to conservative — deliberately, not forgotten', () => {
    // D1: Mythos 5 shares Fable 5's spec, and CONSERVATIVE's thinking:'off'
    // would 400 it exactly like Fable 5 (always-on thinking, rejects
    // {type:'disabled'}). Not added to frontier.json's match array anyway:
    // it is invite-only (Project Glasswing, no self-serve access, read
    // 2026-08-13), so almost no install can reach it. Pinned here so the day
    // someone "fixes" this by adding the glob, they find this comment instead
    // of silently re-deciding it — and re-verify the request shape first, as
    // frontier.json's own note says.
    expect(selectProfile('claude-mythos-5', profiles).name).toBe('conservative');
  });

  it('a profile with an unknown recovery name is refused at the boundary, out loud', () => {
    // Pre-slice a typo here was inert (it only padded a counter). Once the
    // cascade executes as declared, an unknown name was a TypeError thrown
    // mid-recovery — armed exactly when the recovery it names was needed. The
    // boundary now drops the profile and says so; selection falls through to
    // the conservative floor instead of detonating later.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'typo.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'typo',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: ['reinject_tools'],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(loaded).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('typo.json');
  });
});
