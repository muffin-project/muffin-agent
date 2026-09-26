# Publication secret audit

## Current status — 2026-09-24

**This scan does not clear the repository for public visibility.** The repository is still private, and the privacy/history gate in issue #464 remains on hold.

I scanned a read-only mirror of the observed GitHub refs with Gitleaks 8.30.1 and its default rules, using redacted output. The snapshot had 572 refs, with `main` at `7721d63d0912fe217a88a4bb726b71d071f380db` and `dev` at `db2bb7ac28d1c21f6113e18667361f7f4fa4364a`. Before disposition, Gitleaks reported 280 findings in 12 files, across 260 commits and 22 distinct path/rule/line locations. After applying the 280 exact entries, the same all-ref command reported 2,823 commits scanned, about 166.90 MB, and zero unmatched findings.

The finding locations are test fixtures and redaction examples, or generated architecture-map artifacts. The two map HTML files account for 240 findings; the generated blueprint data accounts for two more. The remaining 38 are in test/redaction code. The exact Gitleaks fingerprints are listed in the root `.gitleaksignore`; the list contains no path-wide, rule-wide or directory-wide exemption. The matched values are not copied into this report. A previous version of the historical report included literal, explicitly synthetic token-shaped test canaries; this file omits them now, but those prior commits remain in Git history. They were reviewed as test examples, not production credentials.

Gitleaks fingerprints identify finding locations in particular commits; they are not a semantic privacy scan. Excluding these inspected historical examples only prevents known test and generated-data matches from obscuring new findings. A future commit is scanned under its own fingerprint.

### Still unresolved

- The exact pre-rewrite commit SHA and the two canonical owner-PII fingerprints required for the fresh-reader retrieval check are not present in the available issue evidence or this mirror's findings. That check has not run.
- The mirror is authenticated. Because the repository is private, this run cannot prove what an ordinary unauthenticated reader can fetch after GitHub Support's cache-clear/garbage-collection work.
- Do not treat a zero-finding scan with `.gitleaksignore` as proof that history is free of personal data or secrets. No visibility change is authorized by this evidence.

## Historical scan — 2026-09-14

This section preserves the earlier scanner result as historical evidence only. It is not a substitute for the current-ref scan or the unresolved fresh-reader check above.

Scope: issue #464, scanner pass on HEAD and reachable history using Gitleaks 8.30.1 with the default ruleset. That run scanned 1,124 commits (about 72.6 MB) and reported 100 findings across six distinct synthetic fixture/example values. The old table of literal canaries has been removed; none were production credentials. The tracked-file check found no database dumps, private keys, backups or owner-home path at that earlier HEAD.

### Historical residuals

1. Owner personal-data prose and machine-specific details require a separate human review; the scanner cannot classify them.
2. GitHub-side deletion of a prior issue-body revision requires an independent retrieval check.
3. The scanner must be rerun on the exact promoted candidate at any future cutover.
