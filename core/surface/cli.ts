import { DELIVERED, type DeliveryOutcome, type Surface } from './types.js';

/**
 * The terminal, as a surface like any other.
 *
 * This file is small, and its size is the point. The CLI used to be the `if` at
 * the top of three different `Deliver` implementations —
 * `if (channel === 'cli') { write(text); return; }` — which is what "la CLI è la
 * superficie primaria" had degraded into: not primary, *special-cased*. Owner
 * directive, verbatim: *«mi sembra che siamo troppo basati su telegram, noi
 * siamo CLI»*. A primary surface implements the contract; it does not get
 * exempted from it.
 *
 * Making it an implementation buys one concrete thing beyond tidiness: the CLI
 * is now the surface the registry finds by *asking*, so a home with Telegram
 * enabled and the CLI present no longer has two code paths deciding delivery in
 * two files that can disagree — and they did.
 *
 * It lives in `core/` rather than `cli/` because `core/scheduler` and
 * `cli/observe.ts` both need it, and `core/` importing from `cli/` would invert
 * the dependency the rest of the tree keeps in one direction.
 */

/**
 * Where the terminal's copy goes. Injected because the three callers write to
 * three different places — the REPL has to reprint its prompt afterwards, the
 * gateway's stdout is the journal under a supervisor, and a test wants an array.
 */
export type CliWriter = (text: string) => void;

/**
 * L0-1: the surface of last resort, which is why it cannot be disabled and why
 * it is the only one whose `handles` does not depend on configuration.
 *
 * `maxMessageChars` is `Infinity` and that is a statement, not a placeholder: a
 * terminal has no message limit, and giving it a fake one would make the
 * splitter cut prose that nothing was going to reject.
 */
export function cliSurface(write: CliWriter): Surface {
  return {
    id: 'cli',
    limits: {
      maxMessageChars: Number.POSITIVE_INFINITY,
      // A terminal moves no bytes. Zero rather than Infinity so a caller that
      // asks "can I attach this here" is told no, instead of being told yes and
      // discovering there is no code to do it.
      maxUploadBytes: 0,
      maxDownloadBytes: 0,
    },
    handles: (channel) => channel === 'cli',
    deliver: async (_channel, text): Promise<DeliveryOutcome> => {
      write(text);
      // The one surface that can honestly say this without asking anyone: the
      // bytes are on the file descriptor, and there is no second hop that can
      // fail after this function returns.
      return DELIVERED;
    },
  };
}
