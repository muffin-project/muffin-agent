# Publication secret audit — 2026-09-14 (historical)

> Superseded by [the current-ref audit](publication-secret-audit-2026-09-24.md). This historical scan is not publication approval and does not satisfy the current fresh-reader privacy check.

## Method

- Tool: Gitleaks 8.30.1 with the default ruleset.
- Range: HEAD and reachable history, 1,124 commits and about 72.6 MB at that time.
- Complement: tracked-file checks for database dumps, private keys and backups, plus a scan for the owner-home path and machine-specific values.

## Historical result

The scan reported 100 findings across six distinct synthetic fixture/example values. They were in tests, redaction examples or generated architecture-map output; none were production credentials. Literal canary values have been removed from this report. Rule counts were 97 `generic-api-key`, 2 `curl-auth-header` and 1 `github-pat`.

The tracked-file check at that earlier HEAD found no database dumps, private keys, backups or owner-home path. Those results apply only to that snapshot and scanner scope.

## Known limits

1. A secret scanner cannot judge owner-specific prose or every machine-specific detail; those require human review.
2. A prior GitHub issue-body revision needs an independent retrieval check.
3. The exact promoted candidate must be scanned at any future visibility cutover.
