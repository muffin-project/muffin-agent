/** Canonical table shape shared by fresh installs and versioned migrations. */
export const TURN_TABLE_SCHEMA = `CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  tenant        TEXT NOT NULL,
  surface       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  -- Canonical semantic text of the ingress; independent of provider checkpoint JSON.
  input_text    TEXT,
  model         TEXT NOT NULL,
  messages      TEXT NOT NULL,
  taint         INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3),
  counters      TEXT NOT NULL,
  reply_to      TEXT,
  job_id        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done','continuable')),
  wake_at       TEXT,
  wait_for      TEXT,
  claimed_by    INTEGER,
  claimed_at    TEXT,
  claim_token   TEXT,
  turn_outcome  TEXT,
  delivery      TEXT,
  lease_index   INTEGER NOT NULL DEFAULT 0,
  continuable_reason TEXT,
  lifetime      TEXT,
  -- The ordered candidate ids an ambiguity question offered, written on the
  -- question turn by askWhichContinuation. Additive and nullable; a
  -- continuation needs it only while it is still the newest question in the
  -- session (PR #707). Durable on purpose: the in-RAM map it replaced lost the
  -- mapping on every gateway restart.
  continuation_candidates TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)`;

/** Fresh-install DDL for the complete durable turn store. */
export const TURN_STORE_SCHEMA = `
${TURN_TABLE_SCHEMA};
CREATE INDEX IF NOT EXISTS idx_turns_status ON turns(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(status, wake_at);
-- One audit row per finished execution lease. The turns row carries the live
-- lease; this table carries what ended leases spent and how they ended.
CREATE TABLE IF NOT EXISTS turn_leases (
  turn_id     TEXT NOT NULL,
  lease_index INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,
  -- Opaque harness-control projection, kept out of the next provider lease.
  harness_messages TEXT,
  counters    TEXT,
  transport_used INTEGER,
  transport_allowance INTEGER,
  delivery    TEXT,
  PRIMARY KEY (turn_id, lease_index)
);
CREATE INDEX IF NOT EXISTS idx_turn_leases_turn ON turn_leases(turn_id, lease_index);
CREATE TABLE IF NOT EXISTS turn_tool_calls (
  turn_id     TEXT NOT NULL,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  capability  TEXT NOT NULL,
  rerunnable  INTEGER NOT NULL,
  args_digest TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  content     TEXT,
  is_error    INTEGER,
  tier        INTEGER,
  undone_at   TEXT,
  effect_row  TEXT,
  reversible  TEXT,
  resource    TEXT,
  decision    TEXT,
  PRIMARY KEY (turn_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_open ON turn_tool_calls(turn_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_turn_tool_calls_started ON turn_tool_calls(started_at);
`;
