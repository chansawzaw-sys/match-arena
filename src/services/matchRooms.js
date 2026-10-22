'use strict';
// Match-room business logic. All room state, chat history, ready flags
// and timestamps live in the database, so a browser refresh, a phone
// switch-off and return, or a reconnect never restarts a timer: every
// timer is derived from server timestamps, never from local storage.
//
// Lifecycle: waiting_ready -> countdown -> started, or waiting_ready ->
// cancelled (ready timeout, or a leader leaving before start). There is
// no background cron in Part 4: any read of a room runs refreshRoom(),
// which deterministically applies a due countdown end or a due ready
// timeout, so an expired waiting room is always reported as cancelled
// with refunds. A scheduled sweeper is a Part 8 addition, not a Part 4
// correctness requirement, because reads already enforce it.
// Result submission is NOT in Part 4: resultWindowOpensAt is exposed
// only as the hook Part 5 will enforce (started_at + 5 minutes).
const { getDb } = require('../db');
const repo = require('../db/repos/matchRooms');
const usersRepo = require('../db/repos/users');
const settingsRepo = require('../db/repos/settings');
const walletService = require('./wallet');

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function teamSizeNumber(teamSize) {
  return parseInt(String(teamSize).split('v')[0], 10);
}

function intSetting(key, fallback) {
  const value = settingsRepo.getSetting(key);
  return Number.isInteger(value) ? value : fallback;
}

function notifyOthers(roomId, actorId, type, message) {
  for (const p of repo.listParticipants(roomId)) {
    if (p.userId !== actorId) repo.addNotification(p.userId, type, roomId, message);
  }
}

function notifyAll(roomId, type, message) {
  for (const p of repo.listParticipants(roomId)) {
    repo.addNotification(p.userId, type, roomId, message);
  }
}

function timerFor(room, nowMs) {
  const now = new Date(nowMs);
  if (room.status === 'countdown' && room.countdownStartedAt) {
    const seconds = intSetting('match.countdown_seconds', 10);
    const end = new Date(new Date(room.countdownStartedAt).getTime() + seconds * 1000);
    return {
      state: 'countdown',
      serverTime: now.toISOString(),
      secondsRemaining: Math.max(0, Math.ceil((end - now) / 1000)),
      countdownEndsAt: end.toISOString(),
      resultWindowOpensAt: room.resultWindowOpensAt ?? null,
    };
  }
  if (room.status === 'started' || room.status === 'result_pending' || room.status === 'disputed' || room.status === 'finished') {
    return {
      state: room.status, serverTime: now.toISOString(), secondsRemaining: 0,
      countdownEndsAt: null, resultWindowOpensAt: room.resultWindowOpensAt ?? null,
    };
  }
  if (room.status === 'cancelled') {
    return {
      state: 'cancelled', serverTime: now.toISOString(), secondsRemaining: 0,
      countdownEndsAt: null, resultWindowOpensAt: null,
    };
  }
  // waiting_ready (and legacy 'created')
  const deadline = room.readyDeadline ? new Date(room.readyDeadline) : null;
  return {
    state: 'waiting', serverTime: now.toISOString(),
    secondsRemaining: deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null,
    countdownEndsAt: null, resultWindowOpensAt: null,
  };
}

function roomDetail(raw) {
  const room = repo.findRoom(raw.id);
  return { ...room, timer: timerFor(room, Date.now()) };
}

// Refund every participant's locked stake for this room, once, using
// the Part 2 refund service with a per-player idempotency key. A
// participant with less locked than the stake (should not happen, but
// guards against a partial state) is skipped rather than failing the
// whole cancellation.
function refundAllParticipants(room) {
  for (const p of repo.listParticipants(room.id)) {
    const balance = walletService.getBalance(p.userId);
    if (balance.locked >= room.stake) {
      walletService.refundLockedCoins({
        userId: p.userId, amount: room.stake, reference: `challenge:${room.challengeId}`,
        reason: `Match room #${room.id} cancelled`, idempotencyKey: `room:${room.id}:refund:${p.userId}`,
      });
    }
  }
}

