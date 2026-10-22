-- 003: challenge board (Part 3). Challenges, their participants, a minimal
-- match-room record created on accept (Part 4 expands it — no chat, voice,
-- ready timers or result submission here), player favorite rule sets, and
-- admin global hero restrictions. Rank tiers are stored as names; range
-- bounds also store their tier index so range filtering is exact SQL.
ALTER TABLE users ADD COLUMN rank_tier TEXT;

CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  accepter_id INTEGER REFERENCES users(id),
  arena TEXT NOT NULL CHECK (arena IN ('1v1', 'Classic', 'Brawl')),
  team_size TEXT NOT NULL CHECK (team_size IN ('1v1', '2v2', '3v3', '4v4', '5v5')),
  stake INTEGER NOT NULL CHECK (stake > 0),
  hero_rule TEXT NOT NULL CHECK (hero_rule IN (
    'any', 'fighter_only', 'mage_only', 'assassin_only', 'marksman_only',
    'tank_only', 'support_only', 'same_hero_only', 'random_hero_only',
    'no_duplicate_hero'
  )),
  required_hero TEXT,
  hero_bans TEXT NOT NULL DEFAULT '[]',
  custom_rules TEXT NOT NULL DEFAULT '',
  rank_restriction_type TEXT NOT NULL DEFAULT 'none'
    CHECK (rank_restriction_type IN ('none', 'same_rank_only', 'range')),
  rank_min_tier TEXT,
  rank_max_tier TEXT,
  rank_min_index INTEGER,
  rank_max_index INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  matched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status, id);
CREATE INDEX IF NOT EXISTS idx_challenges_arena ON challenges(arena, id);
CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges(created_at, id);
CREATE INDEX IF NOT EXISTS idx_challenges_updated ON challenges(updated_at, id);

CREATE TABLE IF NOT EXISTS challenge_participants (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('creator', 'accepter')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (challenge_id, user_id)
);

-- Minimal match-room record: Part 3 creates it on accept only. Chat,
-- voice, ready state, timers and results are Part 4 and later, and must
-- not be read into this table's 'created' status.
CREATE TABLE IF NOT EXISTS match_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES challenges(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  accepter_id INTEGER NOT NULL REFERENCES users(id),
  stake INTEGER NOT NULL CHECK (stake > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  arena TEXT NOT NULL CHECK (arena IN ('1v1', 'Classic', 'Brawl')),
  team_size TEXT NOT NULL CHECK (team_size IN ('1v1', '2v2', '3v3', '4v4', '5v5')),
  hero_rule TEXT NOT NULL CHECK (hero_rule IN (
    'any', 'fighter_only', 'mage_only', 'assassin_only', 'marksman_only',
    'tank_only', 'support_only', 'same_hero_only', 'random_hero_only',
    'no_duplicate_hero'
  )),
  required_hero TEXT,
  hero_bans TEXT NOT NULL DEFAULT '[]',
  custom_rules TEXT NOT NULL DEFAULT '',
  rank_restriction_type TEXT NOT NULL DEFAULT 'none'
    CHECK (rank_restriction_type IN ('none', 'same_rank_only', 'range')),
  rank_min_tier TEXT,
  rank_max_tier TEXT,
  rank_min_index INTEGER,
  rank_max_index INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorite_rules(user_id, id);

-- One active rule per hero (compared case-insensitively by the service).
-- Deactivate the old rule before creating a replacement, or update it.
CREATE TABLE IF NOT EXISTS global_hero_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hero_name TEXT NOT NULL,
  restriction TEXT NOT NULL CHECK (restriction IN ('allowed', 'banned')),
  reason TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hero_restrictions_active ON global_hero_restrictions(active, id);
