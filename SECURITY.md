# Security policy

This file is **vulnerability disclosure**: where and how to report a security
issue in this repository. It is not the same document as
[`docs/SECURITY.md`](docs/SECURITY.md), which is Muffin's **threat model** — what
the system is trying to make true at its trust boundaries, and which
guarantees exist today versus which are architecturally decided but not yet
enforced. Read this file to report a vulnerability; read `docs/SECURITY.md` to
understand what Muffin defends against and why.

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository:

**Security** tab → **Report a vulnerability**.

This opens a private advisory visible only to maintainers and to you as the
reporter — never a public issue. GitHub's own documentation describes the
mechanism and its guarantees:
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>.

This channel does not require an email address on either side, and none is
published in this file: GitHub mediates the report and the ensuing discussion
inside the advisory.

**Current status.** Private vulnerability reporting only works on **public**
repositories, and this repository is private today. The button will appear once
the repository is public and a maintainer enables the feature from
**Settings → Advanced Security → Private vulnerability reporting**
(prerequisites and steps documented at
<https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository>).
While the repository stays private, anyone with access already has a private
channel to its owner; this file describes the channel this repository will use
once that stops being true.

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