function cancelRoomInternal(raw, reason) {
  const db = getDb();
  const run = db.transaction(() => {
    const current = repo.findRoomRaw(raw.id);
    if (!current) throw new RoomError(404, 'Match room not found');
    if (current.status === 'cancelled') throw new RoomError(409, 'Match room is already cancelled');
    if (current.status === 'started' || current.status === 'finished_placeholder') {
      throw new RoomError(409, `Cannot cancel a ${current.status} match room`);
    }
    refundAllParticipants({ ...repo.publicRoom(current) });
    const updated = repo.updateRoom(current.id, {
      status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason,
    });
    return updated;
  });
  const updatedRaw = run();
  const detail = roomDetail(updatedRaw);
  // Notifications after the transaction commits, so a rollback never
  // leaves a notification for a cancellation that did not happen.
  notifyAll(detail.id, 'room_cancelled', `Match room #${detail.id} was cancelled: ${reason}`);
  return detail;
}

// Deterministic lifecycle enforcement on read. Returns the (possibly
// transitioned) raw room row, or null if the room does not exist.
function refreshRoom(roomId) {
  const raw = repo.findRoomRaw(roomId);
  if (!raw) return null;
  const now = Date.now();
  if ((raw.status === 'waiting_ready' || raw.status === 'created') && raw.ready_deadline) {
    if (now >= new Date(raw.ready_deadline).getTime()) {
      try {
        return repo.findRoomRaw(cancelRoomInternal(raw, 'ready_timeout').id);
      } catch (err) {
        // Already cancelled by a concurrent read: fall through to the
        // stored row instead of failing the read.
        if (err instanceof RoomError && err.status === 409) return repo.findRoomRaw(roomId);
        throw err;
      }
    }
  }
  if (raw.status === 'countdown' && raw.countdown_started_at) {
    const seconds = intSetting('match.countdown_seconds', 10);
    const end = new Date(raw.countdown_started_at).getTime() + seconds * 1000;
    if (now >= end) {
      const startedAt = new Date(end).toISOString();
      // Part 5: snapshot the per-arena fee and the result window at
      // room start, so later fee/setting changes cannot reprice a
      // match that has already started.
      const windowSeconds = intSetting('match.result_window_seconds', 300);
      const fee = settingsRepo.getSetting(`fee.${raw.arena}`);
      const feeType = fee && (fee.type === 'percent' || fee.type === 'fixed') ? fee.type : 'percent';
      const feeValue = fee && Number.isInteger(fee.value) ? fee.value : 0;
      // Part 6: snapshot the referral rate at room start too, so a
      // rate change mid-match or mid-dispute cannot reprice it.
      const referralRateRaw = settingsRepo.getSetting('referral.commission_percent');
      const referralRate = typeof referralRateRaw === 'number' && Number.isFinite(referralRateRaw) ? referralRateRaw : 1;
      const db = getDb();
      const run = db.transaction(() => repo.updateRoom(raw.id, {
        status: 'started', started_at: startedAt,
        result_window_opens_at: new Date(end + windowSeconds * 1000).toISOString(),
        fee_snapshot_type: feeType, fee_snapshot_value: feeValue,
        referral_rate_snapshot: referralRate,
      }));
      const updated = run();
      notifyAll(updated.id, 'match_started', `Match room #${updated.id} has started.`);
      return updated;
    }
  }
  return raw;
}

const STAFF_READ_ROLES = ['owner', 'admin', 'moderator'];

function requireViewerAccess(raw, viewer) {
  if (!raw) throw new RoomError(404, 'Match room not found');
  const participant = repo.findParticipant(raw.id, viewer.id);
  const staff = STAFF_READ_ROLES.includes(viewer.role);
  if (!participant && !staff) throw new RoomError(403, 'This match room is private');
  return { participant, staff };
}

function getRoom(roomId, viewer) {
  const raw = repo.findRoomRaw(roomId);
  requireViewerAccess(raw, viewer);
  const refreshed = refreshRoom(roomId);
  return roomDetail(refreshed);
}

function getReconnect(roomId, viewer) {
  const detail = getRoom(roomId, viewer);
  return {
    ...detail,
    chat: repo.listChat(roomId, { limit: 50, order: 'asc' }),
    voiceMembers: repo.voiceMembers(roomId),
  };
}

function rosterCounts(room) {
  const counts = repo.countBySide(room.id);
  const needed = teamSizeNumber(room.teamSize);
  return { counts, needed, missing: { A: Math.max(0, needed - counts.A), B: Math.max(0, needed - counts.B) } };
}

