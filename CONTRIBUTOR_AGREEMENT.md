# Contributor agreement

Muffin accepts contributions under the GNU Affero General Public License v3 or
later (`LICENSE`). This agreement keeps contributor provenance explicit while
leaving a future owner-approved move to another OSI-approved license possible.
It is not a copyright assignment: contributors retain copyright in their work.

## How to agree

Sign off every commit submitted in a contribution pull request, whether the
pull request is internal or external:

```bash
git commit -s -m "your change"
```

Git adds a trailer matching the commit author, for example:

```text
Signed-off-by: Ada Lovelace <ada@example.com>
```

Submitting a signed-off contribution means you agree to both terms below.
CI checks the commits introduced by the pull request against the exact base and
head SHAs. An internal pull request does not exempt imported commits by outside
authors; preserve their author metadata and obtain each author's sign-off. Only
the canonical same-repository `dev` to `main` promotion skips this check: it
promotes history already integrated into `dev`, including legacy commits from
before the gate. The exception does not certify that historical work.

For AI-assisted work, an agent is not a separate legal contributor and must not
be given a fabricated author identity or sign-off. The human submitting the
work is responsible for deciding whether they can truthfully make the DCO
certification for each concrete commit. Maintainer status, PR authorship, GitHub
authentication, and a matching trailer do not establish that the certification
is true. Never sign on behalf of another author. If you cannot truthfully make
the required certification, do not submit that commit as DCO-certified.

## Developer Certificate of Origin 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this license
document, but changing it is not allowed.

By making a contribution to this project, I certify that:

```text
(a) The contribution was created in whole or in part by me and I have the
    right to submit it under the open source license indicated in the file; or

(b) The contribution is based upon previous work that, to the best of my
    knowledge, is covered under an appropriate open source license and I have
    the right under that license to submit that work with modifications, whether
    created in whole or in part by me, under the same open source license
    (unless I am permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other person who
    certified (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public
    and that a record of the contribution (including all personal information I
    submit with it, including my sign-off) is maintained indefinitely and may be
    redistributed consistent with this project or the open source license(s)
    involved.
```

Source: https://developercertificate.org/ (version 1.1, retrieved 2026-09-14).

## Additional relicense grant

In addition to the DCO, you grant the Muffin project owner a perpetual,
worldwide, non-exclusive, royalty-free right to relicense your contribution,
as part of Muffin or a substantially similar project, under any
OSI-approved open-source license. This grant does not transfer copyright and
does not grant a right to use your name or trademarks.

This clause is deliberately narrow: it supports a future move from AGPL to a
less restrictive OSI license, not a proprietary relicensing path.
