'use strict';
// Part 6 business logic: referral codes, attach-once, direct-only
// commissions, fee preview. This service never imports the results
// service (results imports this service for settlement hooks), so
// there is no import cycle; the fee math below mirrors Part 5
// settlement math exactly (percent: floor(pot * pct / 100); fixed:
// min(fixed, pot)) and the preview test checks it against settlement.
const { getDb } = require('../db');
const usersRepo = require('../db/repos/users');
const matchRoomsRepo = require('../db/repos/matchRooms');
const resultsRepo = require('../db/repos/results');
const referralsRepo = require('../db/repos/referrals');
const settingsRepo = require('../db/repos/settings');
const walletService = require('./wallet');
const auditRepo = require('../db/repos/audit');
const { normalizeReferralCode } = require('../utils/referralCode');

class ReferralError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ARENAS = ['1v1', 'Classic', 'Brawl'];

function currentRate() {
  const rate = settingsRepo.getSetting('referral.commission_percent');
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
}

function rateForRoom(room) {
  // room may be a public room (referralRateSnapshot) or a raw row.
  const snapshot = room.referralRateSnapshot ?? room.referral_rate_snapshot;
  if (typeof snapshot === 'number' && Number.isFinite(snapshot)) return snapshot;
  return currentRate();
}

function computeCommissionAmount(feeAmount, ratePercent) {
  if (!Number.isInteger(feeAmount) || feeAmount <= 0) return 0;
  return Math.floor((feeAmount * ratePercent) / 100);
}

function computeFee(pot, fee) {
  if (fee.type === 'percent') return Math.floor((pot * fee.value) / 100);
  return Math.min(fee.value, pot);
}

function feeForArena(arena) {
  const fee = settingsRepo.getSetting(`fee.${arena}`);
  if (fee && (fee.type === 'percent' || fee.type === 'fixed') && Number.isInteger(fee.value)) return fee;
  return { type: 'percent', value: 0 };
}

function ensureCodeForUser(userRow) {
  if (!userRow) return null;
  if (userRow.referral_code) return userRow;
  // Lazy backfill for users created before Part 6 (the seed step also
  // backfills on boot; this covers any row that still has NULL).
  const { generateReferralCode } = require('../utils/referralCode');
  const db = getDb();
  for (let i = 0; i < 20; i++) {
    const code = generateReferralCode();
    try {
      db.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(code, userRow.id);
      const updated = usersRepo.findById(userRow.id);
      if (updated && updated.referral_code) return updated;
    } catch (err) {
      if (!String(err.message || '').includes('UNIQUE')) throw err;
    }
  }
  throw new ReferralError(500, 'Could not generate a unique referral code');
}

function publicReferralUser(row) {
  const u = usersRepo.publicUser(row);
  return { ...u, referralCode: row.referral_code ?? null, referrerId: row.referrer_id ?? null, referralAttachedAt: row.referral_attached_at ?? null };
}

function attachReferrer({ userId, referralCode }) {
  const code = normalizeReferralCode(referralCode);
  if (!code) throw new ReferralError(400, 'referralCode is required');
  const user = ensureCodeForUser(usersRepo.findById(userId));
  if (!user) throw new ReferralError(404, 'User not found');
  if (user.referrer_id) throw new ReferralError(409, 'A referrer has already been attached and cannot be changed');
  const referrer = referralsRepo.findByCode(code);
  if (!referrer) throw new ReferralError(404, 'Referral code not found');
  if (referrer.id === user.id) throw new ReferralError(400, 'You cannot refer yourself');
  if (code === user.referral_code) throw new ReferralError(400, 'You cannot refer yourself');
  // Fraud check: same MLBB ID on both sides (when both are set).
  if (user.mlbb_id && referrer.mlbb_id && user.mlbb_id === referrer.mlbb_id) {
    throw new ReferralError(400, 'Referrer and invitee cannot share the same MLBB ID');
  }
  const db = getDb();
  const now = new Date().toISOString();
  const info = db.prepare(
    'UPDATE users SET referrer_id = ?, referral_attached_at = ?, updated_at = ? WHERE id = ? AND referrer_id IS NULL',
  ).run(referrer.id, now, now, user.id);
  if (info.changes === 0) throw new ReferralError(409, 'A referrer has already been attached and cannot be changed');
  auditRepo.recordAudit({
    actorId: user.id, actorEmail: user.email, action: 'referral.attached',
    targetType: 'user', targetId: user.id, details: { referrerId: referrer.id, referralCode: code },
  });
  return { user: publicReferralUser(usersRepo.findById(user.id)), referrerId: referrer.id };
}