function addRosterMember({ roomId, leaderId, userId }) {
  const refreshed = refreshRoom(roomId);
  if (!refreshed) throw new RoomError(404, 'Match room not found');
  const db = getDb();
  const run = db.transaction(() => {
    const raw = repo.findRoomRaw(roomId);
    if (!raw) throw new RoomError(404, 'Match room not found');
    if (raw.status !== 'waiting_ready' && raw.status !== 'created') {
      throw new RoomError(409, `Cannot add roster members to a ${raw.status} match room`);
    }
    const leader = repo.findParticipant(roomId, leaderId);
    if (!leader || leader.role !== 'leader') throw new RoomError(403, 'Only a side leader can add roster members');
    if (repo.findParticipant(roomId, userId)) throw new RoomError(409, 'That user is already in this match room');
    const target = usersRepo.findById(userId);
    if (!target) throw new RoomError(404, 'User not found');
    if (target.status === 'banned') throw new RoomError(400, 'That user is banned');
    const counts = repo.countBySide(roomId);
    const needed = teamSizeNumber(raw.team_size);
    if (counts[leader.side] >= needed) {
      throw new RoomError(409, `Side ${leader.side} is already full (${needed} players)`);
    }
    // Roster members stake the same amount as the leaders: lock it on
    // joining, so a team member cannot play without paying the stake.
    // The lock is inside this transaction, so a failed lock adds nobody.
    walletService.lockCoins({
      userId, amount: raw.stake, reference: `challenge:${raw.challenge_id}`,
      reason: `Match room #${roomId} stake lock (roster)`, idempotencyKey: `room:${roomId}:lock:${userId}`,
    });
    repo.addParticipant(roomId, userId, leader.side, 'member');
    return repo.findRoomRaw(roomId);
  });
  return roomDetail(run());
}

function removeRosterMember({ roomId, leaderId, userId }) {
  const refreshed = refreshRoom(roomId);
  if (!refreshed) throw new RoomError(404, 'Match room not found');
  const db = getDb();
  const run = db.transaction(() => {
    const raw = repo.findRoomRaw(roomId);
    if (!raw) throw new RoomError(404, 'Match room not found');
    if (raw.status !== 'waiting_ready' && raw.status !== 'created') {
      throw new RoomError(409, `Cannot remove roster members from a ${raw.status} match room`);
    }
    const leader = repo.findParticipant(roomId, leaderId);
    if (!leader || leader.role !== 'leader') throw new RoomError(403, 'Only a side leader can remove roster members');
    const target = repo.findParticipant(roomId, userId);
    if (!target) throw new RoomError(404, 'That user is not in this match room');
    if (target.side !== leader.side) throw new RoomError(403, 'A leader can only remove members from their own side');
    if (target.role === 'leader') throw new RoomError(400, 'Use leave to remove a leader; removing a leader cancels the room');
    const balance = walletService.getBalance(userId);
    if (balance.locked >= raw.stake) {
      walletService.refundLockedCoins({
        userId, amount: raw.stake, reference: `challenge:${raw.challenge_id}`,
        reason: `Match room #${roomId} roster removal refund`, idempotencyKey: `room:${roomId}:refund:${userId}`,
      });
    }
    repo.removeParticipant(roomId, userId);
    return repo.findRoomRaw(roomId);
  });
  return roomDetail(run());
}

function leaveRoom({ roomId, userId }) {
  refreshRoom(roomId);
  const raw = repo.findRoomRaw(roomId);
  if (!raw) throw new RoomError(404, 'Match room not found');
  const participant = repo.findParticipant(roomId, userId);
  if (!participant) throw new RoomError(403, 'You are not in this match room');
  if (raw.status !== 'waiting_ready' && raw.status !== 'created') {
    throw new RoomError(409, `Cannot leave a ${raw.status} match room`);
  }
  if (participant.role === 'leader') {
    // A leader leaving before start cancels the whole room (with refunds).
    return cancelRoomInternal(raw, 'leader_left');
  }
  const db = getDb();
  const run = db.transaction(() => {
    const balance = walletService.getBalance(userId);
    if (balance.locked >= raw.stake) {
      walletService.refundLockedCoins({
        userId, amount: raw.stake, reference: `challenge:${raw.challenge_id}`,
        reason: `Match room #${roomId} leave refund`, idempotencyKey: `room:${roomId}:refund:${userId}`,
      });
    }
    repo.removeParticipant(roomId, userId);
    return repo.findRoomRaw(roomId);
  });
  return roomDetail(run());
}

