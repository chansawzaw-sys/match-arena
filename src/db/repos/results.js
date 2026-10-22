'use strict';
// Part 5 repository: the only place that reads/writes result
// submissions, disputes, settlements, platform fees, reputation,
// reports and match history. Routes never touch SQL; the service in
// src/services/results.js owns the rules. History and ledger rows are
// append-only: there is no update/delete endpoint for them.
const { getDb } = require('../index');

function publicSubmission(row) {
  if (!row) return null;
  return {
    id: row.id, roomId: row.room_id, side: row.side,
    leaderUserId: row.leader_user_id, outcome: row.outcome,
    reason: row.reason || '', createdAt: row.created_at,
  };
}

function createSubmission({ roomId, side, leaderUserId, outcome, reason = '' }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO result_submissions (room_id, side, leader_user_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(roomId, side, leaderUserId, outcome, reason, now);
  return publicSubmission(getDb().prepare('SELECT * FROM result_submissions WHERE id = ?').get(result.lastInsertRowid));
}

function findSubmission(roomId, side) {
  return publicSubmission(getDb().prepare(
    'SELECT * FROM result_submissions WHERE room_id = ? AND side = ?',
  ).get(roomId, side));
}

function listSubmissions(roomId) {
  return getDb().prepare('SELECT * FROM result_submissions WHERE room_id = ? ORDER BY id ASC')
    .all(roomId).map(publicSubmission);
}

// --- Evidence ---
function publicEvidence(row) {
  if (!row) return null;
  return {
    id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, roomId: row.room_id,
    uploaderId: row.uploader_id, originalName: row.original_name, mime: row.mime,
    size: row.size, createdAt: row.created_at,
  };
}

function addEvidence({ ownerType, ownerId, roomId = null, uploaderId, originalName, mime, size, storedPath }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO evidence_files (owner_type, owner_id, room_id, uploader_id, original_name, mime, size, stored_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(ownerType, ownerId, roomId, uploaderId, originalName, mime, size, storedPath, now);
  return publicEvidence(getDb().prepare('SELECT * FROM evidence_files WHERE id = ?').get(result.lastInsertRowid));
}

function findEvidence(id) {
  return publicEvidence(getDb().prepare('SELECT * FROM evidence_files WHERE id = ?').get(id));
}

function findEvidenceRaw(id) {
  return getDb().prepare('SELECT * FROM evidence_files WHERE id = ?').get(id);
}

function listEvidence(ownerType, ownerId) {
  return getDb().prepare('SELECT * FROM evidence_files WHERE owner_type = ? AND owner_id = ? ORDER BY id ASC')
    .all(ownerType, ownerId).map(publicEvidence);
}

function countEvidence(ownerType, ownerId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM evidence_files WHERE owner_type = ? AND owner_id = ?')
    .get(ownerType, ownerId).n;
}

// --- Disputes ---
function publicDispute(row) {
  if (!row) return null;
  return {
    id: row.id, roomId: row.room_id, status: row.status,
    winnerSide: row.winner_side, decision: row.decision,
    decisionReason: row.decision_reason, decidedBy: row.decided_by,
    decidedAt: row.decided_at, createdAt: row.created_at,
  };
}

function createDispute(roomId) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO disputes (room_id, status, created_at) VALUES (?, ?, ?)',
  ).run(roomId, 'open', now);
  return publicDispute(getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(result.lastInsertRowid));
}

function findDisputeByRoom(roomId) {
  return publicDispute(getDb().prepare('SELECT * FROM disputes WHERE room_id = ?').get(roomId));
}

function findDispute(id) {
  return publicDispute(getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id));
}

function listDisputes({ status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(`SELECT * FROM disputes ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM disputes ${where}`).get(...params).n;
  return { disputes: rows.map(publicDispute), total };
}

function decideDispute(id, { winnerSide, decision, decisionReason, decidedBy }) {
  const current = getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id);
  if (!current) return null;
  if (current.status !== 'open') return { conflict: true, dispute: publicDispute(current) };
  const now = new Date().toISOString();
  getDb().prepare(
    'UPDATE disputes SET status = ?, winner_side = ?, decision = ?, decision_reason = ?, decided_by = ?, decided_at = ? WHERE id = ?',
  ).run('decided', winnerSide ?? null, decision, decisionReason, decidedBy ?? null, now, id);
  return { dispute: findDispute(id) };
}

function addDisputeNote(disputeId, authorId, note) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO dispute_notes (dispute_id, author_id, note, created_at) VALUES (?, ?, ?, ?)',
  ).run(disputeId, authorId, note, now);
  const row = getDb().prepare('SELECT * FROM dispute_notes WHERE id = ?').get(result.lastInsertRowid);
  return { id: row.id, disputeId: row.dispute_id, authorId: row.author_id, note: row.note, createdAt: row.created_at };
}

function listDisputeNotes(disputeId) {
  return getDb().prepare('SELECT * FROM dispute_notes WHERE dispute_id = ? ORDER BY id ASC').all(disputeId)
    .map((r) => ({ id: r.id, disputeId: r.dispute_id, authorId: r.author_id, note: r.note, createdAt: r.created_at }));
}

