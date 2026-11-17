import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CI bubblewrap attachment', () => {
  it('installs the pinned binary under /usr/local and does not render a second profile on /usr/bin/bwrap', () => {
    const install = readFileSync('scripts/install-ci-bubblewrap.sh', 'utf8');
    expect(install).toMatch(/^bash "\$here\/install\/bubblewrap.sh" build \/ \/usr\/local$/m);
    expect(install).not.toMatch(/^bash "\$here\/install\/bubblewrap.sh" build \/ \/$/m);

    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).not.toContain('s|<BWRAP_BINARY>|/usr/bin/bwrap|');
    expect(workflow.match(/scripts\/install-ci-apparmor\.sh/g)?.length).toBe(3);

    const attach = readFileSync('scripts/install-ci-apparmor.sh', 'utf8');
    expect(attach).toContain('/usr/bin/bwrap | /bin/bwrap)');
    expect(attach).toContain('refusing to attach muffin-bwrap');
  });
});
