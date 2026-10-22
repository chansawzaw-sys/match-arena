'use strict';
// Part 6 repository: referral codes/links, the immutable referrer
// link, and referral commission records. Routes never touch SQL;
// the service in src/services/referrals.js owns the rules. Commission
// records are immutable except for the pending -> completed/cancelled
// transition; there is no edit endpoint for them.
const { getDb } = require('../index');

function publicCommission(row) {
  if (!row) return null;
  return {
    id: row.id, roomId: row.room_id, referrerId: row.referrer_id,
    inviteeId: row.invitee_id, ratePercent: row.rate_percent,
    feeAmount: row.fee_amount, amount: row.amount, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function findByCode(code) {
  if (!code) return null;
  return getDb().prepare('SELECT * FROM users WHERE referral_code = ?').get(code) || null;
}

function findCommission(roomId, referrerId) {
  return publicCommission(getDb().prepare(
    'SELECT * FROM referral_commissions WHERE room_id = ? AND referrer_id = ?',
  ).get(roomId, referrerId));
}

function listCommissionsByRoom(roomId) {
  return getDb().prepare('SELECT * FROM referral_commissions WHERE room_id = ? ORDER BY id ASC')
    .all(roomId).map(publicCommission);
}

function listCommissionsByReferrer(referrerId, { status, limit = 50, offset = 0 } = {}) {
  const conditions = ['referrer_id = ?'];
  const params = [referrerId];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = getDb().prepare(
    `SELECT * FROM referral_commissions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM referral_commissions ${where}`).get(...params).n;
  return { commissions: rows.map(publicCommission), total };
}

function createCommission({ roomId, referrerId, inviteeId, ratePercent, feeAmount = null, amount = null, status = 'pending' }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `INSERT INTO referral_commissions (room_id, referrer_id, invitee_id, rate_percent, fee_amount, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(roomId, referrerId, inviteeId, ratePercent, feeAmount, amount, status, now, now);
  return publicCommission(getDb().prepare('SELECT * FROM referral_commissions WHERE id = ?').get(result.lastInsertRowid));
}

function createPendingIfMissing({ roomId, referrerId, inviteeId, ratePercent }) {
  const existing = findCommission(roomId, referrerId);
  if (existing) return { commission: existing, created: false };
  return { commission: createCommission({ roomId, referrerId, inviteeId, ratePercent, status: 'pending' }), created: true };
}

function updateCommission(id, { status, feeAmount, amount }) {
  const current = getDb().prepare('SELECT * FROM referral_commissions WHERE id = ?').get(id);
  if (!current) return null;
  getDb().prepare(
    'UPDATE referral_commissions SET status = ?, fee_amount = ?, amount = ?, updated_at = ? WHERE id = ?',
  ).run(status, feeAmount ?? current.fee_amount, amount ?? current.amount, new Date().toISOString(), id);
  return publicCommission(getDb().prepare('SELECT * FROM referral_commissions WHERE id = ?').get(id));
}

function countInvites(referrerId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?').get(referrerId).n;
}

function totalEarnings(referrerId) {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM referral_commissions WHERE referrer_id = ? AND status = 'completed'",
  ).get(referrerId);
  return row.total;
}

function listInvitees(referrerId) {
  return getDb().prepare('SELECT * FROM users WHERE referrer_id = ? ORDER BY id ASC').all(referrerId);
}

// Dashboard breakdown per invitee. Privacy rule: the caller (the
// service/route) must only expose displayName, wins, fee and earnings
// from these rows — never email, MLBB ID, server ID or balances.
// Fee contributed is the full room fee for each room the invitee won
// (settlements are per room, not per player); this is documented in
// the README, not silently split.
function inviteeStats(referrerId, inviteeId) {
  const wins = getDb().prepare(
    "SELECT COUNT(*) AS n FROM match_history WHERE user_id = ? AND result = 'win'",
  ).get(inviteeId).n;
  const feeRow = getDb().prepare(
    `SELECT COALESCE(SUM(s.fee), 0) AS total FROM settlements s
     JOIN match_history h ON h.room_id = s.room_id
     WHERE h.user_id = ? AND h.result = 'win'`,
  ).get(inviteeId);
  const earnedRow = getDb().prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_commissions
     WHERE referrer_id = ? AND invitee_id = ? AND status = 'completed'`,
  ).get(referrerId, inviteeId);
  return { wins, feeContributed: feeRow.total, commissionEarned: earnedRow.total };
}

function aggregateStats() {
  const referrers = getDb().prepare('SELECT COUNT(DISTINCT referrer_id) AS n FROM users WHERE referrer_id IS NOT NULL').get().n;
  const invites = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id IS NOT NULL').get().n;
  const byStatus = {};
  for (const row of getDb().prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM referral_commissions GROUP BY status').all()) {
    byStatus[row.status] = { count: row.n, totalAmount: row.total };
  }
  return { totalReferrers: referrers, totalInvites: invites, commissionsByStatus: byStatus };
}

function listPlatformFees({ arena, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (arena) { conditions.push('arena = ?'); params.push(arena); }
  if (from) { conditions.push('created_at >= ?'); params.push(from); }
  if (to) { conditions.push('created_at <= ?'); params.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM platform_fee_ledger ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM platform_fee_ledger ${where}`).get(...params).n;
  return {
    fees: rows.map((r) => ({
      id: r.id, transactionId: r.transaction_id, roomId: r.room_id, arena: r.arena,
      amount: r.amount, feeType: r.fee_type, feeValue: r.fee_value, createdAt: r.created_at,
    })),
    total,
  };
}

module.exports = {
  publicCommission, findByCode, findCommission, listCommissionsByRoom,
  listCommissionsByReferrer, createCommission, createPendingIfMissing,
  updateCommission, countInvites, totalEarnings, listInvitees, inviteeStats,
  aggregateStats, listPlatformFees,
};
