'use strict';
// Part 8 business logic: statistics, health, sweeper, Telegram send
// (real Bot API call, never a fake success), maintenance/emergency
// helpers, suspicious-account review, and the agreement gate.
// Maintenance/emergency blocking itself lives in app.js as a guard
// middleware, because it must run before the player-facing routers;
// the helpers here expose the flags and the counts that guard and
// the enable endpoints need.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const settingsRepo = require('../db/repos/settings');
const matchRoomsRepo = require('../db/repos/matchRooms');
const matchRoomsService = require('./matchRooms');
const repo = require('../db/repos/part8');
const usersRepo = require('../db/repos/users');
const { encryptText, decryptText, sha256 } = require('../utils/crypto');

class Part8Error extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isMaintenanceEnabled() {
  return settingsRepo.getSetting('maintenance_mode') === true;
}
function isEmergencyEnabled() {
  return settingsRepo.getSetting('emergency_mode') === true;
}
function maintenanceInfo() {
  return {
    enabled: isMaintenanceEnabled(),
    message: settingsRepo.getSetting('maintenance.message') || null,
    reason: settingsRepo.getSetting('maintenance.reason') || null,
  };
}
function emergencyInfo() {
  return {
    enabled: isEmergencyEnabled(),
    reason: settingsRepo.getSetting('emergency.reason') || null,
  };
}
function activeMatchCount() {
  return getDb().prepare(
    "SELECT COUNT(*) AS n FROM match_rooms WHERE status IN ('waiting_ready', 'countdown', 'started', 'result_pending', 'disputed')",
  ).get().n;
}
function activeRoomIds() {
  return getDb().prepare(
    "SELECT id FROM match_rooms WHERE status IN ('waiting_ready', 'countdown', 'started', 'result_pending', 'disputed') ORDER BY id ASC",
  ).all().map((r) => r.id);
}

function statistics() {
  const db = getDb();
  const now = new Date();
  const fifteenAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;
  const sum = (sql, ...params) => db.prepare(sql).get(...params).total || 0;
  const roomsByStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM match_rooms GROUP BY status').all()) roomsByStatus[r.status] = r.n;
  const tourneysByStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tournaments GROUP BY status').all()) tourneysByStatus[r.status] = r.n;
  return {
    generatedAt: now.toISOString(),
    totalUsers: count('SELECT COUNT(*) AS n FROM users'),
    // Sessions have no heartbeat: "active in the last 15 minutes" means
    // a distinct user with a non-revoked, unexpired session created
    // in the last 15 minutes (i.e. a recent login), documented here
    // and in the README so it is never read as live presence.
    activeUsersLast15Min: count(
      'SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ? AND created_at >= ?',
      now.toISOString(), fifteenAgo),
    openChallenges: count("SELECT COUNT(*) AS n FROM challenges WHERE status = 'open'"),
    activeMatchRooms: activeMatchCount(),
    matchRoomsByStatus: roomsByStatus,
    pendingDisputes: count("SELECT COUNT(*) AS n FROM disputes WHERE status = 'open'"),
    pendingReports: count("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open', 'investigating')"),
    totalPlatformFee: sum('SELECT COALESCE(SUM(amount), 0) AS total FROM platform_fee_ledger'),
    totalReferralCommissionsCompleted: sum("SELECT COALESCE(SUM(amount), 0) AS total FROM referral_commissions WHERE status = 'completed'"),
    totalTournaments: count('SELECT COUNT(*) AS n FROM tournaments'),
    tournamentsByStatus: tourneysByStatus,
    totalWalletAvailable: sum('SELECT COALESCE(SUM(available), 0) AS total FROM wallet_balances'),
    totalWalletLocked: sum('SELECT COALESCE(SUM(locked), 0) AS total FROM wallet_balances'),
  };
}

function health() {
  const db = getDb();
  let dbOk = true;
  try { db.prepare('SELECT 1 AS one').get(); } catch { dbOk = false; }
  return {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    databaseReachable: dbOk,
    generatedAt: new Date().toISOString(),
    totalUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    activeMatchRooms: activeMatchCount(),
    pendingDisputes: db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status = 'open'").get().n,
    pendingReports: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open', 'investigating')").get().n,
    lastBackupAt: repo.lastBackupAt(),
    maintenance: maintenanceInfo(),
    emergency: emergencyInfo(),
  };
}

