import type Database from 'better-sqlite3';

export const MEMORY_VALUE = 'cedar-lantern-5842';
export const MEMORY_PREDICATE = 'e2e_verification_code';
export const MEMORY_REQUEST = `Per questo test isolato ricorda come dato owner-stated: subject owner, predicate ${MEMORY_PREDICATE}, object ${MEMORY_VALUE}. È un valore sintetico: usa la memoria, non un file. Conferma solo se è diventato un ricordo.`;
export const MEMORY_QUERY =
  'Cerca nella memoria persistente il dato e2e_verification_code della entità owner e riporta il valore memorizzato e la provenienza.';

export type MemoryWitness = { ok: boolean; links: number; activeFacts: number };

/** Read-only independent SQL oracle for the persisted write-side witness. */
export function memoryWitness(db: Database.Database): MemoryWitness {
  const linked = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM memory_proposals p
       JOIN json_each(p.source_episodes) source
       JOIN episodes e
         ON e.id = CAST(source.value AS INTEGER)
        AND e.tenant_id = p.tenant_id
       JOIN json_each(p.resulting_fact_ids) result
       JOIN facts f
         ON f.id = CAST(result.value AS INTEGER)
        AND f.tenant_id = p.tenant_id
        AND f.episode_id = e.id
       JOIN entities subject
         ON subject.id = f.subject_id
        AND subject.tenant_id = f.tenant_id
       WHERE p.tenant_id = 'host'
         AND p.subject = 'owner'
         AND p.predicate = ?
         AND p.object_value = ?
         AND p.producer = 'owner-stated'
         AND p.status = 'accepted'
         AND e.tenant_id = 'host'
         AND e.connector = 'telegram'
         AND e.role = 'user'
         AND e.kind = 'message'
         AND e.turn_id IS NOT NULL
         AND e.content = ?
         AND subject.name = 'owner'
         AND f.predicate = p.predicate
         AND f.object_value = p.object_value
         AND f.expired_at IS NULL
         AND f.superseded_by IS NULL
         AND f.origin = 'said'`,
    )
    .get(MEMORY_PREDICATE, MEMORY_VALUE, MEMORY_REQUEST) as { n: number };

  const active = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM facts f
       JOIN entities subject
         ON subject.id = f.subject_id
        AND subject.tenant_id = f.tenant_id
       WHERE f.tenant_id = 'host'
         AND subject.name = 'owner'
         AND f.predicate = ?
         AND f.object_value = ?
         AND f.expired_at IS NULL
         AND f.superseded_by IS NULL
         AND f.origin = 'said'`,
    )
    .get(MEMORY_PREDICATE, MEMORY_VALUE) as { n: number };

  const links = Number(linked.n);
  const activeFacts = Number(active.n);
  return { ok: links === 1 && activeFacts === 1, links, activeFacts };
}
