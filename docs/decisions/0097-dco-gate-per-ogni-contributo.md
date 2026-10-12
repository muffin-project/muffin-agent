# ADR-0097 — DCO su ogni contributo

**Stato: accettato.** Supersedes the CI scope in ADR-0079; it does not change
the DCO 1.1 or the OSI-only relicense grant recorded there.

**Contesto.** ADR-0079 described an external-PR gate with a username-based owner
bootstrap exemption. CI subsequently checked every contribution PR, including
maintainer PRs, except canonical same-repository `dev` to `main` promotion.
The two policies disagree, and an internal PR can contain imported commits by
outside authors.

**Decisione.** Every non-merge commit introduced by a contribution PR must carry
a `Signed-off-by` trailer matching its Git author, regardless of who opened the
PR or whether the branch is in this repository. This preserves the original
author and requires an imported outside commit to bring its own sign-off. The
only exception is the canonical same-repository `dev` to `main` promotion,
which promotes already integrated history, including legacy pre-gate commits.
The exception does not certify that historical work. CI checks exact PR base/head
SHAs; malformed event metadata fails closed.

The DCO and its narrow OSI-approved relicense grant apply to maintainers and
outside contributors alike. Agent assistance does not create a separate legal
contributor identity. A human who submits an assisted contribution remains
responsible for deciding whether they can truthfully make the DCO certification
for each concrete commit. Maintainer role, PR authorship, GitHub authentication,
and a matching trailer do not themselves establish that certification. Do not
fabricate a trailer, change another author's identity, or sign on another
author's behalf. Preserve outside authorship and obtain that author's sign-off
where it is required.

**Consequences.** The check catches absent or mismatched trailers and prevents
internal-PR status from bypassing imported unsigned commits. It cannot verify
the signer's identity, authority, rights, or the truth of the DCO statement;
those remain human responsibilities. This decision grants no retroactive rights
and does not silently certify existing unsigned commits.

**Reversibilità.** The mechanical gate can be changed prospectively, but any
different contribution-rights model requires a new decision and cannot create a
retroactive grant.
