'use strict';
// Match-room repository: the only place that reads/writes match-room,
// participant, chat, voice and notification tables. Routes never touch
// SQL; the service in src/services/matchRooms.js owns lifecycle rules.
// Room detail never exposes a participant's email or other private
// fields — only the display fields a frontend needs for one-tap ID copy.
const { getDb } = require('../index');
const usersRepo = require('./users');

function publicRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    challengeId: row.challenge_id,
    arena: row.arena,
    teamSize: row.team_size,
    creatorId: row.creator_id,
    accepterId: row.accepter_id,
    stake: row.stake,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyDeadline: row.ready_deadline,
    countdownStartedAt: row.countdown_started_at,
    startedAt: row.started_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    resultWindowOpensAt: row.result_window_opens_at,
    feeSnapshot: row.fee_snapshot_type != null ? { type: row.fee_snapshot_type, value: row.fee_snapshot_value } : null,
    referralRateSnapshot: row.referral_rate_snapshot ?? null,
  };
}

function publicParticipant(row) {
  const user = usersRepo.findById(row.user_id);
  return {
    userId: row.user_id,
    side: row.side,
    role: row.role,
    ready: row.ready === 1,
    joinedAt: row.joined_at,
    // Display fields only — never email or other private fields.
    displayName: user ? user.display_name : null,
    avatarUrl: user ? user.avatar_url : null,
    mlbbId: user ? (user.mlbb_id ?? null) : null,
    serverId: user ? (user.server_id ?? null) : null,
    rankTier: user ? (user.rank_tier ?? null) : null,
  };
}

function findRoomRaw(id) {
  return getDb().prepare('SELECT * FROM match_rooms WHERE id = ?').get(id);
}

function findRoom(id) {
  const row = findRoomRaw(id);
  if (!row) return null;
  return { ...publicRoom(row), participants: listParticipants(id) };
}

function listParticipants(roomId) {
  return getDb().prepare(
    'SELECT * FROM match_room_participants WHERE room_id = ? ORDER BY side ASC, role ASC, joined_at ASC, user_id ASC',
  ).all(roomId).map(publicParticipant);
}

function findParticipant(roomId, userId) {
  const row = getDb().prepare(
    'SELECT * FROM match_room_participants WHERE room_id = ? AND user_id = ?',
  ).get(roomId, userId);
  return row || null;
}

function updateRoom(id, changes) {
  const current = findRoomRaw(id);
  if (!current) return null;
  const next = { ...current, ...changes, updated_at: new Date().toISOString() };
  // Fee and referral snapshots are written only when the caller
  // supplies them (at room start); otherwise the stored snapshot is
  // preserved.
  const feeType = changes.fee_snapshot_type !== undefined ? changes.fee_snapshot_type : current.fee_snapshot_type;
  const feeValue = changes.fee_snapshot_value !== undefined ? changes.fee_snapshot_value : current.fee_snapshot_value;
  const referralRate = changes.referral_rate_snapshot !== undefined ? changes.referral_rate_snapshot : current.referral_rate_snapshot;
  getDb().prepare(
    `UPDATE match_rooms SET status = ?, ready_deadline = ?, countdown_started_at = ?,
       started_at = ?, cancelled_at = ?, cancel_reason = ?, result_window_opens_at = ?,
       fee_snapshot_type = ?, fee_snapshot_value = ?, referral_rate_snapshot = ?,
       updated_at = ? WHERE id = ?`,
  ).run(next.status, next.ready_deadline ?? null, next.countdown_started_at ?? null,
    next.started_at ?? null, next.cancelled_at ?? null, next.cancel_reason ?? null,
    next.result_window_opens_at ?? null, feeType ?? null, feeValue ?? null,
    referralRate ?? null, next.updated_at, id);
  return findRoomRaw(id);
}

function addParticipant(roomId, userId, side, role) {
  getDb().prepare(
    'INSERT INTO match_room_participants (room_id, user_id, side, role, ready, joined_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(roomId, userId, side, role, new Date().toISOString());
}

function removeParticipant(roomId, userId) {
  const info = getDb().prepare(
    'DELETE FROM match_room_participants WHERE room_id = ? AND user_id = ?',
  ).run(roomId, userId);
  return info.changes > 0;
}

function setReady(roomId, userId, ready) {
  getDb().prepare(
    'UPDATE match_room_participants SET ready = ? WHERE room_id = ? AND user_id = ?',
  ).run(ready ? 1 : 0, roomId, userId);
}

function countBySide(roomId) {
  const rows = getDb().prepare(
    'SELECT side, COUNT(*) AS n FROM match_room_participants WHERE room_id = ? GROUP BY side',
  ).all(roomId);
  const counts = { A: 0, B: 0 };
  for (const r of rows) counts[r.side] = r.n;
  return counts;
}

// --- Chat ---
function addChat(roomId, userId, text) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO match_room_chat (room_id, user_id, text, created_at) VALUES (?, ?, ?, ?)',
  ).run(roomId, userId, text, now);
  const row = getDb().prepare('SELECT * FROM match_room_chat WHERE id = ?').get(result.lastInsertRowid);
  const user = usersRepo.findById(userId);
  return { id: row.id, roomId: row.room_id, userId: row.user_id, displayName: user ? user.display_name : null, text: row.text, createdAt: row.created_at };
}