function setReady({ roomId, userId, ready }) {
  const refreshed = refreshRoom(roomId);
  if (!refreshed) throw new RoomError(404, 'Match room not found');
  const db = getDb();
  const run = db.transaction(() => {
    const raw = repo.findRoomRaw(roomId);
    if (!raw) throw new RoomError(404, 'Match room not found');
    if (raw.status !== 'waiting_ready' && raw.status !== 'created') {
      throw new RoomError(409, `Cannot change ready state in a ${raw.status} match room`);
    }
    const participant = repo.findParticipant(roomId, userId);
    if (!participant) throw new RoomError(403, 'You are not in this match room');
    repo.setReady(roomId, userId, ready);
    const participants = repo.listParticipants(roomId);
    const needed = teamSizeNumber(raw.team_size);
    const counts = repo.countBySide(roomId);
    const full = counts.A === needed && counts.B === needed;
    const allReady = participants.length > 0 && participants.every((p) => p.ready);
    if (ready && full && allReady) {
      const updated = repo.updateRoom(roomId, {
        status: 'countdown', countdown_started_at: new Date().toISOString(),
      });
      return { room: updated, startedCountdown: true };
    }
    return { room: repo.findRoomRaw(roomId), startedCountdown: false };
  });
  const { room, startedCountdown } = run();
  const detail = roomDetail(room);
  if (ready && !startedCountdown) {
    notifyOthers(room.id, userId, 'player_ready', `A player is ready in match room #${room.id}.`);
  }
  if (startedCountdown) {
    notifyAll(room.id, 'countdown_started', `Match room #${room.id} countdown has started.`);
  }
  const { missing } = rosterCounts(detail);
  return { ...detail, rosterFull: missing.A === 0 && missing.B === 0, missing };
}

function postChat({ roomId, userId, text }) {
  const raw = repo.findRoomRaw(roomId);
  if (!raw) throw new RoomError(404, 'Match room not found');
  if (raw.status === 'cancelled') throw new RoomError(409, 'Cannot chat in a cancelled match room');
  if (!repo.findParticipant(roomId, userId)) throw new RoomError(403, 'You are not in this match room');
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) {
    throw new RoomError(400, 'Chat text must be 1 to 1000 characters');
  }
  return repo.addChat(roomId, userId, text.trim());
}

function listChat(roomId, viewer, opts) {
  const raw = repo.findRoomRaw(roomId);
  requireViewerAccess(raw, viewer);
  return repo.listChat(roomId, opts);
}

function voiceJoin(roomId, userId) {
  const raw = repo.findRoomRaw(roomId);
  if (!raw) throw new RoomError(404, 'Match room not found');
  if (raw.status === 'cancelled') throw new RoomError(409, 'Cannot join voice in a cancelled match room');
  if (!repo.findParticipant(roomId, userId)) throw new RoomError(403, 'You are not in this match room');
  repo.voiceJoin(roomId, userId);
  return repo.voiceMembers(roomId);
}

function voiceLeave(roomId, userId) {
  if (!repo.findParticipant(roomId, userId)) throw new RoomError(403, 'You are not in this match room');
  repo.voiceLeave(roomId, userId);
  return repo.voiceMembers(roomId);
}

function voiceSignal({ roomId, fromUserId, toUserId, kind, payload }) {
  const raw = repo.findRoomRaw(roomId);
  if (!raw) throw new RoomError(404, 'Match room not found');
  if (raw.status === 'cancelled') throw new RoomError(409, 'Cannot signal in a cancelled match room');
  if (!repo.findParticipant(roomId, fromUserId)) throw new RoomError(403, 'You are not in this match room');
  if (toUserId !== undefined && toUserId !== null && !repo.findParticipant(roomId, toUserId)) {
    throw new RoomError(400, 'Signal recipient is not in this match room');
  }
  if (!['offer', 'answer', 'ice-candidate'].includes(kind)) throw new RoomError(400, 'kind must be offer, answer or ice-candidate');
  if (typeof payload !== 'string' || !payload || payload.length > 5000) {
    throw new RoomError(400, 'payload must be a non-empty string of at most 5000 characters');
  }
  return repo.addSignal(roomId, fromUserId, toUserId ?? null, kind, payload);
}

function voiceSignals(roomId, viewer, afterId) {
  const raw = repo.findRoomRaw(roomId);
  requireViewerAccess(raw, viewer);
  return repo.listSignals(roomId, viewer.id, afterId);
}

module.exports = {
  RoomError, teamSizeNumber, timerFor, getRoom, getReconnect, rosterCounts,
  addRosterMember, removeRosterMember, leaveRoom, setReady, postChat, listChat,
  voiceJoin, voiceLeave, voiceSignal, voiceSignals, refreshRoom, cancelRoomInternal,
};
