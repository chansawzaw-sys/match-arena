'use strict';
// Part 5 business logic: result submission (5-minute server gate),
// matching vs dispute, atomic settlement, admin dispute decisions,
// reputation, reports and match history.
//
// Settlement math, exactly as documented in the README:
//   pot = stake * number of participants (each participant locked one stake)
//   fee = percent: floor(pot * pct / 100); fixed: min(fixed, pot); default 0
//   distributable = pot - fee, split equally among winner-side members:
//   base = floor(distributable / winnerCount), remainder goes to the
//   first winner-side member in roster order (leader first, then
//   members by joined_at, which is listParticipants order).
//   Loser-side locked coins are consumed, never refunded.
//   The fee is recorded in platform_fee_ledger, never as a player balance.
//   A settlement record (UNIQUE room_id) makes a second confirm a 409,
//   never a second payout. Fee changes apply only to rooms started
//   after the change, because the fee at room start is snapshotted in
//   match_rooms (Part 4 refresh) and settlement uses that snapshot;
//   rooms started before Part 5 have no snapshot and fall back to the
//   current fee setting at settlement time.
const crypto = require('crypto');
const { getDb } = require('../db');
const repo = require('../db/repos/results');
const matchRoomsRepo = require('../db/repos/matchRooms');
const matchRoomsService = require('./matchRooms');
const walletService = require('./wallet');
const referralsService = require('./referrals');
const usersRepo = require('../db/repos/users');
const settingsRepo = require('../db/repos/settings');

class ResultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CHEATING_PENALTY = 20;

function feeForRoom(room) {
  if (room.feeSnapshot && (room.feeSnapshot.type === 'percent' || room.feeSnapshot.type === 'fixed')
    && Number.isInteger(room.feeSnapshot.value)) {
    return room.feeSnapshot;
  }
  const fee = settingsRepo.getSetting(`fee.${room.arena}`);
  if (fee && (fee.type === 'percent' || fee.type === 'fixed') && Number.isInteger(fee.value)) return fee;
  return { type: 'percent', value: 0 };
}

function computeFee(pot, fee) {
  if (fee.type === 'percent') return Math.floor((pot * fee.value) / 100);
  return Math.min(fee.value, pot);
}

function notifyParticipants(roomId, type, message, exceptUserId = null, opts = {}) {
  for (const p of matchRoomsRepo.listParticipants(roomId)) {
    if (exceptUserId !== null && p.userId === exceptUserId) continue;
    matchRoomsRepo.addNotification(p.userId, type, roomId, message, opts);
  }
}

function roomOr404(roomId) {
  const raw = matchRoomsRepo.findRoomRaw(roomId);
  if (!raw) throw new ResultError(404, 'Match room not found');
  return raw;
}

// A room must be refreshed (countdown -> started, timeout -> cancelled)
// before any Part 5 action, so a stale 'countdown' row can never accept
// a result. Staff viewers may read submissions/disputes, but only
// participants may submit.
function requireParticipant(roomId, userId) {
  const participant = matchRoomsRepo.findParticipant(roomId, userId);
  if (!participant) throw new ResultError(403, 'You are not in this match room');
  return participant;
}

function requireViewer(roomId, viewer) {
  const participant = matchRoomsRepo.findParticipant(roomId, viewer.id);
  const staff = ['owner', 'admin', 'moderator'].includes(viewer.role);
  if (!participant && !staff) throw new ResultError(403, 'This match room is private');
  return { participant, staff };
}

