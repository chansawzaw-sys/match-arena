-- 008: Part 8 — no-code site control, versioned terms, help centre,
-- support tickets, backups manifest, Telegram config and pending
-- announcements, plus notification category/target columns.
-- Image files for banners live on disk under data/site-banners/
-- (gitignored); this table is the only map from a banner id to a
-- stored path, and banner downloads are authenticated and checked,
-- never public static and never by a client-supplied path.
CREATE TABLE IF NOT EXISTS site_banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  stored_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_banners_active ON site_banners(active, sort_order, id);

CREATE TABLE IF NOT EXISTS site_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'mm' CHECK (language IN ('mm', 'en')),
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_announcements_active ON site_announcements(active, id);

CREATE TABLE IF NOT EXISTS telegram_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_encrypted TEXT,
  admin_chat_id TEXT,
  webhook_secret_encrypted TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'mm' CHECK (language IN ('mm', 'en')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  confirmation_code TEXT NOT NULL,
  site_announcement_id INTEGER REFERENCES site_announcements(id),
  telegram_status TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

-- Versioned documents: never edit an old version in place; creating a
-- new version is the only update path. UNIQUE (type, version) guards it.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('terms', 'privacy', 'match_rules')),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (type, version)
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type, version);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, document_id)
);

CREATE TABLE IF NOT EXISTS help_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('match_rules', 'account', 'technical', 'dispute_process', 'other')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('match_rules', 'account', 'technical', 'dispute_process', 'other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, id);

-- Backup manifest: the database file copy only. Evidence, avatar,
-- banner and other on-disk image directories are NOT inside the
-- SQLite file and must be backed up as files separately — the
-- manifest records that limit, and the README documents it.
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Notification centre: category and tap-through targets. Existing
-- rows (from Parts 4-6) have NULL here; the Part 8 list function
-- derives a category from the notification type for those rows.
ALTER TABLE notifications ADD COLUMN category TEXT;
ALTER TABLE notifications ADD COLUMN tournament_id INTEGER REFERENCES tournaments(id);
ALTER TABLE notifications ADD COLUMN dispute_id INTEGER REFERENCES disputes(id);
ALTER TABLE notifications ADD COLUMN target_type TEXT;
ALTER TABLE notifications ADD COLUMN target_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(user_id, category, id);
