-- 007: Part 7 — full profiles, friends, teams, tournaments, brackets,
-- leaderboards. Image files live on disk under data/avatars/,
-- data/team-logos/ and data/tournament-banners/ (gitignored); this
-- table is the only map from an id to a stored path, and downloads
-- are authenticated and kind-checked, never public static.
CREATE TABLE IF NOT EXISTS profile_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('avatar', 'team_logo', 'tournament_banner')),
  owner_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_images_kind_owner ON profile_images(kind, owner_id, id);

-- Friendships: one row per directed request; friendship is mutual
-- only once accepted. Duplicate pending/accepted pairs in either
-- direction are rejected by the service (a single-writer SQLite
-- transaction makes that check atomic); the UNIQUE below stops the
-- same-direction duplicate at the database level too.
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  addressee_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(requester_id, id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, id);

-- Teams: max 5 members including the leader (Part 7 rule, since
-- teams are for 2v2-5v5). A user belongs to at most one team at a
-- time in Part 7 — enforced by the service, documented in the README.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  leader_id INTEGER NOT NULL REFERENCES users(id),
  logo_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  inviter_id INTEGER NOT NULL REFERENCES users(id),
  invitee_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_invites_invitee ON team_invites(invitee_id, id);

-- Tournaments. Champion fields are filled only on completion.
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  banner_url TEXT,
  prize_description TEXT NOT NULL DEFAULT '',
  prize_coins INTEGER NOT NULL DEFAULT 0 CHECK (prize_coins >= 0),
  rules TEXT NOT NULL DEFAULT '',
  registration_start TEXT NOT NULL,
  registration_end TEXT NOT NULL,
  start_time TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('solo', 'team')),
  team_size TEXT NOT NULL CHECK (team_size IN ('1v1', '2v2', '3v3', '4v4', '5v5')),
  max_registrants INTEGER CHECK (max_registrants IS NULL OR max_registrants > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'registration_open', 'ongoing', 'completed', 'cancelled')),
  champion_type TEXT CHECK (champion_type IN ('player', 'team')),
  champion_id INTEGER,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, id);

CREATE TABLE IF NOT EXISTS tournament_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  registrant_type TEXT NOT NULL CHECK (registrant_type IN ('player', 'team')),
  player_id INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'cancelled')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tourney_regs_tournament ON tournament_registrations(tournament_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tourney_regs_player ON tournament_registrations(tournament_id, player_id) WHERE player_id IS NOT NULL AND status = 'registered';
CREATE UNIQUE INDEX IF NOT EXISTS idx_tourney_regs_team ON tournament_registrations(tournament_id, team_id) WHERE team_id IS NOT NULL AND status = 'registered';

-- Bracket matches. feeder_a_match_id / feeder_b_match_id point at the
-- previous-round match whose winner fills that slot (NULL for a
-- directly placed participant, e.g. a bye seed in round 2). A match
-- is 'pending' until both participants are known, 'ongoing' once it
-- can be played, and 'completed' once a winner is recorded.
CREATE TABLE IF NOT EXISTS tournament_bracket_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  round INTEGER NOT NULL CHECK (round >= 1),
  slot INTEGER NOT NULL CHECK (slot >= 1),
  participant_a_type TEXT CHECK (participant_a_type IN ('player', 'team')),
  participant_a_id INTEGER,
  participant_b_type TEXT CHECK (participant_b_type IN ('player', 'team')),
  participant_b_id INTEGER,
  feeder_a_match_id INTEGER REFERENCES tournament_bracket_matches(id),
  feeder_b_match_id INTEGER REFERENCES tournament_bracket_matches(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ongoing', 'completed')),
  winner_type TEXT CHECK (winner_type IN ('player', 'team')),
  winner_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tournament_id, round, slot)
);
CREATE INDEX IF NOT EXISTS idx_bracket_tournament ON tournament_bracket_matches(tournament_id, round, slot);

-- Champion members snapshot: every member of a champion team (or the
-- solo champion) gets one row at completion, so profile tournament
-- wins and champion badges survive later team changes.
CREATE TABLE IF NOT EXISTS tournament_champion_members (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (tournament_id, user_id)
);

-- wallet_ledger: add the 'tournament_prize' payout type (table
-- rebuild, as in migrations 005/006).
CREATE TABLE wallet_ledger_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'purchase_credit', 'admin_adjustment', 'lock', 'unlock', 'consume', 'refund', 'match_win', 'referral_commission', 'tournament_prize'
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