function submitResult({ roomId, userId, outcome, reason = '' }) {
  if (outcome !== 'win' && outcome !== 'lose') throw new ResultError(400, "outcome must be 'win' or 'lose'");
  // Refresh first (countdown may become started), then validate.
  const refreshedRaw = matchRoomsService.refreshRoom(roomId);
  if (!refreshedRaw) throw new ResultError(404, 'Match room not found');
  const participant = requireParticipant(roomId, userId);
  if (participant.role !== 'leader') {
    throw new ResultError(403, 'Only a side leader can submit a result for their side');
  }
  const room = matchRoomsRepo.findRoom(roomId);
  if (room.status !== 'started' && room.status !== 'result_pending') {
    throw new ResultError(409, `Cannot submit a result for a ${room.status} match room`);
  }
  if (!room.resultWindowOpensAt) {
    throw new ResultError(409, 'This match room has no result window yet');
  }
  const now = Date.now();
  if (now < new Date(room.resultWindowOpensAt).getTime()) {
    throw new ResultError(400, `Result submission is not open yet. It opens at ${room.resultWindowOpensAt} (server time).`);
  }
  if (repo.findSubmission(roomId, participant.side)) {
    throw new ResultError(409, 'Your side has already submitted a result for this match');
  }

  const db = getDb();
  const run = db.transaction(() => {
    const submission = repo.createSubmission({
      roomId, side: participant.side, leaderUserId: userId, outcome, reason: reason || '',
    });
    const all = repo.listSubmissions(roomId);
    if (all.length === 1) {
      repo.setRoomStatus(roomId, 'result_pending');
      return { submission, outcome: 'pending', room: matchRoomsRepo.findRoom(roomId) };
    }
    // Both sides submitted: agree = opposite outcomes.
    const a = all.find((s) => s.side === 'A');
    const b = all.find((s) => s.side === 'B');
    if (!a || !b) {
      repo.setRoomStatus(roomId, 'result_pending');
      return { submission, outcome: 'pending', room: matchRoomsRepo.findRoom(roomId) };
    }
    if (a.outcome !== b.outcome) {
      const winnerSide = a.outcome === 'win' ? 'A' : 'B';
      const settlement = settleRoomInternal(roomId, winnerSide, userId, 'matching submissions');
      // Part 6: commission comes out of the fee only, never out of
      // the winner payout — the settlement above is unchanged by
      // this call, which only credits referrers from the fee.
      referralsService.completeForSettlement({ roomId, winnerSide, settlement, settledBy: userId });
      return { submission, outcome: 'confirmed', winnerSide, settlement, room: matchRoomsRepo.findRoom(roomId) };
    }
    // Disagree: open a dispute, settle nothing, coins stay locked.
    // Part 6: create pending commission placeholders for the direct
    // referrers of all participants, so the pending state is real.
    const dispute = repo.createDispute(roomId);
    referralsService.createPendingPlaceholders(roomId);
    repo.setRoomStatus(roomId, 'disputed');
    return { submission, outcome: 'disputed', dispute, room: matchRoomsRepo.findRoom(roomId) };
  });
  const result = run();
  if (result.outcome === 'pending') {
    notifyParticipants(roomId, 'result_submitted', `A result was submitted for match room #${roomId}.`, userId);
  } else if (result.outcome === 'confirmed') {
    notifyParticipants(roomId, 'result_confirmed', `Match room #${roomId} result confirmed: side ${result.winnerSide} won.`);
  } else if (result.outcome === 'disputed') {
    notifyParticipants(roomId, 'dispute_opened', `Match room #${roomId} results disagreed and a dispute was opened.`);
  }
  return result;
}

function listSubmissions(roomId, viewer) {
  matchRoomsService.refreshRoom(roomId);
  requireViewer(roomId, viewer);
  return repo.listSubmissions(roomId);
}

