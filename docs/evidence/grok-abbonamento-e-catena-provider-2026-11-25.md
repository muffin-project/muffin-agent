# Abbonamento Grok e catena di provider — 2026-11-25

Ricerca per [ADR-0110](../decisions/0110-catena-di-provider-in-ordine.md).
Fonti lette il 2026-11-25; [V] = verificato direttamente, [S] = sorgente di
terzi, non verificato da noi contro xAI.

## Un abbonamento SuperGrok/X Premium usabile da un agente terzo?

- xAI annuncia l'uso dell'abbonamento **dentro OpenCode** («Use your SuperGrok
  or X Premium subscription inside OpenCode»), con login nel browser o a codice
  per host remoti, e «more open-source agents and integrations are coming soon».
  [V] https://x.ai/news/grok-opencode — analogo per Kilo Code [V]
  https://x.ai/news/grok-kilocode
- L'OIDC di xAI espone device code, PKCE e client pubblici
  (`token_endpoint_auth_methods_supported` contiene `none`) e scope
  `grok-cli:access`, `api:access`. [V]
  https://auth.x.ai/.well-known/openid-configuration
- Non esiste un programma o una registrazione pubblica di client per agenti
  terzi. OpenCode, Hermes e OpenClaw riusano il `client_id` del Grok CLI
  (`b1a00492-…`). [S] `packages/opencode/src/plugin/xai.ts` in
  anomalyco/opencode; https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- Il traffico dell'abbonamento va a `cli-chat-proxy.grok.com` (Responses API),
  non a `api.x.ai`, che rifiuta un token d'abbonamento (402/403). [S]
  pleaseai/shunt `docs/m6-xai-provider.md`. L'host esiste e chiede
  autenticazione (401 senza token) [V].
- xAI decide lato server quali account ricevono token: 403 segnalati su piani
  SuperGrok standard. [S] Hermes, sezione «HTTP 403 after a successful login».
- Warp: l'abbonamento collegato consuma lo stesso pool settimanale di Grok chat
  e Grok Build. [S] https://docs.warp.dev/agents/inference/grok-subscription/

Conclusione: un login con l'abbonamento è **tecnicamente possibile** e
**tollerato** per i partner nominati, ma Muffin dovrebbe prendere in prestito
l'identità del Grok CLI, e xAI può revocarlo per account. È una decisione
dell'owner, non presa qui.

## La strada documentata: chiave API

`https://api.x.ai/v1` è OpenAI-compatibile, con chiave da console.x.ai e prezzi
a token. Al 2026-11-25: grok-4.7 e grok-4.6 $2,00 in ingresso / $6,00 in uscita
per milione di token (cache $0,50), grok-4.3 $1,25 / $2,50. [V]
https://docs.x.ai/docs/models

## Come fanno i peer con più provider

Hermes tiene un pool di credenziali per provider e `hermes auth list|remove`
per ciascuna; OpenCode e Warp collegano l'abbonamento come un provider tra gli
altri; Warp non ripiega da sé su crediti propri senza un'opzione esplicita.
[S] pagine sopra. Nessuno dei tre ripiega senza che l'owner abbia nominato il
ripiego: è la stessa linea di ADR-0110.
