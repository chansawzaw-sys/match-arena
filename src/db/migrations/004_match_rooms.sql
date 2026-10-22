-- 004: private match rooms (Part 4). Expands the minimal match_rooms
-- record created on accept in Part 3 into a full room: lifecycle
-- statuses, server-recorded timestamps, per-room participants (roster),
-- chat messages, voice-session/signalling state, and notification
-- records. Part 3's 'created' status is superseded by 'waiting_ready'
-- for new rooms; old rows are migrated to 'waiting_ready' so the Part 4
-- lifecycle applies to them too. Result submission is NOT in Part 4:
-- result_window_opens_at is exposed as a hook for Part 5 only.
ALTER TABLE users ADD COLUMN mlbb_id TEXT;
ALTER TABLE users ADD COLUMN server_id TEXT;

-- Expand match_rooms via table rebuild (SQLite cannot widen a CHECK).
CREATE TABLE match_rooms_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES challenges(id),
  arena TEXT NOT NULL,
  team_size TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  accepter_id INTEGER NOT NULL REFERENCES users(id),
  stake INTEGER NOT NULL CHECK (stake > 0),
  status TEXT NOT NULL DEFAULT 'waiting_ready'
    CHECK (status IN ('created', 'waiting_ready', 'countdown', 'started', 'cancelled', 'finished_placeholder')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_deadline TEXT,
  countdown_started_at TEXT,
  started_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  result_window_opens_at TEXT
);
INSERT INTO match_rooms_new
  (id, challenge_id, arena, team_size, creator_id, accepter_id, stake,
   status, created_at, updated_at, ready_deadline)
SELECT mr.id, mr.challenge_id, c.arena, c.team_size, mr.creator_id,
       mr.accepter_id, mr.stake, 'waiting_ready', mr.created_at,
       mr.updated_at, datetime(mr.created_at, '+300 seconds')
FROM match_rooms mr JOIN challenges c ON c.id = mr.challenge_id;
DROP TABLE match_rooms;
ALTER TABLE match_rooms_new RENAME TO match_rooms;
CREATE INDEX IF NOT EXISTS idx_match_rooms_challenge ON match_rooms(challenge_id);
CREATE INDEX IF NOT EXISTS idx_match_rooms_status ON match_rooms(status, id);

-- Per-room roster. side 'A' is the creator's side, side 'B' the
-- accepter's side. role is 'leader' (the two accepters) or 'member'.
-- This roster is per-room only; persistent named teams are Part 7.
CREATE TABLE IF NOT EXISTS match_room_participants (
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  ready INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
INSERT INTO match_room_participants (room_id, user_id, side, role, ready, joined_at)
SELECT id, creator_id, 'A', 'leader', 0, created_at FROM match_rooms;
INSERT INTO match_room_participants (room_id, user_id, side, role, ready, joined_at)
SELECT id, accepter_id, 'B', 'leader', 0, created_at FROM match_rooms;

CREATE TABLE IF NOT EXISTS match_room_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_room_chat ON match_room_chat(room_id, id);

-- Voice signalling only: who is in voice now, and signalling messages
-- (offer/answer/ICE) relayed between participants. No audio is stored
-- or relayed by this backend; real peer-to-peer audio is frontend
-- WebRTC work in Part 9.
CREATE TABLE IF NOT EXISTS match_room_voice (
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS match_room_voice_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice-candidate')),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_signals ON match_room_voice_signals(room_id, id);

-- Minimal notification records (full notification centre is Part 8).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  room_id INTEGER REFERENCES match_rooms(id),
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
