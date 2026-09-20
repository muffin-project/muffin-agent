# Security policy

This file is **vulnerability disclosure**: where and how to report a security
issue in this repository. It is not the same document as
[`docs/SECURITY.md`](docs/SECURITY.md), which is Muffin's **threat model** — what
the system is trying to make true at its trust boundaries, and which
guarantees exist today versus which are architecturally decided but not yet
enforced. Read this file to report a vulnerability; read `docs/SECURITY.md` to
understand what Muffin defends against and why.

## Reporting a vulnerability

While this repository is private, report security issues confidentially to
**[ciao@giusto.dev](mailto:ciao@giusto.dev)**. Do not include real owner data,
Muffin Home contents, database dumps or credentials unless they are strictly
necessary to reproduce the issue; prefer redacted fixtures and placeholders.

Once the repository becomes public, **GitHub Private Vulnerability Reporting**
will become the preferred intake path:

**Security** tab → **Report a vulnerability**.

GitHub's documentation describes that private-advisory flow here:
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>.

Private Vulnerability Reporting is available only for public repositories, so
the email route above remains the confidential preview channel until the
visibility cutover. After PVR is enabled, `ciao@giusto.dev` remains a fallback
project contact rather than replacing the private advisory workflow.

**Please do not open a public issue for a security report.** A public issue is
readable by anyone before a fix ships.

## What to include

The more of this you can provide, the faster a report can be triaged:

* what you did, and what you expected instead;
* the exploit path — which trust boundary it crosses, and what authority or
  data it reaches that it should not;
* a reproduction (commands, a minimal config, a transcript) where one is
  possible;
* the commit or release you tested against.

## Scope

This policy covers the code, configuration and default assets shipped in this
repository. It does not cover an individual owner's installed `~/.muffin`
home, secrets, or model provider accounts — those are the owner's own
responsibility and are never meant to be shared with a maintainer as part of a
report.