// Settlement, run inside the caller's transaction (or its own if called
// standalone). It must never run twice for a room: the settlements
// UNIQUE(room_id) row and the room status both guard it.
function settleRoomInternal(roomId, winnerSide, settledBy, reason) {
  if (repo.findSettlementByRoom(roomId)) {
    throw new ResultError(409, 'This match room has already been settled');
  }
  const room = matchRoomsRepo.findRoom(roomId);
  if (!room) throw new ResultError(404, 'Match room not found');
  const participants = matchRoomsRepo.listParticipants(roomId);
  if (participants.length === 0) throw new ResultError(409, 'Match room has no participants');
  const pot = participants.length * room.stake;
  const fee = feeForRoom(room);
  const feeAmount = computeFee(pot, fee);
  const distributable = pot - feeAmount;
  const winners = participants.filter((p) => p.side === winnerSide);
  const losers = participants.filter((p) => p.side !== winnerSide);
  if (winners.length === 0) throw new ResultError(409, 'Winner side has no participants');
  const base = Math.floor(distributable / winners.length);
  const remainder = distributable % winners.length;
  const payouts = winners.map((w, i) => ({
    userId: w.userId, side: w.side, amount: base + (i === 0 ? remainder : 0),
  }));
  // Losers: consume locked stake. Winners: credit payout (match_win).
  for (const loser of losers) {
    walletService.consumeLockedCoins({
      userId: loser.userId, amount: room.stake, reference: `room:${roomId}`,
      reason: `Match room #${roomId} settlement (lost)`, actorId: settledBy,
      idempotencyKey: `room:${roomId}:consume:${loser.userId}`,
    });
  }
  for (const payout of payouts) {
    // A payout of 0 (fee ate the whole pot) is recorded in the
    // settlement but needs no ledger credit: creditCoins requires a
    // positive amount, and crediting 0 would be a no-op entry.
    if (payout.amount > 0) {
      walletService.creditCoins({
        userId: payout.userId, amount: payout.amount, type: 'match_win',
        actorId: settledBy, reference: `room:${roomId}`,
        reason: `Match room #${roomId} winnings`, idempotencyKey: `room:${roomId}:win:${payout.userId}`,
      });
    }
    // Winner-side locked stake is also consumed: the payout is the
    // total they receive (their stake back is inside the pot split),
    // so their locked coins must leave, not be refunded on top.
    walletService.consumeLockedCoins({
      userId: payout.userId, amount: room.stake, reference: `room:${roomId}`,
      reason: `Match room #${roomId} settlement (stake consumed)`, actorId: settledBy,
      idempotencyKey: `room:${roomId}:consume:${payout.userId}`,
    });
  }
  if (feeAmount > 0) {
    repo.addPlatformFee({
      transactionId: crypto.randomUUID(), roomId, arena: room.arena,
      amount: feeAmount, feeType: fee.type, feeValue: fee.value,
    });
  }
  const settlement = repo.createSettlement({
    roomId, winnerSide, pot, fee: feeAmount, feeType: fee.type, feeValue: fee.value,
    payouts, settledBy, reason,
  });
  // History per participant, immutable.
  for (const p of participants) {
    const isWinner = p.side === winnerSide;
    const payout = payouts.find((x) => x.userId === p.userId);
    repo.addHistory({
      roomId, userId: p.userId, arena: room.arena, teamSize: room.teamSize,
      opponentUserIds: participants.filter((x) => x.side !== p.side).map((x) => x.userId),
      result: isWinner ? 'win' : 'lose', status: 'finished',
      stake: room.stake, payout: payout ? payout.amount : 0,
    });
  }
  repo.setRoomStatus(roomId, 'finished');
  return settlement;
}

function decideDispute({ disputeId, viewer, decision, winnerSide = null, reason }) {
  if (!reason || !reason.trim()) throw new ResultError(400, 'A reason is required for a dispute decision');
  if (decision !== 'winner' && decision !== 'cancel') {
    throw new ResultError(400, "decision must be 'winner' or 'cancel'");
  }
  if (decision === 'winner' && winnerSide !== 'A' && winnerSide !== 'B') {
    throw new ResultError(400, 'winnerSide must be A or B for a winner decision');
  }
  const dispute = repo.findDispute(disputeId);
  if (!dispute) throw new ResultError(404, 'Dispute not found');
  if (dispute.status !== 'open') throw new ResultError(409, 'This dispute has already been decided');
  const room = matchRoomsRepo.findRoom(dispute.roomId);
  if (!room) throw new ResultError(404, 'Match room not found');
  if (room.status !== 'disputed') throw new ResultError(409, `Cannot decide a dispute for a ${room.status} match room`);

  const db = getDb();
  const run = db.transaction(() => {
    const decided = repo.decideDispute(disputeId, {
      winnerSide: decision === 'winner' ? winnerSide : null,
      decision, decisionReason: reason.trim(), decidedBy: viewer.id,
    });
    if (decided.conflict) throw new ResultError(409, 'This dispute has already been decided');
    let settlement = null;
    if (decision === 'winner') {
      settlement = settleRoomInternal(dispute.roomId, winnerSide, viewer.id, `dispute decision: side ${winnerSide} won`);
      // Part 6: resolve pending placeholders — winner-side referrers
      // complete (fee > 0 only), all others cancel. No double credit:
      // the UNIQUE (room, referrer) row guards this.
      referralsService.resolveDisputeCommissions({
        roomId: dispute.roomId, decision: 'winner', winnerSide, settlement, decidedBy: viewer.id,
      });
      // The losing side's submission was proven false: penalise its
      // leader -20. The winning side is not penalised.
      const loserSide = winnerSide === 'A' ? 'B' : 'A';
      const loserLeader = matchRoomsRepo.listParticipants(dispute.roomId)
        .find((p) => p.side === loserSide && p.role === 'leader');
      if (loserLeader) {
        repo.applyReputationChange({
          userId: loserLeader.userId, pointsChange: -CHEATING_PENALTY,
          eventType: 'dispute_false_submission',
          reason: `Dispute decision against side ${loserSide} in match room #${dispute.roomId}: ${reason.trim()}`,
          roomId: dispute.roomId, actorId: viewer.id,
        });
      }
    } else {
      // Cancel: refund every participant's locked stake, history as
      // cancelled, room status cancelled. No settlement record.
      const participants = matchRoomsRepo.listParticipants(dispute.roomId);
      for (const p of participants) {
        const balance = walletService.getBalance(p.userId);
        if (balance.locked >= room.stake) {
          walletService.refundLockedCoins({
            userId: p.userId, amount: room.stake, reference: `room:${dispute.roomId}`,
            reason: `Match room #${dispute.roomId} dispute cancel refund`, actorId: viewer.id,
            idempotencyKey: `room:${dispute.roomId}:refund:${p.userId}`,
          });
        }
        repo.addHistory({
          roomId: dispute.roomId, userId: p.userId, arena: room.arena, teamSize: room.teamSize,
          opponentUserIds: participants.filter((x) => x.side !== p.side).map((x) => x.userId),
          result: 'cancelled', status: 'cancelled', stake: room.stake, payout: 0,
        });
      }
      repo.setRoomCancelled(dispute.roomId, 'dispute_cancelled');
      // Part 6: all pending placeholders cancel on a dispute cancel;
      // no commission is created or credited.
      referralsService.resolveDisputeCommissions({
        roomId: dispute.roomId, decision: 'cancel', winnerSide: null, settlement: null, decidedBy: viewer.id,
      });
    }
    return { dispute: decided.dispute, settlement };
  });
  const result = run();
  notifyParticipants(dispute.roomId, 'dispute_decided', `Dispute for match room #${dispute.roomId} was decided: ${decision}${decision === 'winner' ? ` (side ${winnerSide} won)` : ' (cancelled with refunds)'}.`, null,
    { category: 'dispute', disputeId: dispute.id, targetType: 'dispute', targetId: dispute.id });
  return result;
}

