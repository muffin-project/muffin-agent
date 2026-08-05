import DatabaseCtor from 'better-sqlite3';
import { parseArgs } from 'node:util';

/**
 * What the old Muffin actually sounded like.
 *
 * Voice is observable: emoji, length, how it opens and closes, the phrases it
 * reaches for. Character is not — how it behaves when it has to disagree with
 * you is nowhere in a frequency table, which is why identity.md stays the
 * owner's to write and this only ever feeds voice.md.
 *
 * It measures and shows; it does not decide. A June audit of the old system
 * found the voice solid but drifting — a 🧠 tic, a fixed template on morning
 * messages, an expert register in groups that nobody asked for. Extracting the
 * regularities wholesale would import the drift along with the voice, so the
 * output is material to curate, not a file to copy.
 *
 * Pure statistics, no model calls: free, deterministic, and re-runnable.
 *
 *   tsx evals/memory/voice.ts --source ~/dev/Muffin/muffin.dev.db
 *   tsx evals/memory/voice.ts --source ... --proactive   # only what it said unprompted
 */

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    proactive: { type: 'boolean' },
    top: { type: 'string' },
    'max-share': { type: 'string' },
  },
});

if (!values.source) {
  process.stderr.write('serve --source <percorso del vecchio muffin.db>\n');
  process.exit(78);
}

const db = new DatabaseCtor(values.source, { readonly: true, fileMustExist: true });
const top = Number(values.top ?? 15);

/** Reads whichever schema is in front of it: this one, or the previous system's. */
const hasEpisodesRole =
  db
    .prepare(`SELECT count(*) AS n FROM pragma_table_info('episodes') WHERE name = 'role'`)
    .get() as { n: number };

const rows = (
  hasEpisodesRole.n > 0
    ? db
        .prepare(
          `SELECT content, 0 AS proactive FROM episodes
           WHERE role = 'agent' AND content IS NOT NULL AND trim(content) <> ''`,
        )
        .all()
    : db
        .prepare(
          `SELECT content, COALESCE(proactive,0) AS proactive
           FROM raw_messages
           WHERE role = 'assistant' AND content IS NOT NULL AND trim(content) <> ''
             AND (:onlyProactive = 0 OR COALESCE(proactive,0) = 1)`,
        )
        .all({ onlyProactive: values.proactive ? 1 : 0 })
) as { content: string; proactive: number }[];

if (rows.length === 0) {
  process.stderr.write('nessun messaggio trovato\n');
  process.exit(1);
}

/**
 * Machine output wearing a message's clothes.
 *
 * The dream cycle dumped its own report into the chat: telemetry prefixes,
 * "archi decaduti rimossi", "reward signals deliveries avg". Left in, it
 * dominates every frequency table and the profile describes a cron job rather
 * than a voice. This is the filter the first run of this tool asked for.
 */
const MACHINE = [
  /^\s*\[/,                                   // [dream cycle], [1 min ...
  /archi decaduti|reward signals|deliveries avg/i,
  /estrazione pattern comportamentali/i,
  /^\s*(buongiorno[,!]?\s*)?stanotte\b/i,      // the morning template
  /\bcycle azioni completate\b/i,
];
const isMachine = (t: string) => MACHINE.some((re) => re.test(t));

const all = rows.map((r) => r.content);
const texts = all.filter((t) => !isMachine(t));
const filtered = all.length - texts.length;
const say = (s: string) => process.stdout.write(`${s}\n`);

say(`# Voce del vecchio Muffin — ${texts.length} messaggi${values.proactive ? ' (solo proattivi)' : ''}`);
if (filtered > 0) {
  say('');
  say(`_${filtered} messaggi esclusi come output di macchina (report del dream cycle, prefissi di telemetria,_`);
  say('_template mattutino): non sono voce, e lasciati dentro dominano ogni conteggio._');
}
say('');
say('_Materiale da curare, non da copiare. Quello che riconosci come voce va in `voice.md`;_');
say('_quello che riconosci come deriva si lascia qui._');
say('');

// --- length ------------------------------------------------------------------
const lengths = texts.map((t) => t.length).sort((a, b) => a - b);
const pct = (p: number) => lengths[Math.floor((lengths.length - 1) * p)] ?? 0;
say('## Lunghezza');
say('');
say(`mediana **${pct(0.5)}** caratteri · un quarto sotto ${pct(0.25)} · un quarto sopra ${pct(0.75)} · massimo ${pct(1)}`);
const short = texts.filter((t) => t.length < 200).length;
say(`${Math.round((short / texts.length) * 100)}% dei messaggi sta sotto i 200 caratteri`);
say('');

// --- emoji -------------------------------------------------------------------
// Explicit ranges rather than \p{Emoji}: the property class matches digits and
// '#', which would drown the real signal in punctuation.
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F900}-\u{1F9FF}]/gu;
const emojiCount = new Map<string, number>();
let messagesWithEmoji = 0;
for (const text of texts) {
  const found = text.match(EMOJI);
  if (!found) continue;
  messagesWithEmoji += 1;
  for (const e of found) {
    if (e === '️') continue; // variation selector, not a glyph
    emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
  }
}
say('## Emoji');
say('');
say(`in **${Math.round((messagesWithEmoji / texts.length) * 100)}%** dei messaggi`);
say('');
const maxShare = Number(values['max-share'] ?? 15);
const emojiRanked = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
const overThreshold: string[] = [];
for (const [emoji, n] of emojiRanked) {
  const share = Math.round((n / texts.length) * 100);
  // Past the threshold it stopped being emotional punctuation and became a
  // signature — and a fixed signature stops meaning anything.
  const over = share > maxShare;
  if (over) overThreshold.push(`${emoji} ${share}%`);
  say(`${String(n).padStart(5)}  ${emoji}  (${share}%)${over ? `  ← oltre il ${maxShare}%: firma, non punteggiatura` : ''}`);
}
say('');
if (overThreshold.length > 0) {
  say(`**Deriva**: ${overThreshold.join(', ')} — \`voice.md\` dice che nessuna emoji supera il ${maxShare}%.`);
  say('');
}

