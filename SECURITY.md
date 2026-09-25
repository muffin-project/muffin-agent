# Security policy

This file is **vulnerability disclosure**: where and how to report a security
issue in this repository. It is not the same document as
[`docs/architecture/SECURITY.md`](docs/architecture/SECURITY.md), which is Muffin's **threat model** — what
the system is trying to make true at its trust boundaries, and which
guarantees exist today versus which are architecturally decided but not yet
enforced. Read this file to report a vulnerability; read `docs/architecture/SECURITY.md` to
understand what Muffin defends against and why.

## Reporting a vulnerability

GitHub's private vulnerability reporting is not currently enabled for this
repository. Until it is enabled, report vulnerabilities confidentially by
email to **[ciao@giusto.dev](mailto:ciao@giusto.dev)**.

Do not open a public issue for a security report. Do not include real owner data,
Muffin Home contents, database dumps or credentials unless they are strictly
necessary to reproduce the issue; prefer redacted fixtures and placeholders.

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
