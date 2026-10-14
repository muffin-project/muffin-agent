# DCO agent attribution correction

Date: 2026-10-14. Repository state observed: `dev` at merge commit
`7f54ac46a5c1c927802987e64b0faf67316d76f0`, PR #891.

## Observed fact

The source commit `287c8ec2bf5badab512c7d584cd713d1b97ed248` has author
`Codex <codex@agent.invalid>` and the trailer
`Signed-off-by: Codex <codex@agent.invalid>`. I added `-s` while creating this
agent-authored commit. The required `dco` check passed because
`scripts/check-dco.ts` compared the trailer text with the Git author; it did
not verify whether the signer was a person or could truthfully make the
certification.

## Correction and limits

The trailer is not a valid DCO attestation. The DCO 1.1 text begins its
certification with the contributor's personal statement (“By making a
contribution ... I certify”) and describes rights the certifying person must
hold. A matching Git trailer is only a mechanical string check. See the primary
[DCO 1.1 text](https://developercertificate.org/) and [Linux Foundation DCO
guidance](https://bestpractices.linuxfoundation.org/ip/contribution-mechanisms-dco.html).

The commit is already part of protected `dev`. We did not rewrite published
history, replace the author, or claim that this record makes the old trailer
true. The fix from #891 remains in the repository. This correction does not
provide any retroactive certification or additional relicensing grant; the
repository's existing AGPL license remains unchanged.

## Repair

The owner chose to preserve the fix and correct the prospective policy. ADR-0102
defines an explicit agent identity that cannot sign DCO, exempts that identity
only for owner-opened canonical internal PRs, and keeps the human sign-off
requirement for external contributors. The CI checker and its tests enforce
those boundaries prospectively. They do not retroactively re-evaluate #891.
