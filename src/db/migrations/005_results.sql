-- 005: result submission, disputes, reputation, reports, match history
-- (Part 5). Widening CHECK constraints in SQLite requires a table
-- rebuild, so wallet_ledger and match_rooms are rebuilt here with
-- their existing rows copied across.
ALTER TABLE users ADD COLUMN banned_until TEXT;

-- wallet_ledger: add the 'match_win' payout type. Existing types and
-- rows are unchanged; only the CHECK list grows.
CREATE TABLE wallet_ledger_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'purchase_credit', 'admin_adjustment', 'lock', 'unlock', 'consume', 'refund', 'match_win'
  )),
  amount INTEGER NOT NULL,
  delta_available INTEGER NOT NULL,
  delta_locked INTEGER NOT NULL,
  balance_available_after INTEGER NOT NULL,
  balance_locked_after INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  reference TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO wallet_ledger_new
  (id, transaction_id, user_id, type, amount, delta_available, delta_locked,
   balance_available_after, balance_locked_after, actor_id, reference, reason,
   idempotency_key, created_at)
SELECT id, transaction_id, user_id, type, amount, delta_available, delta_locked,
  balance_available_after, balance_locked_after, actor_id, reference, reason,
  idempotency_key, created_at FROM wallet_ledger;
DROP TABLE wallet_ledger;
ALTER TABLE wallet_ledger_new RENAME TO wallet_ledger;
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON wallet_ledger(user_id, type, id);
CREATE INDEX IF NOT EXISTS idx_ledger_idempotency ON wallet_ledger(idempotency_key);

-- match_rooms: add result lifecycle statuses and a fee snapshot taken
-- at room start (Part 5). Rows started before Part 5 have no snapshot;
-- settlement for those rooms falls back to the current fee setting
-- and the README documents that fallback.
CREATE TABLE match_rooms_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES challenges(id),
  arena TEXT NOT NULL,
  team_size TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  accepter_id INTEGER NOT NULL REFERENCES users(id),
  stake INTEGER NOT NULL CHECK (stake > 0),
  status TEXT NOT NULL DEFAULT 'waiting_ready'
    CHECK (status IN ('created', 'waiting_ready', 'countdown', 'started', 'result_pending', 'disputed', 'finished', 'cancelled', 'finished_placeholder')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_deadline TEXT,
  countdown_started_at TEXT,
  started_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  result_window_opens_at TEXT,
  fee_snapshot_type TEXT,
  fee_snapshot_value INTEGER
);
INSERT INTO match_rooms_new
  (id, challenge_id, arena, team_size, creator_id, accepter_id, stake,
   status, created_at, updated_at, ready_deadline, countdown_started_at,
   started_at, cancelled_at, cancel_reason, result_window_opens_at,
   fee_snapshot_type, fee_snapshot_value)
SELECT id, challenge_id, arena, team_size, creator_id, accepter_id, stake,
  status, created_at, updated_at, ready_deadline, countdown_started_at,
  started_at, cancelled_at, cancel_reason, result_window_opens_at, NULL, NULL
FROM match_rooms;
DROP TABLE match_rooms;
ALTER TABLE match_rooms_new RENAME TO match_rooms;
CREATE INDEX IF NOT EXISTS idx_match_rooms_challenge ON match_rooms(challenge_id);
CREATE INDEX IF NOT EXISTS idx_match_rooms_status ON match_rooms(status, id);

-- Side-level result submissions. One per side per room (UNIQUE).
CREATE TABLE IF NOT EXISTS result_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  leader_user_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'lose')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (room_id, side)
);
CREATE INDEX IF NOT EXISTS idx_submissions_room ON result_submissions(room_id, side);

-- Evidence files for submissions, disputes and reports. Files live on
-- disk under data/evidence/ (gitignored); this table is the only map
-- from an id to a stored path, and the download endpoint enforces
-- participant/staff or reporter/staff access. Never served publicly.
CREATE TABLE IF NOT EXISTS evidence_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('submission', 'dispute', 'report')),
  owner_id INTEGER NOT NULL,
  room_id INTEGER REFERENCES match_rooms(id),
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON evidence_files(owner_type, owner_id);

-- Disputes: at most one open/decided dispute per room (UNIQUE room_id).
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL UNIQUE REFERENCES match_rooms(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
  winner_side TEXT CHECK (winner_side IN ('A', 'B')),
  decision TEXT CHECK (decision IN ('winner', 'cancel')),
  decision_reason TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_room ON disputes(room_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, id);

CREATE TABLE IF NOT EXISTS dispute_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Settlements: one per room (UNIQUE room_id) — the idempotency guard
-- that makes a second confirm a 409 instead of a second payout.
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL UNIQUE REFERENCES match_rooms(id),
  winner_side TEXT CHECK (winner_side IN ('A', 'B')),
  pot INTEGER NOT NULL CHECK (pot >= 0),
  fee INTEGER NOT NULL CHECK (fee >= 0),
  fee_type TEXT NOT NULL,
  fee_value INTEGER NOT NULL,
  payouts TEXT NOT NULL DEFAULT '[]',
  settled_by INTEGER REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Platform fee ledger: a fee is a ledger entry with a room reference,
-- never a player balance. No player row is credited with the fee.
CREATE TABLE IF NOT EXISTS platform_fee_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  arena TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  fee_type TEXT NOT NULL,
  fee_value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_room ON platform_fee_ledger(room_id);

-- Reputation: one score row per user, starting at 100, floored at 0.
CREATE TABLE IF NOT EXISTS reputation (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 100 CHECK (score >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  points_change INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  room_id INTEGER REFERENCES match_rooms(id),
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reputation_events_user ON reputation_events(user_id, id);

-- Reports: case_id is human-readable (REP-YYYYMMDD-NNNN) and unique.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL UNIQUE,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reported_user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('cheating', 'toxic_behaviour', 'fake_screenshot', 'intentional_disconnect', 'fake_account', 'other')),
  reason TEXT NOT NULL,
  room_id INTEGER REFERENCES match_rooms(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  resolution TEXT,
  action_taken TEXT CHECK (action_taken IN ('none', 'warning', 'temp_ban', 'permanent_ban')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, id);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_user_id, id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id);

CREATE TABLE IF NOT EXISTS report_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Match history: immutable, one row per participant per room outcome.
CREATE TABLE IF NOT EXISTS match_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  arena TEXT NOT NULL,
  team_size TEXT NOT NULL,
  opponent_user_ids TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL CHECK (result IN ('win', 'lose', 'cancelled')),
  status TEXT NOT NULL,
  stake INTEGER NOT NULL,
  payout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_history_user ON match_history(user_id, id);
CREATE INDEX IF NOT EXISTS idx_history_room ON match_history(room_id, id);
