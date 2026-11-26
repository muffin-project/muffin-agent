# ADR-0113 — Login xAI/Grok con OAuth, accanto alla chiave API

**Stato: deciso dall'owner il 2026-11-26 (Europe/Rome)** («costruisci prima
`muffin auth login xai` con OAuth su dev»). Prende la decisione che
[ADR-0110](0110-catena-di-provider-in-ordine.md) lasciava esplicitamente
all'owner («Login con l'abbonamento SuperGrok/X Premium … questa ADR non la
prende») e amenda [ADR-0105](0105-account-sono-profili.md) per la voce xAI:
l'account xAI si collega anche con un login, non solo con una chiave.

Numero: **0113** era il prossimo libero su `dev` al momento della stesura
(`node docs/decisions/prossimo-numero.mjs`).

## Problema

Collegare Grok chiedeva di aprire console.x.ai, creare una chiave, copiarla e
incollarla in `muffin secret set xai_api_key`. L'owner vuole togliere attrito:
OpenRouter e ChatGPT si collegano già con un consenso nel browser.

## Protocollo verificato (2026-11-26)

Fonti: [V] verificato direttamente da noi; [S] sorgente di terzi.

- Discovery [V] `https://auth.x.ai/.well-known/openid-configuration`:
  `authorization_endpoint` `https://auth.x.ai/oauth2/authorize`,
  `token_endpoint` `https://auth.x.ai/oauth2/token`,
  `device_authorization_endpoint` `https://auth.x.ai/oauth2/device/code`,
  `revocation_endpoint` `https://auth.x.ai/oauth2/revoke`; grant
  `authorization_code`, `refresh_token`,
  `urn:ietf:params:oauth:grant-type:device_code`; PKCE solo `S256`; client
  pubblici (`token_endpoint_auth_methods_supported` contiene `none`).
- Client [V] nel sorgente aperto di xAI (`xai-org/grok-build`,
  `crates/codegen/xai-grok-login`): `client_id`
  `b1a00492-073a-47ea-816f-4c329264a828`; redirect
  `http://127.0.0.1:<porta scelta dal sistema>/callback` in produzione, con
  incolla dell'URL di ritorno o del solo codice quando il browser non
  raggiunge il loopback; parametri `response_type=code`, `client_id`,
  `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`,
  `state`, `nonce`, `referrer`; scambio e refresh in
  `application/x-www-form-urlencoded` (`grant_type`, `code`, `redirect_uri`,
  `client_id`, `code_verifier` / `refresh_token`, `client_id`); device code
  con `client_id`, `scope`, `referrer`, attesa prima del primo poll, +5 s su
  `slow_down`. I refresh token **ruotano** e xAI rileva il riuso.
- Lo stesso sorgente dichiara che un host xAI accetta due credenziali: una
  chiave API o un access token OAuth di `auth.x.ai`. Grok Build lo usa su
  `api.x.ai` per le chiamate fuori dal turno; per i turni usa un proxy
  (`cli-chat-proxy.grok.com`) che richiede intestazioni d'identità del Grok
  CLI. [S] OpenCode (`plugin/xai.ts`), Hermes (guida «xAI Grok OAuth») e
  pullfrog usano lo stesso client, scope
  `openid profile email offline_access grok-cli:access api:access`, e il
  token come `Authorization: Bearer` su `https://api.x.ai/v1`.
- [S] Hermes documenta `HTTP 403` dopo un login riuscito su alcuni piani
  SuperGrok: xAI decide lato server quali account ricevono accesso API.

## Decisione

- `muffin auth login xai` (alias `grok`): sul terminale locale apre il browser
  sul loopback `127.0.0.1:<porta>/callback` con PKCE S256, `state` e `nonce`
  casuali, e nello stesso momento accetta l'URL di ritorno incollato;
  `--code` è solo l'incolla; su SSH il default è il **device code** (RFC 8628),
  `--device` lo forza. Senza TTY rifiuta e indica la chiave.
- Client: quello pubblico del Grok CLI, **preso in prestito** come per gli
  altri agenti open source; `referrer=muffin` per onestà d'attribuzione. Non
  mandiamo `plan=generic` (lo aggiunge OpenCode, Grok Build no) né le
  intestazioni d'identità del Grok CLI: Muffin non si spaccia per il Grok CLI e
  non usa il proxy dei turni di Grok Build.