// --- Settlements & platform fees ---
function publicSettlement(row) {
  if (!row) return null;
  return {
    id: row.id, roomId: row.room_id, winnerSide: row.winner_side,
    pot: row.pot, fee: row.fee, feeType: row.fee_type, feeValue: row.fee_value,
    payouts: (() => { try { return JSON.parse(row.payouts || '[]'); } catch { return []; } })(),
    settledBy: row.settled_by, reason: row.reason || '', createdAt: row.created_at,
  };
}

function findSettlementByRoom(roomId) {
  return publicSettlement(getDb().prepare('SELECT * FROM settlements WHERE room_id = ?').get(roomId));
}

function createSettlement({ roomId, winnerSide, pot, fee, feeType, feeValue, payouts, settledBy, reason = '' }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO settlements (room_id, winner_side, pot, fee, fee_type, fee_value, payouts, settled_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(roomId, winnerSide ?? null, pot, fee, feeType, feeValue, JSON.stringify(payouts), settledBy ?? null, reason, now);
  return publicSettlement(getDb().prepare('SELECT * FROM settlements WHERE id = ?').get(result.lastInsertRowid));
}

function addPlatformFee({ transactionId, roomId, arena, amount, feeType, feeValue }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO platform_fee_ledger (transaction_id, room_id, arena, amount, fee_type, fee_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(transactionId, roomId, arena, amount, feeType, feeValue, now);
  const row = getDb().prepare('SELECT * FROM platform_fee_ledger WHERE id = ?').get(result.lastInsertRowid);
  return {
    id: row.id, transactionId: row.transaction_id, roomId: row.room_id, arena: row.arena,
    amount: row.amount, feeType: row.fee_type, feeValue: row.fee_value, createdAt: row.created_at,
  };
}

// --- Room status (Part 5 lifecycle only) ---
function setRoomStatus(roomId, status) {
  getDb().prepare('UPDATE match_rooms SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), roomId);
}

function setRoomCancelled(roomId, reason) {
  getDb().prepare(
    'UPDATE match_rooms SET status = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?',
  ).run('cancelled', new Date().toISOString(), reason, new Date().toISOString(), roomId);
}

// --- Reputation ---
function badgeFor(score) {
  if (score >= 90) return 'Trusted';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Low';
}

function ensureReputation(userId) {
  const now = new Date().toISOString();
  getDb().prepare('INSERT OR IGNORE INTO reputation (user_id, score, updated_at) VALUES (?, 100, ?)')
    .run(userId, now);
  return getDb().prepare('SELECT * FROM reputation WHERE user_id = ?').get(userId);
}

function publicReputation(row, warningCount = 0) {
  if (!row) return null;
  return {
    userId: row.user_id, score: row.score, badge: badgeFor(row.score),
    warningCount, updatedAt: row.updated_at,
  };
}

function getReputation(userId) {
  const row = ensureReputation(userId);
  const warningCount = getDb().prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE reported_user_id = ? AND status = 'resolved' AND action_taken = 'warning'",
  ).get(userId).n;
  return publicReputation(row, warningCount);
}

function applyReputationChange({ userId, pointsChange, eventType, reason, roomId = null, actorId = null }) {
  const row = ensureReputation(userId);
  const next = Math.max(0, row.score + pointsChange);
  const now = new Date().toISOString();
  getDb().prepare('UPDATE reputation SET score = ?, updated_at = ? WHERE user_id = ?').run(next, now, userId);
  const result = getDb().prepare(
    'INSERT INTO reputation_events (user_id, points_change, event_type, reason, room_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, pointsChange, eventType, reason, roomId, actorId, now);
  const event = getDb().prepare('SELECT * FROM reputation_events WHERE id = ?').get(result.lastInsertRowid);
  return {
    reputation: getReputation(userId),
    event: {
      id: event.id, userId: event.user_id, pointsChange: event.points_change,
      eventType: event.event_type, reason: event.reason, roomId: event.room_id,
      actorId: event.actor_id, createdAt: event.created_at,
    },
  };
}

function listReputationEvents(userId, { limit = 50, offset = 0 } = {}) {
  const rows = getDb().prepare('SELECT * FROM reputation_events WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(userId, Math.min(limit, 200), offset);
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM reputation_events WHERE user_id = ?').get(userId).n;
  return {
    events: rows.map((r) => ({
      id: r.id, userId: r.user_id, pointsChange: r.points_change, eventType: r.event_type,
      reason: r.reason, roomId: r.room_id, actorId: r.actor_id, createdAt: r.created_at,
    })),
    total,
  };
}

// --- Reports ---
const REPORT_CATEGORIES = ['cheating', 'toxic_behaviour', 'fake_screenshot', 'intentional_disconnect', 'fake_account', 'other'];

function publicReport(row) {
  if (!row) return null;
  return {
    id: row.id, caseId: row.case_id, reporterId: row.reporter_id,
    reportedUserId: row.reported_user_id, category: row.category, reason: row.reason,
    roomId: row.room_id, status: row.status, resolution: row.resolution,
    actionTaken: row.action_taken, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createReport({ reporterId, reportedUserId, category, reason, roomId = null }) {
  const now = new Date().toISOString();
  // Case id is generated inside the caller's transaction (SQLite is a
  // single writer), so the daily sequence cannot collide: REP-YYYYMMDD-NNNN.
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM reports WHERE case_id LIKE ?").get(`REP-${datePart}-%`).n;
  const caseId = `REP-${datePart}-${String(count + 1).padStart(4, '0')}`;
  const result = getDb().prepare(
    'INSERT INTO reports (case_id, reporter_id, reported_user_id, category, reason, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(caseId, reporterId, reportedUserId, category, reason, roomId, 'open', now, now);
  return publicReport(getDb().prepare('SELECT * FROM reports WHERE id = ?').get(result.lastInsertRowid));
}

function findReport(id) {
  return publicReport(getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id));
}

function listReports({ reporterId, reportedUserId, status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (reporterId) { conditions.push('reporter_id = ?'); params.push(reporterId); }
  if (reportedUserId) { conditions.push('reported_user_id = ?'); params.push(reportedUserId); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(`SELECT * FROM reports ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM reports ${where}`).get(...params).n;
  return { reports: rows.map(publicReport), total };
}

function setReportInvestigating(id) {
  const current = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!current) return null;
  if (current.status !== 'open' && current.status !== 'investigating') return { conflict: true, report: publicReport(current) };
  const now = new Date().toISOString();
  getDb().prepare("UPDATE reports SET status = 'investigating', updated_at = ? WHERE id = ?").run(now, id);
  return { report: findReport(id) };
}

function resolveReport(id, { resolution, actionTaken, resolvedBy }) {
  const current = getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!current) return null;
  if (current.status === 'resolved') return { conflict: true, report: publicReport(current) };
  const now = new Date().toISOString();
  getDb().prepare(
    'UPDATE reports SET status = ?, resolution = ?, action_taken = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?',
  ).run('resolved', resolution, actionTaken, resolvedBy ?? null, now, now, id);
  return { report: findReport(id) };
}

function addReportNote(reportId, authorId, note) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO report_notes (report_id, author_id, note, created_at) VALUES (?, ?, ?, ?)',
  ).run(reportId, authorId, note, now);
  const row = getDb().prepare('SELECT * FROM report_notes WHERE id = ?').get(result.lastInsertRowid);
  return { id: row.id, reportId: row.report_id, authorId: row.author_id, note: row.note, createdAt: row.created_at };
}

function listReportNotes(reportId) {
  return getDb().prepare('SELECT * FROM report_notes WHERE report_id = ? ORDER BY id ASC').all(reportId)
    .map((r) => ({ id: r.id, reportId: r.report_id, authorId: r.author_id, note: r.note, createdAt: r.created_at }));
}

// --- Match history (immutable) ---
function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id, matchId: row.room_id, roomId: row.room_id, userId: row.user_id,
    arena: row.arena, teamSize: row.team_size,
    opponentUserIds: (() => { try { return JSON.parse(row.opponent_user_ids || '[]'); } catch { return []; } })(),
    result: row.result, status: row.status, stake: row.stake, payout: row.payout,
    createdAt: row.created_at,
  };
}

function addHistory({ roomId, userId, arena, teamSize, opponentUserIds, result, status, stake, payout = 0 }) {
  const now = new Date().toISOString();
  const row = getDb().prepare(
    'INSERT INTO match_history (room_id, user_id, arena, team_size, opponent_user_ids, result, status, stake, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(roomId, userId, arena, teamSize, JSON.stringify(opponentUserIds), result, status, stake, payout, now);
  return publicHistory(getDb().prepare('SELECT * FROM match_history WHERE id = ?').get(row.lastInsertRowid));
}

function listHistory(userId, { result, status, limit = 50, offset = 0 } = {}) {
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (result) { conditions.push('result = ?'); params.push(result); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = getDb().prepare(`SELECT * FROM match_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM match_history ${where}`).get(...params).n;
  return { history: rows.map(publicHistory), total };
}

function findHistoryByMatch(roomId) {
  return getDb().prepare('SELECT * FROM match_history WHERE room_id = ? ORDER BY id ASC')
    .all(roomId).map(publicHistory);
}

module.exports = {
  publicSubmission, createSubmission, findSubmission, listSubmissions,
  publicEvidence, addEvidence, findEvidence, findEvidenceRaw, listEvidence, countEvidence,
  publicDispute, createDispute, findDisputeByRoom, findDispute, listDisputes, decideDispute,
  addDisputeNote, listDisputeNotes,
  publicSettlement, findSettlementByRoom, createSettlement, addPlatformFee,
  setRoomStatus, setRoomCancelled,
  badgeFor, ensureReputation, getReputation, applyReputationChange, listReputationEvents,
  REPORT_CATEGORIES, publicReport, createReport, findReport, listReports,
  setReportInvestigating, resolveReport, addReportNote, listReportNotes,
  publicHistory, addHistory, listHistory, findHistoryByMatch,
};