// Defensive guard (spec item 8): a user appearing on both sides of a
// room must never generate a commission. Part 3/4 participant rules
// already make this impossible via the API; this guard is the
// settlement-time backstop and is unit-tested with synthetic data.
function participantsShareUser(participants) {
  const seen = new Map();
  for (const p of participants) {
    if (seen.has(p.userId) && seen.get(p.userId) !== p.side) return true;
    seen.set(p.userId, p.side);
  }
  return false;
}

function distinctReferrersForParticipants(participants) {
  // Returns [{ referrerId, inviteeId }] — first participant per
  // referrer wins the invitee slot for the dashboard breakdown; the
  // commission itself is per referrer per match (UNIQUE room,referrer).
  const byReferrer = new Map();
  for (const p of participants) {
    const user = usersRepo.findById(p.userId);
    if (!user || !user.referrer_id) continue;
    if (!byReferrer.has(user.referrer_id)) {
      byReferrer.set(user.referrer_id, { referrerId: user.referrer_id, inviteeId: user.id });
    }
  }
  return [...byReferrer.values()];
}

function createPendingPlaceholders(roomId) {
  const room = matchRoomsRepo.findRoom(roomId);
  if (!room) throw new ReferralError(404, 'Match room not found');
  const rate = rateForRoom(room);
  const created = [];
  for (const entry of distinctReferrersForParticipants(room.participants)) {
    const { commission, created: wasCreated } = referralsRepo.createPendingIfMissing({
      roomId, referrerId: entry.referrerId, inviteeId: entry.inviteeId, ratePercent: rate,
    });
    if (wasCreated) created.push(commission);
  }
  return created;
}

function creditCommission({ roomId, referrerId, amount, settledBy }) {
  if (amount <= 0) return null;
  const credited = walletService.creditCoins({
    userId: referrerId, amount, type: 'referral_commission',
    actorId: settledBy ?? null, reference: `room:${roomId}`,
    reason: `Referral commission for match room #${roomId}`,
    idempotencyKey: `room:${roomId}:referral:${referrerId}`,
  });
  // Part 8: commission-received notification, tap-through to the room.
  try {
    matchRoomsRepo.addNotification(referrerId, 'referral_commission_received', roomId,
      `You received ${amount} coins in referral commission for match room #${roomId}.`,
      { category: 'referral', targetType: 'match_room', targetId: roomId });
  } catch { /* notification must never break a settlement credit */ }
  return credited;
}