// --- formatting --------------------------------------------------------------
const has = (re: RegExp) => texts.filter((t) => re.test(t)).length;
say('## Formattazione');
say('');
for (const [label, re] of [
  ['grassetto **…**', /\*\*[^*]+\*\*/],
  ['elenchi puntati', /^\s*[-•]\s+/m],
  ['elenchi numerati', /^\s*\d+[.)]\s+/m],
  ['blocchi di codice', /```/],
  ['domanda finale', /\?\s*$/],
  ['più paragrafi', /\n\s*\n/],
] as const) {
  say(`${String(Math.round((has(re) / texts.length) * 100)).padStart(3)}%  ${label}`);
}
say('');

// --- openings and closings ---------------------------------------------------
const firstWords = new Map<string, number>();
const lastLines = new Map<string, number>();
for (const text of texts) {
  const opening = text.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/[.,:!?]/g, '');
  if (opening) firstWords.set(opening, (firstWords.get(opening) ?? 0) + 1);
  const closing = text.trim().split('\n').pop()?.trim().slice(0, 60).toLowerCase();
  if (closing && closing.length > 8) lastLines.set(closing, (lastLines.get(closing) ?? 0) + 1);
}
say('## Come apre');
say('');
for (const [phrase, n] of [...firstWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  say(`${String(n).padStart(5)}  "${phrase}…"`);
}
say('');
say('## Chiuse che si ripetono');
say('');
const repeatedClosings = [...lastLines.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]);
if (repeatedClosings.length === 0) say('_nessuna chiusa ricorrente — buon segno, niente template_');
for (const [phrase, n] of repeatedClosings.slice(0, top)) {
  // A closing repeated dozens of times is a template, and templates were the
  // documented drift of the old system.
  say(`${String(n).padStart(5)}  "${phrase}"${n > 15 ? '  ← template?' : ''}`);
}
say('');

// --- recurring phrases -------------------------------------------------------
const STOP = new Set(
  'e di che a il la i le un una in per con non è ho hai ha se ma da del della dei si sì no come su tra fra più lo gli al alle allo dal dalla nel nella cosa quando dove perché anche solo già poi ora qui questo questa quello quella tu io mi ti ci vi ne lì'.split(
    ' ',
  ),
);
const trigrams = new Map<string, number>();
for (const text of texts) {
  const words = text
    .toLowerCase()
    .replace(/[^a-zà-ú\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  for (let i = 0; i + 2 < words.length; i++) {
    const gram = words.slice(i, i + 3).join(' ');
    if (words.slice(i, i + 3).every((w) => STOP.has(w))) continue;
    trigrams.set(gram, (trigrams.get(gram) ?? 0) + 1);
  }
}
say('## Espressioni ricorrenti');
say('');
for (const [gram, n] of [...trigrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  say(`${String(n).padStart(5)}  "${gram}"`);
}
say('');

// --- register ----------------------------------------------------------------
const countWord = (re: RegExp) => texts.filter((t) => re.test(t)).length;
say('## Registro');
say('');
say(`${String(Math.round((countWord(/\b(tu|ti|tuo|tua|sei|hai)\b/i) / texts.length) * 100)).padStart(3)}%  dà del tu`);
say(`${String(Math.round((countWord(/\b(lei|suo|sua)\b/i) / texts.length) * 100)).padStart(3)}%  forme di cortesia`);
say(`${String(Math.round((countWord(/\b(forse|magari|potrebbe|sembra|credo|direi)\b/i) / texts.length) * 100)).padStart(3)}%  attenua ("forse", "direi", "sembra")`);
say(`${String(Math.round((countWord(/\b(non so|non ne ho idea|non riesco|non posso)\b/i) / texts.length) * 100)).padStart(3)}%  ammette di non sapere`);
say(`${String(Math.round((countWord(/\b(scusa|mi dispiace|perdona)\b/i) / texts.length) * 100)).padStart(3)}%  si scusa`);
say('');

db.close();

// Exit code so this can gate a release instead of being read by eye — which is
// exactly what did not happen last time.
process.exitCode = overThreshold.length > 0 ? 1 : 0;