function addDisputeNote({ disputeId, viewer, note }) {
  const dispute = repo.findDispute(disputeId);
  if (!dispute) throw new ResultError(404, 'Dispute not found');
  // Notes are for staff investigating, and for participants adding
  // context; outsiders cannot write them.
  const isStaff = ['owner', 'admin', 'moderator'].includes(viewer.role);
  const isParticipant = !!matchRoomsRepo.findParticipant(dispute.roomId, viewer.id);
  if (!isStaff && !isParticipant) throw new ResultError(403, 'You cannot add a note to this dispute');
  if (!note || !note.trim()) throw new ResultError(400, 'A note is required');
  return repo.addDisputeNote(disputeId, viewer.id, note.trim());
}

function getDispute(disputeId, viewer) {
  const dispute = repo.findDispute(disputeId);
  if (!dispute) throw new ResultError(404, 'Dispute not found');
  requireViewer(dispute.roomId, viewer);
  return {
    ...dispute,
    submissions: repo.listSubmissions(dispute.roomId),
    notes: repo.listDisputeNotes(disputeId),
    evidence: repo.listEvidence('dispute', disputeId),
  };
}

function listDisputes(viewer, opts) {
  if (!['owner', 'admin', 'moderator'].includes(viewer.role)) {
    throw new ResultError(403, 'Only staff can list disputes');
  }
  return repo.listDisputes(opts);
}

// --- Reputation ---
function getReputationFor(userId, viewer) {
  if (viewer.id !== userId && !['owner', 'admin', 'moderator', 'support'].includes(viewer.role)) {
    throw new ResultError(403, 'You can only view your own reputation');
  }
  const user = usersRepo.findById(userId);
  if (!user) throw new ResultError(404, 'User not found');
  return repo.getReputation(userId);
}

function listReputationEvents(userId, viewer, opts) {
  getReputationFor(userId, viewer);
  return repo.listReputationEvents(userId, opts);
}

function applyManualPenalty({ userId, points, reason, actorId }) {
  if (!Number.isInteger(points) || points <= 0 || points > 100) {
    throw new ResultError(400, 'points must be an integer between 1 and 100');
  }
  if (!reason || !reason.trim()) throw new ResultError(400, 'A reason is required for a reputation penalty');
  const user = usersRepo.findById(userId);
  if (!user) throw new ResultError(404, 'User not found');
  return repo.applyReputationChange({
    userId, pointsChange: -points, eventType: 'manual_penalty',
    reason: reason.trim(), roomId: null, actorId,
  });
}

