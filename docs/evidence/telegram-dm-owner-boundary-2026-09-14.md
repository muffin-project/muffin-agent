# Telegram private-DM authorization boundary — 2026-09-14

## Question

Can an account other than the configured owner make the personal Telegram bot
run a turn or retain a private message?

## Observed Muffin path

At `879887b`, `connectors/telegram/connector.ts` returns `true` from
`apreUnTurno()` for every private chat. The shared ingress router then orders
`gate → remember → command → work`. `identify()` in `core/surface/types.ts`
marks a different sender as `member`, but that result was not used by the
Telegram gate. The owner-only command guard and tier-2 principal therefore do
not prevent a non-owner private message from calling the model.

## Candidates and evidence

| Candidate | Evidence | Decision |
|---|---|---|
| Authenticated owner-only gate; silently drop others before memory/commands/model | The transport already resolves stable sender identity and the user explicitly requires no reply to other accounts. | Choose; least authority and least disclosure. |
| Pairing prompt for unknown DMs | OpenClaw documents pairing as its default DM policy; unknown messages wait for approval. | Reject here: it still replies to strangers and expands the owner-only bot into an onboarding surface. |
| Disable every private chat | Closes the ingress but also removes the owner’s primary control surface. | Reject as broader than needed. |
| Preserve current `isPrivate`-only gate | Contradicted by the production path and installed inbox evidence. | Reject. |

Peer source: [OpenClaw access control and allowlists](https://docs.openclaw.ai/gateway/security/access-control), checked 2026-09-14. Its policy makes DM admission explicit (`pairing`, `allowlist`, `open`, `disabled`) and ignores unapproved senders under pairing/allowlist. We adopt its pre-model placement and explicit authorization boundary, not its pairing prompt.

## Reversal condition

Revisit this decision only if the owner explicitly chooses to make Muffin a
multi-user/public Telegram bot. That requires a separate allowlist/pairing
policy and capability/tenant review; changing this gate alone is insufficient.
