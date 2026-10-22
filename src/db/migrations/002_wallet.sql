-- 002: coin wallet (Part 2). Balances are materialised in wallet_balances
-- and every change is also recorded, append-only, in wallet_ledger.
-- Both rows are written inside one better-sqlite3 transaction, so a
-- server error can never leave a half-applied transaction. CHECKs stop
-- any balance going negative even if a caller forgets to check first.
CREATE TABLE IF NOT EXISTS wallet_balances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN (
    'purchase_credit', 'admin_adjustment', 'lock', 'unlock', 'consume', 'refund'
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
CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON wallet_ledger(user_id, type, id);
CREATE INDEX IF NOT EXISTS idx_ledger_idempotency ON wallet_ledger(idempotency_key);

CREATE TABLE IF NOT EXISTS coin_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  coins INTEGER NOT NULL CHECK (coins > 0),
  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  price_currency TEXT NOT NULL DEFAULT 'MMK',
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A purchase stores a snapshot of what was bought and at what price at
-- request time. Editing a package later never rewrites this snapshot,
-- so a completed purchase is never repriced.
CREATE TABLE IF NOT EXISTS coin_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  package_id INTEGER REFERENCES coin_packages(id),
  source TEXT NOT NULL CHECK (source IN ('package', 'custom')),
  package_name TEXT,
  coins INTEGER NOT NULL CHECK (coins > 0),
  price_amount INTEGER CHECK (price_amount >= 0),
  price_currency TEXT NOT NULL DEFAULT 'MMK',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
  decision_reason TEXT,
  decided_by INTEGER REFERENCES users(id),
  ledger_transaction_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON coin_purchases(user_id, id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON coin_purchases(status, id);