// Deterministic sweeper (manual endpoint, not a cron): apply the
// Part 4 read-time lifecycle to every room once, and count what
// changed. Expired result windows are only flagged — they do not
// change state on their own, because a result window expiring is not
// a cancellation; an admin decision is still required for a dispute.
function runSweep() {
  const rooms = getDb().prepare('SELECT id, status, result_window_opens_at FROM match_rooms ORDER BY id ASC').all();
  let roomsChecked = 0;
  let roomsCancelledByTimeout = 0;
  let roomsStartedByCountdown = 0;
  let roomsWithExpiredResultWindow = 0;
  const now = Date.now();
  for (const r of rooms) {
    roomsChecked += 1;
    const before = r.status;
    let after = before;
    try {
      const refreshed = matchRoomsService.refreshRoom(r.id);
      after = refreshed ? refreshed.status : before;
    } catch {
      after = before;
    }
    if (before !== after && after === 'cancelled') roomsCancelledByTimeout += 1;
    if (before !== after && after === 'started') roomsStartedByCountdown += 1;
    if (after === 'started' || after === 'result_pending') {
      const win = getDb().prepare('SELECT result_window_opens_at FROM match_rooms WHERE id = ?').get(r.id);
      if (win && win.result_window_opens_at && new Date(win.result_window_opens_at).getTime() <= now) {
        roomsWithExpiredResultWindow += 1;
      }
    }
  }
  return { roomsChecked, roomsCancelledByTimeout, roomsStartedByCountdown, roomsWithExpiredResultWindow, sweptAt: new Date().toISOString() };
}

// --- Telegram ---
function telegramConfigPublic(config) {
  const row = repo.getTelegramConfig();
  return {
    configured: !!(row && row.token_encrypted),
    adminChatId: row ? row.admin_chat_id : null,
    webhookConfigured: !!(row && row.webhook_secret_encrypted),
  };
}
function telegramToken(config) {
  const row = repo.getTelegramConfig();
  if (!row || !row.token_encrypted) return null;
  try { return decryptText(row.token_encrypted, config.encryptionKey); } catch { return null; }
}
function telegramWebhookSecret(config) {
  const row = repo.getTelegramConfig();
  if (!row || !row.webhook_secret_encrypted) return null;
  try { return decryptText(row.webhook_secret_encrypted, config.encryptionKey); } catch { return null; }
}
async function sendTelegramMessage(config, chatId, text) {
  const token = telegramToken(config);
  if (!token) return { ok: false, error: 'Telegram bot token is not configured' };
  if (!chatId) return { ok: false, error: 'Telegram admin chat id is not configured' };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.ok !== true) {
    return { ok: false, error: (body && body.description) || `Telegram API returned ${res.status}` };
  }
  return { ok: true, messageId: body.result ? body.result.message_id : null };
}
function formatStatsMessage(stats) {
  return [
    'Match Arena stats',
    `Users: ${stats.totalUsers} (active last 15 min: ${stats.activeUsersLast15Min})`,
    `Open challenges: ${stats.openChallenges}`,
    `Active match rooms: ${stats.activeMatchRooms}`,
    `Pending disputes: ${stats.pendingDisputes}, pending reports: ${stats.pendingReports}`,
    `Platform fee collected: ${stats.totalPlatformFee} coins`,
    `Referral commissions completed: ${stats.totalReferralCommissionsCompleted} coins`,
    `Tournaments: ${stats.totalTournaments}`,
  ].join('\n');
}