- Scope minimi: `openid profile email offline_access grok-cli:access
  api:access`. Senza refresh token il login è rifiutato subito (morirebbe in
  un'ora, di notte).
- Inferenza: lo stesso provider di catalogo `xai`
  (`openai-compat`, `https://api.x.ai/v1`); cambia solo la credenziale. Il
  riferimento `secret://xai_oauth` su una corsia o un anello vuol dire «login
  xAI»; `secret://xai_api_key[_<id>]` resta la chiave.
- Il login vive in `<home>/secrets/xai_oauth` (0600, scrittura atomica), con
  un lock SQLite accanto: CLI e gateway rinnovano l'access token due minuti
  prima della scadenza (da `expires_in`, poi `exp` del JWT, poi un'ora), uno
  alla volta, e il refresh token ruotato è scritto prima di usare il nuovo
  access token. `invalid_grant` (o 401) chiude il login: niente nuovi tentativi
  con un token morto, solo `muffin auth login xai`.
- `readSecret('secret://xai_oauth')` lancia e `muffin secret set xai_oauth` è
  rifiutato: il login non diventa mai il valore di un'intestazione fuori
  dall'adapter, né si sovrascrive a mano.
- Un rinnovo rifiutato diventa `ProviderError` con
  `details.reauthentication: 'xai'`, un login introvabile
  `details.credentials: 'unavailable'`: per la catena (ADR-0110) è un problema
  d'account, si passa all'anello dopo.
- `muffin fallback add xai <modello>` sceglie il login se c'è ed è valido,
  altrimenti la chiave di default; `--account default` (o un altro id) nomina
  la chiave esplicitamente. Il login, dopo il consenso, ripunta solo gli
  anelli xAI che nominano la chiave di default **mancante**: un anello con una
  chiave salvata è una scelta dell'owner e resta com'è. Non cambia mai la
  corsia `main`.
- Dopo il login una sonda `GET https://api.x.ai/v1/models` con il token dice
  subito se xAI accetta il login per l'API; un 401/403 è detto come limite del
  piano, con la chiave come via d'uscita.
- `muffin auth status`, `muffin auth logout xai` (revoca del refresh token),
  `muffin doctor` e `muffin fallback` leggono il login senza mai mostrare un
  token.

## Alternative rifiutate

- **Solo chiave API.** È la strada documentata e resta, ma è l'attrito che
  l'owner ha chiesto di togliere.
- **Il proxy dei turni di Grok Build** (`cli-chat-proxy.grok.com`). Vuole
  intestazioni che identificano il Grok CLI e una versione minima del client:
  sarebbe impersonarlo, non solo riusarne il client OAuth.
- **Un provider di catalogo separato `xai-oauth`.** Duplicherebbe endpoint,
  prezzi e modelli che sono gli stessi; la differenza è solo la credenziale.

## Limiti

- Il client è di xAI, non nostro: xAI può restringerlo o revocarlo, e decide
  per account chi riceve accesso API (403). La chiave resta indipendente.
- Non sappiamo da fonte primaria se l'uso via OAuth su `api.x.ai` consumi il
  pool dell'abbonamento o crediti a consumo. La spesa si conta comunque ai
  prezzi di listino xAI (`core/budget/pricing.ts`): sovrastimare è il verso
  sicuro per i tetti.
- Un 403 nudo resta un rifiuto senza pausa (ADR-0110): se xAI nega l'API al
  piano, il turno si ferma con quell'errore invece di passare all'anello dopo.
- `muffin model --provider xai --list` usa l'access token salvato solo se è
  ancora valido; non lo rinnova.
- La prova dal vivo (login reale e un turno su Telegram) è dell'owner sul suo
  Mac; questa ADR è verificata su fixture e CI.

## Falsificatore

Va rifatta se un token (access o refresh) compare in un log, in un errore o in
`provider-chain.json`; se due processi spendono lo stesso refresh token; se un
anello xAI con una chiave salvata viene ripuntato al login senza che l'owner lo
chieda; o se `api.x.ai` smette di accettare l'access token OAuth.