function listChat(roomId, { limit = 50, offset = 0, order = 'asc' } = {}) {
  const rows = getDb().prepare(
    `SELECT * FROM match_room_chat WHERE room_id = ? ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
  ).all(roomId, Math.min(limit, 200), offset);
  return rows.map((row) => {
    const user = usersRepo.findById(row.user_id);
    return { id: row.id, roomId: row.room_id, userId: row.user_id, displayName: user ? user.display_name : null, text: row.text, createdAt: row.created_at };
  });
}

// --- Voice signalling (no audio) ---
function voiceJoin(roomId, userId) {
  getDb().prepare(
    'INSERT OR IGNORE INTO match_room_voice (room_id, user_id, joined_at) VALUES (?, ?, ?)',
  ).run(roomId, userId, new Date().toISOString());
}
function voiceLeave(roomId, userId) {
  getDb().prepare('DELETE FROM match_room_voice WHERE room_id = ? AND user_id = ?').run(roomId, userId);
}
function voiceMembers(roomId) {
  return getDb().prepare('SELECT * FROM match_room_voice WHERE room_id = ? ORDER BY joined_at ASC').all(roomId)
    .map((r) => {
      const user = usersRepo.findById(r.user_id);
      return { userId: r.user_id, displayName: user ? user.display_name : null, joinedAt: r.joined_at };
    });
}
function addSignal(roomId, fromUserId, toUserId, kind, payload) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO match_room_voice_signals (room_id, from_user_id, to_user_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(roomId, fromUserId, toUserId ?? null, kind, payload, now);
  const row = getDb().prepare('SELECT * FROM match_room_voice_signals WHERE id = ?').get(result.lastInsertRowid);
  return { id: row.id, roomId: row.room_id, fromUserId: row.from_user_id, toUserId: row.to_user_id, kind: row.kind, payload: row.payload, createdAt: row.created_at };
}
function listSignals(roomId, userId, afterId = 0) {
  return getDb().prepare(
    'SELECT * FROM match_room_voice_signals WHERE room_id = ? AND id > ? AND (to_user_id IS NULL OR to_user_id = ?) ORDER BY id ASC',
  ).all(roomId, afterId, userId).map((row) => ({
    id: row.id, roomId: row.room_id, fromUserId: row.from_user_id, toUserId: row.to_user_id,
    kind: row.kind, payload: row.payload, createdAt: row.created_at,
  }));
}

// --- Notifications (Part 8 centre; Part 4-6 callers pass only the
// first four arguments). The 5th argument is optional:
// { category, tournamentId, disputeId, targetType, targetId }.
// Rows created before Part 8 have NULL category/targets; the Part 8
// list function derives a category from the type for those rows.
function publicNotification(row) {
  if (!row) return null;
  const category = row.category || (
    row.type === 'referral_commission_received' ? 'referral'
    : (row.type === 'tournament_started' ? 'tournament'
    : (row.type === 'dispute_opened' || row.type === 'dispute_decided' ? 'dispute'
    : (row.type === 'announcement' ? 'announcement' : 'match'))));
  const target = row.target_type
    ? { type: row.target_type, id: row.target_id }
    : (row.room_id ? { type: 'match_room', id: row.room_id }
    : (row.tournament_id ? { type: 'tournament', id: row.tournament_id }
    : (row.dispute_id ? { type: 'dispute', id: row.dispute_id } : null)));
  return {
    id: row.id, userId: row.user_id, type: row.type, category,
    roomId: row.room_id ?? null, tournamentId: row.tournament_id ?? null,
    disputeId: row.dispute_id ?? null, target,
    message: row.message, read: row.read === 1, createdAt: row.created_at,
  };
}
function addNotification(userId, type, roomId, message, opts = {}) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO notifications (user_id, type, room_id, message, read, created_at, category, tournament_id, dispute_id, target_type, target_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
  ).run(userId, type, roomId ?? null, message, now,
    opts.category || null, opts.tournamentId ?? null, opts.disputeId ?? null,
    opts.targetType || null, opts.targetId ?? null);
  const row = getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(result.lastInsertRowid);
  return publicNotification(row);
}
function listUnread(userId) {
  return getDb().prepare('SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY id DESC').all(userId)
    .map((row) => ({ id: row.id, userId: row.user_id, type: row.type, roomId: row.room_id, message: row.message, read: false, createdAt: row.created_at }));
}
function listNotifications(userId, { limit = 50, offset = 0 } = {}) {
  return getDb().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, Math.min(limit, 200), offset)
    .map((row) => ({ id: row.id, userId: row.user_id, type: row.type, roomId: row.room_id, message: row.message, read: row.read === 1, createdAt: row.created_at }));
}
function markNotificationRead(id, userId) {
  const info = getDb().prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}
// Part 8 centre: filtered list, unread count, mark-all. Category
// filtering must also match the derived category for pre-Part 8 rows,
// so filtering is done in JavaScript after the base query (lists are
// paginated after filtering, with a total that reflects the filter).
function listNotificationsFiltered(userId, { category, read, limit = 50, offset = 0 } = {}) {
  const rows = getDb().prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1000')
    .all(userId).map(publicNotification);
  let filtered = rows;
  if (category) filtered = filtered.filter((n) => n.category === category);
  if (read !== undefined) filtered = filtered.filter((n) => n.read === read);
  const total = filtered.length;
  const page = filtered.slice(offset, offset + Math.min(limit, 200));
  return { notifications: page, total };
}
function unreadNotificationCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;
}
function markAllNotificationsRead(userId) {
  const info = getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  return info.changes;
}

module.exports = {
  publicRoom, publicParticipant, findRoomRaw, findRoom, listParticipants,
  findParticipant, updateRoom, addParticipant, removeParticipant, setReady,
  countBySide, addChat, listChat, voiceJoin, voiceLeave, voiceMembers,
  addSignal, listSignals, addNotification, listUnread, listNotifications,
  markNotificationRead, publicNotification, listNotificationsFiltered,
  unreadNotificationCount, markAllNotificationsRead,
};
