'use strict';
// Data-access layer. Routes never touch SQL directly: they call repositories
// in src/db/repos/*.js, which use only the small adapter surface below
// (get/all/run/transaction). Pointing Part 1 at PostgreSQL later means
// replacing this adapter (and its ? -> $n translation) — not the routes.
//
// SQLite is the local store for Part 1. Timestamps are ISO-8601 UTC strings.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

function initDb(dbPath) {
  if (db) return db;
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seed(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

function runMigrations(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.replace('.sql', '');
    const already = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
    if (already) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    });
    apply();
  }
}

// Permission matrix (data, not code): a route checks a named permission and
// this table decides which roles hold it. Changing a role's power is a
// data change here, audited through the settings/role-change flows.
const ROLE_PERMISSIONS = {
  owner: [
    'settings.view', 'settings.update_general', 'settings.update_fee_wallet',
    'settings.update_legal', 'users.view', 'users.change_role',
    'users.ban', 'audit.view', 'two_factor.manage_self',
    // Part 2 wallet powers. Owner is the only role that adjusts balances
    // directly or changes wallet settings; purchase decisions are shared
    // with admin below.
    'wallet.view_all', 'wallet.adjust', 'wallet.packages_manage',
    'purchases.view_all', 'purchases.decide',
    // Part 3: admin hero restrictions are owner/admin only.
    'hero_restrictions.manage',
    // Part 5: dispute/report/reputation powers.
    'disputes.view', 'disputes.investigate', 'disputes.decide',
    'reports.view', 'reports.investigate', 'reports.resolve',
    'reputation.penalty',
    // Part 6: staff referral aggregate (counts only, no private fields).
    'referrals.view_aggregate',
    // Part 7: tournaments and bracket winner recording.
    'tournaments.manage', 'tournaments.bracket',
    // Part 8: site control, statistics, health, suspicious review,
    // backups, sweeper, help articles, Telegram.
    'site.manage', 'stats.view', 'health.view', 'suspicious.view',
    'backups.manage', 'sweep.run', 'help.manage', 'telegram.manage',
  ],
  admin: [
    'settings.view', 'settings.update_general',
    'users.view', 'users.ban', 'audit.view', 'two_factor.manage_self',
    // Admin may look up any wallet/history and decide purchases, but
    // may NOT adjust a balance directly (owner-only) or change wallet
    // settings (owner-only via settings.update_fee_wallet).
    'wallet.view_all', 'wallet.packages_manage',
    'purchases.view_all', 'purchases.decide',
    'hero_restrictions.manage',
    'disputes.view', 'disputes.investigate',
    'reports.view', 'reports.investigate',
    'referrals.view_aggregate',
    'tournaments.manage', 'tournaments.bracket',
    'site.manage', 'stats.view', 'health.view', 'suspicious.view', 'help.manage', 'telegram.manage',
  ],
  moderator: ['users.view', 'users.ban', 'two_factor.manage_self',
    'disputes.view', 'disputes.investigate', 'reports.view', 'reports.investigate',
    'tournaments.bracket'],
  support: ['users.view', 'two_factor.manage_self'],
  player: ['wallet.view_own', 'purchases.view_own'],
};

const ROLE_DESCRIPTIONS = {
  owner: 'Full control, including fee/wallet and legal settings.',
  admin: 'General settings, user management and audit viewing. No fee/wallet or legal settings, no role changes.',
  moderator: 'User viewing and bans, plus dispute work in later parts. No settings or role changes.',
  support: 'Read-only user viewing and support work. No settings, bans or role changes.',
  player: 'Ordinary platform user. No admin access.',
};

// Legal-approval record: exactly what the user stated, and nothing more.
// No lawyer name, contract name, contract date or other detail was provided,
// so none is recorded. Money movement stays disabled in Part 1 regardless.
const LEGAL_APPROVAL_VALUE = {
  status: 'lawyer_consulted',
  contract: 'in_progress',
  permission_given_by_user: true,
  recorded_from: 'user statement',
  note: 'No lawyer name, contract name, or date was provided, and none is recorded here.',
};

const DEFAULT_SETTINGS = [
  ['platform_name', 'Match Arena'],
  ['platform_tagline', 'A standalone match-challenge platform.'],
  ['maintenance_mode', false],
  ['money_movement_enabled', false],
  ['paid_entry_enabled', false],
  ['withdrawals_enabled', false],
  ['fee_policy_note', 'Fee and wallet policy is owner-only and not yet active.'],
  // Part 2 wallet settings (owner-only via settings.update_fee_wallet).
  // Custom purchase amounts are bounded by these; the per-coin price is
  // 0 by default, meaning "not set" — a custom purchase then records no
  // price and its coins are still credited exactly on approval.
  ['wallet.custom_min_coins', 100],
  ['wallet.custom_max_coins', 100000],
  ['wallet.custom_price_per_coin', 0],
  // Part 4 match settings (general keys, so owner/admin may change them).
  ['match.countdown_seconds', 10],
  ['match.ready_timeout_seconds', 300],
  // Part 5: result window (default 5 minutes) and per-arena fees
  // (default percent 0 = no fee; never invent a fee rate).
  ['match.result_window_seconds', 300],
  ['fee.1v1', { type: 'percent', value: 0 }],
  ['fee.Classic', { type: 'percent', value: 0 }],
  ['fee.Brawl', { type: 'percent', value: 0 }],
  // Part 6: referral commission rate, percent of the platform fee.
  // Default 1; owner-only; snapshotted at room start (see referrals).
  ['referral.commission_percent', 1],
  // Part 8: agreement gate, off by default. When an owner turns it on,
  // challenge accept requires acceptance of the current match_rules
  // version (see Part 8). Off by default so Parts 1-7 tests keep passing.
  ['agreement_required', false],
  ['legal_approval', LEGAL_APPROVAL_VALUE],
];

function seed(database) {
  const now = new Date().toISOString();
  const seedTx = database.transaction(() => {
    for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
      database.prepare('INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)')
        .run(name, description);
    }
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        database.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)')
          .run(role, permission);
      }
    }
    for (const [key, value] of DEFAULT_SETTINGS) {
      database.prepare('INSERT OR IGNORE INTO admin_settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?)')
        .run(key, JSON.stringify(value), now);
    }
    // Part 6 backfill: users created before referral codes existed
    // get a unique code on the next boot. New users get one at signup
    // (usersRepo.createUser), and the referrals service lazily fills
    // any row that still has NULL on first dashboard use.
    try {
      const { generateReferralCode } = require('../utils/referralCode');
      const rows = database.prepare('SELECT id FROM users WHERE referral_code IS NULL').all();
      for (const row of rows) {
        for (let i = 0; i < 20; i++) {
          try {
            database.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL')
              .run(generateReferralCode(), row.id);
            break;
          } catch (err) {
            if (!String(err.message || '').includes('UNIQUE')) throw err;
          }
        }
      }
    } catch (err) {
      // If the users table predates the Part 6 migration (a database
      // created by an older build and not yet migrated — not possible
      // in practice, since runMigrations runs before seed), ignore:
      // the lazy backfill in the referrals service covers it.
      if (!String(err.message || '').includes('no such column')) throw err;
    }
  });
  seedTx();
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { initDb, getDb, closeDb, ROLE_PERMISSIONS, DEFAULT_SETTINGS, LEGAL_APPROVAL_VALUE };
