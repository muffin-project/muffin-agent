import { describe, expect, it } from 'vitest';
import { SANDBOX_BINARIES_REMEDY } from './probe.js';

describe('sandbox dependency remedy by platform', () => {
  it('never tells a macOS owner to install Linux-only bubblewrap or socat', () => {
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/macOS usa Seatbelt integrato/i);
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/brew install ripgrep/);
    expect(SANDBOX_BINARIES_REMEDY).not.toMatch(/brew install (?:bubblewrap|socat)/);
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/non installare bubblewrap o socat/i);
  });

  it('keeps the complete Linux dependency set in the same authoritative remedy', () => {
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/Linux usa tre binari: bubblewrap, socat e ripgrep/i);
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/apt-get install bubblewrap socat ripgrep/);
    expect(SANDBOX_BINARIES_REMEDY).toMatch(/dnf install bubblewrap socat ripgrep/);
  });
});
