/**
 * Gli endpoint vivi di un modello su uno smistatore (OpenRouter).
 *
 * Due trasporti, un solo formato: `cli/model.ts` legge via `fetch` asincrono,
 * `cli/update.ts` via figlio `node` sincrono (tutto quel file è spawnSync).
 * Entrambi passano da qui per costruire l'URL e leggere la risposta, così una
 * forma che cambia si rompe in un posto solo — e si rompe verso `null`
 * (sconosciuto), mai verso un insieme vuoto che fabbricherebbe la prova che
 * nessun pin serve il modello.
 *
 * Forma verificata il 2026-09-18 (docs OpenRouter + SDK Rust/TS):
 * `GET {baseUrl}/models/:author/:slug/endpoints` (autenticato) →
 * `{ data: { endpoints: [{ tag, provider_name, ... }] } }`.
 * `tag` è lo slug usato in `provider.routing` (`alibaba`);
 * `provider_name` è il display (`Alibaba`). Si raccolgono entrambi, minuscoli.
 */

export function buildEndpointsUrl(baseUrl: string, model: string): string | null {
  const parts = model.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null;
  return `${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}/endpoints`;
}

/** Dalla risposta al set di slug, o `null` quando non lo si sa. Mai un insieme vuoto. */
export function parseEndpointTags(body: unknown): string[] | null {
  if (body === null || typeof body !== 'object') return null;
  const rows = (body as { data?: { endpoints?: unknown } }).data?.endpoints;
  if (!Array.isArray(rows)) return null;
  const tags = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const { tag, provider_name } = row as { tag?: unknown; provider_name?: unknown };
    if (typeof tag === 'string' && tag.length > 0) tags.add(tag.toLowerCase());
    if (typeof provider_name === 'string' && provider_name.length > 0) {
      tags.add(provider_name.toLowerCase());
    }
  }
  return tags.size > 0 ? [...tags] : null;
}