// --- Reports ---
function createReport({ reporterId, reportedUserId, category, reason, roomId = null }) {
  if (!repo.REPORT_CATEGORIES.includes(category)) {
    throw new ResultError(400, `category must be one of: ${repo.REPORT_CATEGORIES.join(', ')}`);
  }
  if (reporterId === reportedUserId) throw new ResultError(400, 'You cannot report yourself');
  if (!reason || !reason.trim()) throw new ResultError(400, 'A reason is required for a report');
  const reported = usersRepo.findById(reportedUserId);
  if (!reported) throw new ResultError(404, 'Reported user not found');
  if (roomId !== null && roomId !== undefined) {
    const room = matchRoomsRepo.findRoomRaw(roomId);
    if (!room) throw new ResultError(404, 'Match room not found');
  }
  const db = getDb();
  const run = db.transaction(() => repo.createReport({
    reporterId, reportedUserId, category, reason: reason.trim(), roomId: roomId ?? null,
  }));
  return run();
}

function getReport(reportId, viewer) {
  const report = repo.findReport(reportId);
  if (!report) throw new ResultError(404, 'Report not found');
  const isStaff = ['owner', 'admin', 'moderator', 'support'].includes(viewer.role);
  if (report.reporterId !== viewer.id && !isStaff) throw new ResultError(403, 'You cannot view this report');
  return {
    ...report,
    notes: repo.listReportNotes(reportId),
    evidence: repo.listEvidence('report', reportId),
  };
}

function listReportsFor(viewer, opts) {
  const isStaff = ['owner', 'admin', 'moderator', 'support'].includes(viewer.role);
  if (isStaff) return repo.listReports(opts);
  return repo.listReports({ ...opts, reporterId: viewer.id });
}

function investigateReport({ reportId, viewer, note = null }) {
  const report = repo.findReport(reportId);
  if (!report) throw new ResultError(404, 'Report not found');
  const db = getDb();
  const run = db.transaction(() => {
    const res = repo.setReportInvestigating(reportId);
    if (res.conflict) throw new ResultError(409, 'This report is already resolved');
    if (note && note.trim()) repo.addReportNote(reportId, viewer.id, note.trim());
    return res.report;
  });
  return run();
}

function resolveReport({ reportId, viewer, resolution, action, tempBanUntil = null }) {
  if (!resolution || !resolution.trim()) throw new ResultError(400, 'A resolution is required');
  if (!['none', 'warning', 'temp_ban', 'permanent_ban'].includes(action)) {
    throw new ResultError(400, "action must be 'none', 'warning', 'temp_ban' or 'permanent_ban'");
  }
  let banUntil = null;
  if (action === 'temp_ban') {
    if (!tempBanUntil) throw new ResultError(400, 'tempBanUntil is required for a temporary ban');
    banUntil = new Date(tempBanUntil);
    if (Number.isNaN(banUntil.getTime()) || banUntil <= new Date()) {
      throw new ResultError(400, 'tempBanUntil must be a future date/time');
    }
  }
  const report = repo.findReport(reportId);
  if (!report) throw new ResultError(404, 'Report not found');
  const db = getDb();
  const run = db.transaction(() => {
    const res = repo.resolveReport(reportId, {
      resolution: resolution.trim(), actionTaken: action, resolvedBy: viewer.id,
    });
    if (res.conflict) throw new ResultError(409, 'This report is already resolved');
    if (action === 'temp_ban') usersRepo.setTempBan(report.reportedUserId, banUntil.toISOString());
    if (action === 'permanent_ban') usersRepo.setStatus(report.reportedUserId, 'banned');
    return res.report;
  });
  return run();
}

// --- Match history ---
function listOwnHistory(userId, opts) {
  return repo.listHistory(userId, opts);
}

function historyByMatch(roomId, viewer) {
  if (!['owner', 'admin', 'moderator'].includes(viewer.role)) {
    // Participants may also view their own room's history via their own
    // history list; the by-match lookup is a staff tool.
    throw new ResultError(403, 'Only staff can look up a match by id');
  }
  const rows = repo.findHistoryByMatch(roomId);
  if (rows.length === 0) throw new ResultError(404, 'No match history found for this match id');
  return rows;
}

module.exports = {
  ResultError, CHEATING_PENALTY, feeForRoom, computeFee,
  submitResult, listSubmissions, settleRoomInternal,
  decideDispute, addDisputeNote, getDispute, listDisputes,
  getReputationFor, listReputationEvents, applyManualPenalty,
  createReport, getReport, listReportsFor, investigateReport, resolveReport,
  listOwnHistory, historyByMatch,
};