// --- Suspicious-account review (no auto-ban) ---
function suspiciousGroups() {
  const db = getDb();
  const groups = [];
  // Same MLBB ID shared by more than one user (only where both are set).
  const sameId = db.prepare(
    "SELECT mlbb_id, GROUP_CONCAT(id) AS ids FROM users WHERE mlbb_id IS NOT NULL AND mlbb_id != '' GROUP BY mlbb_id HAVING COUNT(*) > 1",
  ).all();
  for (const row of sameId) {
    const ids = String(row.ids).split(',').map(Number);
    groups.push({
      reason: 'shared_mlbb_id',
      detail: `MLBB ID ${row.mlbb_id} is shared by ${ids.length} users`,
      users: ids.map((id) => repo.publicUserDisplay(usersRepo.findById(id))).filter(Boolean),
    });
  }
  // Defensive: a user whose referral code equals their own (should be
  // impossible — attach rejects self-referral). Listed, never acted on.
  const selfRef = db.prepare('SELECT id FROM users WHERE referrer_id = id').all();
  for (const row of selfRef) {
    groups.push({ reason: 'self_referral', detail: 'User is their own referrer', users: [repo.publicUserDisplay(usersRepo.findById(row.id))].filter(Boolean) });
  }
  // 3+ disputes lost (as the losing side in a decided dispute) or
  // reports resolved against the user in the last 30 days. Dispute
  // losses are approximated from reputation events of type
  // dispute_false_submission, which Part 5 records exactly for that
  // case; report actions are counted from resolved reports.
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const disputeLosses = db.prepare(
    "SELECT user_id, COUNT(*) AS n FROM reputation_events WHERE event_type = 'dispute_false_submission' AND created_at >= ? GROUP BY user_id HAVING COUNT(*) >= 3",
  ).all(thirtyAgo);
  const reportActions = db.prepare(
    "SELECT reported_user_id AS user_id, COUNT(*) AS n FROM reports WHERE status = 'resolved' AND action_taken IN ('warning', 'temp_ban', 'permanent_ban') AND resolved_at >= ? GROUP BY reported_user_id HAVING COUNT(*) >= 3",
  ).all(thirtyAgo);
  const flagged = new Map();
  for (const r of disputeLosses) flagged.set(r.user_id, { disputeLosses: r.n, reportActions: 0 });
  for (const r of reportActions) {
    const cur = flagged.get(r.user_id) || { disputeLosses: 0, reportActions: 0 };
    cur.reportActions = r.n;
    flagged.set(r.user_id, cur);
  }
  for (const [userId, counts] of flagged.entries()) {
    groups.push({
      reason: 'repeated_adverse_findings',
      detail: `3+ adverse findings in the last 30 days: ${counts.disputeLosses} dispute losses, ${counts.reportActions} resolved report actions`,
      users: [repo.publicUserDisplay(usersRepo.findById(userId))].filter(Boolean),
    });
  }
  return groups;
}

// --- Agreement gate ---
function agreementRequired() {
  return settingsRepo.getSetting('agreement_required') === true;
}
function checkAgreementGate(userId) {
  if (!agreementRequired()) return { ok: true };
  const doc = repo.currentDocument('match_rules');
  if (!doc) return { ok: true };
  if (repo.hasAccepted(userId, doc.id)) return { ok: true };
  return { ok: false, error: 'You must accept the current match rules before accepting a challenge', documentId: doc.id, version: doc.version };
}

// --- Backup (VACUUM INTO a timestamped copy) ---
function createBackup({ dbPath, createdBy }) {
  const dir = path.join(__dirname, '..', '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  const dest = path.join(dir, filename);
  const escaped = dest.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
  const size = fs.statSync(dest).size;
  const row = repo.createBackup({ filename, storedPath: dest, size, createdBy });
  return {
    ...row,
    note: 'This backup is the SQLite database file only. On-disk image directories (data/evidence, data/avatars, data/team-logos, data/tournament-banners, data/site-banners) are NOT inside the database file and must be backed up as files separately.',
  };
}

module.exports = {
  Part8Error, isMaintenanceEnabled, isEmergencyEnabled, maintenanceInfo, emergencyInfo,
  activeMatchCount, activeRoomIds, statistics, health, runSweep,
  telegramConfigPublic, telegramToken, telegramWebhookSecret, sendTelegramMessage, formatStatsMessage,
  suspiciousGroups, agreementRequired, checkAgreementGate, createBackup,
};