// Called from inside the Part 5 settlement transaction (auto-confirm).
// Fee comes from the settlement just created; winner payout is never
// reduced by the commission — the commission comes out of the fee.
function isEmergencyEnabled() {
  // Part 8: referral crediting pauses while emergency mode is on.
  // Completed commissions stay completed; new crediting creates or
  // leaves a pending record with no wallet credit (see below).
  return settingsRepo.getSetting('emergency_mode') === true;
}
function completeForSettlement({ roomId, winnerSide, settlement, settledBy }) {
  const room = matchRoomsRepo.findRoom(roomId);
  if (!room) throw new ReferralError(404, 'Match room not found');
  if (isEmergencyEnabled()) {
    // Pause crediting: record pending commissions (one per referrer)
    // with the computed amount, but credit nothing. There is no
    // automatic retry in Part 8; pending emergency-period commissions
    // remain pending for owner review.
    const feeAmount0 = settlement ? settlement.fee : 0;
    if (!feeAmount0 || feeAmount0 <= 0) return { created: [], skipped: true, reason: 'Platform fee is 0; no commission is created' };
    const rate0 = rateForRoom(room);
    const created0 = [];
    for (const entry of distinctReferrersForParticipants(room.participants.filter((p) => p.side === winnerSide))) {
      const existing = referralsRepo.findCommission(roomId, entry.referrerId);
      if (existing) { if (existing.status === 'pending') created0.push(existing); continue; }
      created0.push(referralsRepo.createCommission({
        roomId, referrerId: entry.referrerId, inviteeId: entry.inviteeId,
        ratePercent: rate0, feeAmount: feeAmount0, amount: computeCommissionAmount(feeAmount0, rate0), status: 'pending',
      }));
    }
    return { created: created0, paused: true, reason: 'emergency_mode' };
  }
  const participants = room.participants;
  if (participantsShareUser(participants)) {
    return { skipped: true, reason: 'A user appears on both sides; no commission was created' };
  }
  const feeAmount = settlement ? settlement.fee : 0;
  if (!feeAmount || feeAmount <= 0) return { created: [], skipped: true, reason: 'Platform fee is 0; no commission is created' };
  const rate = rateForRoom(room);
  const created = [];
  const winners = participants.filter((p) => p.side === winnerSide);
  const winnerReferrers = distinctReferrersForParticipants(winners);
  for (const entry of winnerReferrers) {
    const existing = referralsRepo.findCommission(roomId, entry.referrerId);
    const amount = computeCommissionAmount(feeAmount, rate);
    if (existing) {
      if (existing.status !== 'pending') continue;
      const updated = referralsRepo.updateCommission(existing.id, { status: 'completed', feeAmount, amount });
      if (amount > 0) creditCommission({ roomId, referrerId: entry.referrerId, amount, settledBy });
      auditRepo.recordAudit({
        actorId: settledBy ?? null, actorEmail: null, action: 'referral_commission.completed',
        targetType: 'referral_commission', targetId: updated.id, details: { roomId, referrerId: entry.referrerId, amount, feeAmount, ratePercent: rate },
      });
      created.push(updated);
      continue;
    }
    const commission = referralsRepo.createCommission({
      roomId, referrerId: entry.referrerId, inviteeId: entry.inviteeId,
      ratePercent: rate, feeAmount, amount, status: 'completed',
    });
    if (amount > 0) creditCommission({ roomId, referrerId: entry.referrerId, amount, settledBy });
    auditRepo.recordAudit({
      actorId: settledBy ?? null, actorEmail: null, action: 'referral_commission.completed',
      targetType: 'referral_commission', targetId: commission.id, details: { roomId, referrerId: entry.referrerId, amount, feeAmount, ratePercent: rate },
    });
    created.push(commission);
  }
  return { created };
}

// Called from inside the Part 5 dispute-decision transaction.
function resolveDisputeCommissions({ roomId, decision, winnerSide = null, settlement = null, decidedBy }) {
  if (decision === 'winner' && isEmergencyEnabled()) {
    // Part 8 emergency pause: leave placeholders pending, credit nothing.
    let placeholders = referralsRepo.listCommissionsByRoom(roomId);
    if (placeholders.length === 0) createPendingPlaceholders(roomId);
    return { updated: referralsRepo.listCommissionsByRoom(roomId), paused: true, reason: 'emergency_mode' };
  }
  let placeholders = referralsRepo.listCommissionsByRoom(roomId);
  if (placeholders.length === 0) createPendingPlaceholders(roomId);
  placeholders = referralsRepo.listCommissionsByRoom(roomId);
  const room = matchRoomsRepo.findRoom(roomId);
  if (!room) throw new ReferralError(404, 'Match room not found');
  if (decision === 'cancel') {
    const updated = [];
    for (const c of placeholders) {
      if (c.status !== 'pending') continue;
      const row = referralsRepo.updateCommission(c.id, { status: 'cancelled', feeAmount: c.feeAmount, amount: c.amount });
      auditRepo.recordAudit({
        actorId: decidedBy ?? null, actorEmail: null, action: 'referral_commission.cancelled',
        targetType: 'referral_commission', targetId: row.id, details: { roomId, referrerId: row.referrerId, reason: 'dispute_cancelled' },
      });
      updated.push(row);
    }
    return { updated };
  }
  // Winner decision.
  if (participantsShareUser(room.participants)) {
    const updated = [];
    for (const c of placeholders) {
      if (c.status !== 'pending') continue;
      updated.push(referralsRepo.updateCommission(c.id, { status: 'cancelled', feeAmount: c.feeAmount, amount: c.amount }));
    }
    return { updated, skipped: true, reason: 'A user appears on both sides; no commission was created' };
  }
  const feeAmount = settlement ? settlement.fee : 0;
  const rate = rateForRoom(room);
  const updated = [];
  for (const c of placeholders) {
    if (c.status !== 'pending') continue;
    const inviteeIsWinner = room.participants.some((p) => p.userId === c.inviteeId && p.side === winnerSide)
      || room.participants.some((p) => {
        const u = usersRepo.findById(p.userId);
        return u && u.referrer_id === c.referrerId && p.side === winnerSide;
      });
    if (inviteeIsWinner && feeAmount > 0) {
      const amount = computeCommissionAmount(feeAmount, rate);
      const row = referralsRepo.updateCommission(c.id, { status: 'completed', feeAmount, amount });
      if (amount > 0) creditCommission({ roomId, referrerId: c.referrerId, amount, settledBy: decidedBy });
      auditRepo.recordAudit({
        actorId: decidedBy ?? null, actorEmail: null, action: 'referral_commission.completed',
        targetType: 'referral_commission', targetId: row.id, details: { roomId, referrerId: row.referrerId, amount, feeAmount, ratePercent: rate },
      });
      updated.push(row);
    } else {
      const row = referralsRepo.updateCommission(c.id, { status: 'cancelled', feeAmount, amount: c.amount });
      auditRepo.recordAudit({
        actorId: decidedBy ?? null, actorEmail: null, action: 'referral_commission.cancelled',
        targetType: 'referral_commission', targetId: row.id, details: { roomId, referrerId: row.referrerId, reason: inviteeIsWinner ? 'fee_is_zero' : 'invitee_did_not_win' },
      });
      updated.push(row);
    }
  }
  return { updated };
}

