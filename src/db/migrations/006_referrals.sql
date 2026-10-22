-- 006: referral system (Part 6) and fee preview/history support.
-- Referral columns on users: a code per user (unique, nullable so the
-- migration can run on an existing database — codes are backfilled by
-- the seed step on the next boot, and created for new users at signup),
-- plus an immutable referrer link (referrer_id + attached_at). No
-- endpoint may change referrer_id once set; see src/services/referrals.js.
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referrer_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN referral_attached_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL;

-- Referral rate snapshot at room start, mirroring the Part 5 fee snapshot.
-- Rooms started before Part 6 have NULL here and fall back to the
-- current referral.commission_percent at commission time (documented).
ALTER TABLE match_rooms ADD COLUMN referral_rate_snapshot REAL;

-- wallet_ledger: add the 'referral_commission' payout type. Widening a
-- CHECK in SQLite requires a table rebuild, as in migration 005.
CREATE TABLE wallet_ledger_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'purchase_credit', 'admin_adjustment', 'lock', 'unlock', 'consume', 'refund', 'match_win', 'referral_commission'
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

-- Referral commissions: one per referrer per room (UNIQUE room_id,
-- referrer_id), so a result correction or re-confirm can never pay
-- twice. A pending placeholder is created when a dispute opens; it
-- becomes completed (with a wallet credit) or cancelled on decision.
-- invitee_id is the first referred participant of that referrer in
-- the room (used for the dashboard breakdown); the commission itself
-- is per referrer per match, not per invitee.
CREATE TABLE IF NOT EXISTS referral_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES match_rooms(id),
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  invitee_id INTEGER NOT NULL REFERENCES users(id),
  rate_percent REAL NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  fee_amount INTEGER,
  amount INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (room_id, referrer_id)
);
CREATE INDEX IF NOT EXISTS idx_commissions_room ON referral_commissions(room_id, id);
CREATE INDEX IF NOT EXISTS idx_commissions_referrer ON referral_commissions(referrer_id, id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON referral_commissions(referrer_id, status, id);
