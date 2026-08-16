/**
 * Splitting a reply to fit Discord's message limit.
 *
 * Simpler than `connectors/telegram/render.ts` in the one way that matters:
 * Discord's `content` is interpreted as its own markdown directly, with no
 * HTML-escaping and no expansion step, so the limit is on the same string the
 * model wrote — unlike Telegram, where `**bold**` becomes `<b>bold</b>` and a
 * split computed on the markdown could land the render over the real limit
 * (the shipped bug `render.ts` exists to prevent). There is no such gap here:
 * `text.length` already is the rendered length.
 *
 * What still needs care: a split that lands inside an open ``` code fence
 * produces one message with unterminated markdown (everything after renders
 * as code, including the next message once Discord starts a fresh block) and
 * a second one that opens on a fence with no matching close. Both parts are
 * reopened/closed the same way `render.ts` does for Telegram.
 */

/** Discord's documented limit for a message's `content`. */
export const DISCORD_MAX = 2000;

/** Continuation marker, short enough to never itself push a part over the limit. */
const FENCE = '```';

export function renderForDiscord(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return ['(risposta vuota)'];
  if (trimmed.length <= DISCORD_MAX) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;
  let openFence = false;

  while (rest.length > 0) {
    // Budget for this part: the whole limit, minus room for a closing fence
    // this part might need to add and an opening one the next part might need.
    const budget = DISCORD_MAX - (openFence ? FENCE.length : 0);
    let cut = rest.length <= budget ? rest.length : findBreak(rest, budget);

    let piece = rest.slice(0, cut);
    // Track fences crossed *inside* this piece to know the state at its end.
    const fencesInPiece = (piece.match(/```/g) ?? []).length;
    const endsOpen: boolean = openFence ? fencesInPiece % 2 === 0 : fencesInPiece % 2 === 1;

    if (endsOpen && cut < rest.length) piece += `\n${FENCE}`;
    parts.push((openFence ? `${FENCE}\n` : '') + piece);

    openFence = endsOpen;
    rest = rest.slice(cut).replace(/^\n/, '');
  }

  return parts;
}

/** The last newline at or before `budget`, or a hard cut if the line itself is too long. */
function findBreak(text: string, budget: number): number {
  const window = text.slice(0, budget);
  const lastNewline = window.lastIndexOf('\n');
  return lastNewline > budget * 0.5 ? lastNewline : budget;
}