function dashboardFor(userId, opts) {
  const user = ensureCodeForUser(usersRepo.findById(userId));
  if (!user) throw new ReferralError(404, 'User not found');
  const history = referralsRepo.listCommissionsByReferrer(userId, opts);
  return {
    referralCode: user.referral_code,
    // Link template: the frontend base URL is configurable (see
    // config.publicBaseUrl); Part 6 does not host a live signup URL.
    referralLink: null, // filled in by the route, which knows the config
    totalInvites: referralsRepo.countInvites(userId),
    totalEarnings: referralsRepo.totalEarnings(userId),
    commissions: history.commissions,
    totalCommissions: history.total,
  };
}

function inviteesFor(userId) {
  const rows = referralsRepo.listInvitees(userId);
  return rows.map((invitee) => {
    const stats = referralsRepo.inviteeStats(userId, invitee.id);
    return {
      displayName: invitee.display_name,
      matchesWon: stats.wins,
      feeContributed: stats.feeContributed,
      commissionEarned: stats.commissionEarned,
    };
  });
}

function feePreview({ arena, stake, participantCount }) {
  if (!ARENAS.includes(arena)) throw new ReferralError(400, `arena must be one of: ${ARENAS.join(', ')}`);
  if (!Number.isInteger(stake) || stake <= 0) throw new ReferralError(400, 'stake must be a positive integer');
  if (!Number.isInteger(participantCount) || participantCount <= 0) throw new ReferralError(400, 'participantCount must be a positive integer');
  const fee = feeForArena(arena);
  const pot = stake * participantCount;
  const feeAmount = computeFee(pot, fee);
  const distributable = pot - feeAmount;
  return {
    preview: true,
    arena, stake, participantCount, pot,
    fee: feeAmount, feeType: fee.type, feeValue: fee.value,
    distributable,
    // Per-winner payout preview assumes a single winner side with
    // participantCount/2 winners (the usual symmetric case); for an
    // asymmetric roster the settlement split in Part 5 still applies
    // per actual winner count, and this field is labelled as a preview.
    perWinnerPayout: Math.floor(distributable / Math.max(1, Math.floor(participantCount / 2))),
    note: 'Preview only — nothing is stored, and the actual settlement uses the fee snapshot taken at room start.',
  };
}

module.exports = {
  ReferralError, currentRate, rateForRoom, computeCommissionAmount, computeFee,
  feeForArena, ensureCodeForUser, publicReferralUser, attachReferrer,
  participantsShareUser, distinctReferrersForParticipants,
  createPendingPlaceholders, completeForSettlement, resolveDisputeCommissions,
  dashboardFor, inviteesFor, feePreview,
};
