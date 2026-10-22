'use strict';
// Part 7 business logic: full profiles (computed stats, achievements),
// friends, teams, tournaments, single-elimination brackets, prizes and
// leaderboards. Stats and leaderboards are always computed from real
// rows (match_history, tournaments, bracket matches) — never edited.
const { getDb } = require('../db');
const usersRepo = require('../db/repos/users');
const resultsRepo = require('../db/repos/results');
const matchRoomsRepo = require('../db/repos/matchRooms');
const matchRoomsService = require('./matchRooms');
const walletService = require('./wallet');
const repo = require('../db/repos/part7');
const T = repo.tournaments;

class Part7Error extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function teamSizeNumber(teamSize) {
  return parseInt(String(teamSize).split('v')[0], 10);
}
function periodStart(period) {
  const now = new Date();
  if (period === 'all_time') return null;
  if (period === 'daily') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  if (monthlyCheck(period)) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  if (period === 'weekly') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  throw new Part7Error(400, 'period must be daily, weekly, monthly or all_time');
}
function monthlyCheck(p) { return p === 'monthly'; }

// --- Profile stats ---
function computeStats(rows) {
  let wins = 0; let losses = 0; let cancelled = 0; let currentStreak = 0; let bestStreak = 0; let run = 0;
  const streakDates = {};
  for (const r of rows) {
    if (r.result === 'win') {
      wins++; run++; currentStreak = run;
      if (run > bestStreak) bestStreak = run;
      if (run === 5 && !streakDates[5]) streakDates[5] = r.created_at;
      if (run === 10 && !streakDates[10]) streakDates[10] = r.created_at;
    } else if (r.result === 'lose') {
      losses++; run = 0;
    } else if (r.result === 'cancelled') {
      cancelled++;
      // Cancelled matches are skipped: they neither count nor break a streak.
    }
  }
  // Current streak: walk backwards skipping cancelled rows.
  let cur = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].result === 'win') cur++;
    else if (rows[i].result === 'lose') break;
  }
  const total = wins + losses + cancelled;
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : null;
  return { totalMatches: total, wins, losses, cancelled, winRate, currentWinStreak: cur, bestWinStreak: bestStreak, streakDates };
}
function achievementsFor(userId) {
  const achievements = [];
  const rep = resultsRepo.getReputation(userId);
  if (rep.score >= 90) achievements.push({ type: 'reputation_trusted', badge: 'Trusted', score: rep.score });
  const rows = T.listHistoryRows(userId, null);
  const stats = computeStats(rows);
  if (stats.streakDates[5]) achievements.push({ type: 'win_streak_5', streak: 5, reachedAt: stats.streakDates[5] });
  if (stats.streakDates[10]) achievements.push({ type: 'win_streak_10', streak: 10, reachedAt: stats.streakDates[10] });
  const champs = getDb().prepare(
    'SELECT t.id, t.name, t.completed_at FROM tournaments t JOIN tournament_champion_members m ON m.tournament_id = t.id WHERE m.user_id = ? ORDER BY t.completed_at ASC, t.id ASC',
  ).all(userId);
  for (const c of champs) achievements.push({ type: 'tournament_champion', tournamentId: c.id, tournamentName: c.name, reachedAt: c.completed_at });
  return achievements;
}
function getProfile(userId, viewer) {
  const row = usersRepo.findById(userId);
  if (!row) throw new Part7Error(404, 'User not found');
  const rows = T.listHistoryRows(userId, null);
  const stats = computeStats(rows);
  const rep = resultsRepo.getReputation(userId);
  return {
    ...repo.displayUser(row),
    reputation: { score: rep.score, badge: rep.badge },
    stats: { totalMatches: stats.totalMatches, wins: stats.wins, losses: stats.losses, cancelled: stats.cancelled, winRate: stats.winRate, currentWinStreak: stats.currentWinStreak, bestWinStreak: stats.bestWinStreak },
    tournamentWins: T.tournamentWinsForUser(userId),
    friendsCount: repo.countFriends(userId),
    achievements: achievementsFor(userId),
  };
}
function updateOwnProfile(userId, displayName) {
  const updated = usersRepo.setDisplayName(userId, displayName);
  return getProfile(updated.id, { id: userId });
}

// --- Friends ---
function sendFriendRequest(requesterId, addresseeId) {
  if (requesterId === addresseeId) throw new Part7Error(400, 'You cannot friend yourself');
  if (!usersRepo.findById(addresseeId)) throw new Part7Error(404, 'User not found');
  const existing = repo.findFriendshipBetween(requesterId, addresseeId);
  if (existing) throw new Part7Error(409, `A ${existing.status} friendship already exists with this user`);
  return repo.createFriendship(requesterId, addresseeId);
}
function respondFriendRequest(friendshipId, viewerId, accept) {
  const f = repo.findFriendship(friendshipId);
  if (!f) throw new Part7Error(404, 'Friend request not found');
  if (f.addresseeId !== viewerId) throw new Part7Error(403, 'Only the recipient can respond to this friend request');
  if (f.status !== 'pending') throw new Part7Error(409, `Friend request has already been ${f.status}`);
  return repo.setFriendshipStatus(friendshipId, accept ? 'accepted' : 'rejected');
}
function removeFriend(userId, otherId) {
  const f = repo.findFriendshipBetween(userId, otherId);
  if (!f || f.status !== 'accepted') throw new Part7Error(404, 'Friendship not found');
  repo.deleteFriendship(f.id);
  return { removed: true };
}

// --- Teams ---
function createTeam(leaderId, name) {
  if (repo.teamsForUser(leaderId).length > 0) throw new Part7Error(409, 'You are already in a team');
  if (repo.findTeamByName(name)) throw new Part7Error(409, 'A team with this name already exists');
  return repo.findTeam(repo.createTeam({ name, leaderId }).id);
}
function inviteToTeam(teamId, inviterId, inviteeId) {
  const team = repo.findTeam(teamId);
  if (!team) throw new Part7Error(404, 'Team not found');
  if (team.leaderId !== inviterId) throw new Part7Error(403, 'Only the team leader can invite members');
  if (inviterId === inviteeId) throw new Part7Error(400, 'You cannot invite yourself');
  if (!usersRepo.findById(inviteeId)) throw new Part7Error(404, 'User not found');
  if (repo.findTeamMember(teamId, inviteeId)) throw new Part7Error(409, 'That user is already in this team');
  if (repo.findPendingInvite(teamId, inviteeId)) throw new Part7Error(409, 'That user already has a pending invite to this team');
  if (repo.listTeamMembers(teamId).length >= 5) throw new Part7Error(409, 'Team is full (max 5 members including the leader)');
  return repo.createTeamInvite(teamId, inviterId, inviteeId);
}
function respondTeamInvite(inviteId, viewerId, accept) {
  const inv = repo.findTeamInvite(inviteId);
  if (!inv) throw new Part7Error(404, 'Team invite not found');
  if (inv.inviteeId !== viewerId) throw new Part7Error(403, 'Only the invitee can respond to this invite');
  if (inv.status !== 'pending') throw new Part7Error(409, `Team invite has already been ${inv.status}`);
  if (!accept) return repo.setTeamInviteStatus(inviteId, 'rejected');
  const db = getDb();
  const run = db.transaction(() => {
    const team = repo.findTeam(inv.teamId);
    if (!team) throw new Part7Error(404, 'Team not found');
    if (repo.teamsForUser(viewerId).length > 0) throw new Part7Error(409, 'You are already in a team');
    if (repo.listTeamMembers(inv.teamId).length >= 5) throw new Part7Error(409, 'Team is full (max 5 members including the leader)');
    repo.addTeamMember(inv.teamId, viewerId, 'member');
    return repo.setTeamInviteStatus(inviteId, 'accepted');
  });
  return run();
}
function removeTeamMember(teamId, leaderId, userId) {
  const team = repo.findTeam(teamId);
  if (!team) throw new Part7Error(404, 'Team not found');
  if (team.leaderId !== leaderId) throw new Part7Error(403, 'Only the team leader can remove members');
  if (userId === leaderId) throw new Part7Error(400, 'A leader cannot remove themselves; use leave instead');
  if (!repo.findTeamMember(teamId, userId)) throw new Part7Error(404, 'That user is not in this team');
  repo.removeTeamMember(teamId, userId);
  return repo.findTeam(teamId);
}
function leaveTeam(teamId, userId) {
  const team = repo.findTeam(teamId);
  if (!team) throw new Part7Error(404, 'Team not found');
  const member = repo.findTeamMember(teamId, userId);
  if (!member) throw new Part7Error(403, 'You are not in this team');
  const db = getDb();
  const run = db.transaction(() => {
    repo.removeTeamMember(teamId, userId);
    const remaining = repo.listTeamMembers(teamId);
    if (remaining.length === 0) {
      repo.deleteTeam(teamId);
      return { deleted: true, team: null };
    }
    if (member.role === 'leader') {
      // Earliest-joined remaining member (joined_at, then user id).
      const next = remaining[0];
      repo.setTeamLeader(teamId, next.id);
    }
    return { deleted: false, team: repo.findTeam(teamId) };
  });
  return run();
}
function addTeamToMatchRoom({ roomId, teamId, callerId }) {
  const team = repo.findTeam(teamId);
  if (!team) throw new Part7Error(404, 'Team not found');
  if (team.leaderId !== callerId) throw new Part7Error(403, 'Only the team leader can add their team to a match room');
  const raw = matchRoomsRepo.findRoomRaw(roomId);
  if (!raw) throw new Part7Error(404, 'Match room not found');
  if (raw.status !== 'waiting_ready' && raw.status !== 'created') throw new Part7Error(409, `Cannot add a team to a ${raw.status} match room`);
  const callerParticipant = matchRoomsRepo.findParticipant(roomId, callerId);
  if (!callerParticipant || callerParticipant.role !== 'leader') throw new Part7Error(403, 'Only a side leader can add their team to a match room');
  const members = repo.listTeamMembers(teamId);
  const toAdd = members.filter((m) => !matchRoomsRepo.findParticipant(roomId, m.id));
  const counts = matchRoomsRepo.countBySide(roomId);
  const needed = teamSizeNumber(raw.team_size);
  if (counts[callerParticipant.side] + toAdd.length > needed) {
    throw new Part7Error(409, `Adding this team would exceed the side limit (${needed} players)`);
  }
  for (const m of toAdd) {
    const target = usersRepo.findById(m.id);
    if (!target) throw new Part7Error(404, 'Team member not found');
    if (target.status === 'banned') throw new Part7Error(400, 'A team member is banned');
  }
  const added = [];
  for (const m of toAdd) {
    matchRoomsService.addRosterMember({ roomId, leaderId: callerId, userId: m.id });
    added.push(m.id);
  }
  return { room: matchRoomsService.getRoom(roomId, { id: callerId, role: 'player' }), addedUserIds: added };
}

module.exports = {
  Part7Error, teamSizeNumber, periodStart, computeStats, achievementsFor, getProfile, updateOwnProfile,
  sendFriendRequest, respondFriendRequest, removeFriend,
  createTeam, inviteToTeam, respondTeamInvite, removeTeamMember, leaveTeam, addTeamToMatchRoom,
};

// --- Tournaments ---
function parseTime(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Part7Error(400, `${field} must be a valid ISO date/time`);
  return d;
}
function validateTournamentInput(input) {
  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) throw new Part7Error(400, 'Tournament name is required');
  if (!Number.isInteger(input.prizeCoins) || input.prizeCoins < 0) throw new Part7Error(400, 'prizeCoins must be a non-negative integer');
  const rs = parseTime(input.registrationStart, 'registrationStart');
  const re = parseTime(input.registrationEnd, 'registrationEnd');
  const st = parseTime(input.startTime, 'startTime');
  if (!(rs < re)) throw new Part7Error(400, 'registrationStart must be before registrationEnd');
  if (!(re < st)) throw new Part7Error(400, 'registrationEnd must be before startTime');
  if (input.mode === 'solo' && input.teamSize !== '1v1') throw new Part7Error(400, 'A solo tournament must use team size 1v1');
  if (input.mode === 'team' && !['2v2', '3v3', '4v4', '5v5'].includes(input.teamSize)) throw new Part7Error(400, 'A team tournament must use team size 2v2-5v5');
  if (input.maxRegistrants != null && (!Number.isInteger(input.maxRegistrants) || input.maxRegistrants <= 0)) throw new Part7Error(400, 'maxRegistrants must be a positive integer');
  return { ...input, name: input.name.trim() };
}
function createTournament(input, createdBy) {
  const validated = validateTournamentInput(input);
  return T.createTournament({ ...validated, createdBy });
}
function editTournament(id, input, viewer) {
  const t = T.findTournament(id);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (!['owner', 'admin'].includes(viewer.role)) throw new Part7Error(403, 'Only owner/admin can edit a tournament');
  if (t.status !== 'draft') throw new Part7Error(409, 'Only a draft tournament can be edited');
  const merged = {
    name: input.name ?? t.name,
    prizeDescription: input.prizeDescription ?? t.prizeDescription,
    prizeCoins: input.prizeCoins ?? t.prizeCoins,
    rules: input.rules ?? t.rules,
    registrationStart: input.registrationStart ?? t.registrationStart,
    registrationEnd: input.registrationEnd ?? t.registrationEnd,
    startTime: input.startTime ?? t.startTime,
    mode: input.mode ?? t.mode,
    teamSize: input.teamSize ?? t.teamSize,
    maxRegistrants: input.maxRegistrants !== undefined ? input.maxRegistrants : t.maxRegistrants,
  };
  const validated = validateTournamentInput(merged);
  return T.updateTournament(id, validated);
}
function openRegistration(id, viewer) {
  const t = T.findTournament(id);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (!['owner', 'admin'].includes(viewer.role)) throw new Part7Error(403, 'Only owner/admin can open registration');
  if (t.status !== 'draft') throw new Part7Error(409, `Cannot open registration for a ${t.status} tournament`);
  return T.setTournamentStatus(id, 'registration_open');
}
function cancelTournament(id, viewer) {
  const t = T.findTournament(id);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (!['owner', 'admin'].includes(viewer.role)) throw new Part7Error(403, 'Only owner/admin can cancel a tournament');
  if (!['draft', 'registration_open'].includes(t.status)) throw new Part7Error(409, `Cannot cancel a ${t.status} tournament`);
  return T.setTournamentStatus(id, 'cancelled');
}
function registerForTournament(id, viewer, body) {
  const t = T.findTournament(id);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (t.status !== 'registration_open') throw new Part7Error(409, 'Tournament registration is not open');
  const now = new Date();
  if (now < new Date(t.registrationStart) || now > new Date(t.registrationEnd)) throw new Part7Error(409, 'Outside the registration window');
  if (now >= new Date(t.startTime)) throw new Part7Error(409, 'Tournament has already started');
  if (t.maxRegistrants != null && T.countRegistrations(id) >= t.maxRegistrants) throw new Part7Error(409, 'Tournament is full');
  const db = getDb();
  const run = db.transaction(() => {
    if (t.mode === 'solo') {
      if (body && body.type && body.type !== 'player') throw new Part7Error(400, 'This is a solo tournament');
      const existing = T.listRegistrations(id).find((r) => r.registrantType === 'player' && r.playerId === viewer.id);
      if (existing) throw new Part7Error(409, 'You are already registered in this tournament');
      return T.createRegistration({ tournamentId: id, registrantType: 'player', playerId: viewer.id });
    }
    if (body && body.type === 'team' && body.teamId) {
      const already = T.listRegistrations(id).find((r) => r.registrantType === 'team' && r.teamId === body.teamId);
      if (already) throw new Part7Error(409, 'This team is already registered in this tournament');
    }
    if (!body || body.type !== 'team' || !body.teamId) throw new Part7Error(400, 'A team tournament requires a teamId');
    const team = repo.findTeam(body.teamId);
    if (!team) throw new Part7Error(404, 'Team not found');
    if (team.leaderId !== viewer.id) throw new Part7Error(403, 'Only the team leader can register the team');
    const members = repo.listTeamMembers(body.teamId);
    if (members.length !== teamSizeNumber(t.teamSize)) throw new Part7Error(400, `Team size must be exactly ${t.teamSize} for this tournament`);
    // A player already in a registered team for this tournament cannot
    // register another team.
    const regs = T.listRegistrations(id);
    for (const r of regs) {
      if (r.registrantType === 'team') {
        const mIds = (r.team.members || []).map((m) => m.id);
        if (mIds.includes(viewer.id)) throw new Part7Error(409, 'You are already registered in this tournament via a team');
      }
    }
    return T.createRegistration({ tournamentId: id, registrantType: 'team', teamId: body.teamId });
  });
  return run();
}
function cancelRegistration(tournamentId, registrationId, viewer) {
  const t = T.findTournament(tournamentId);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (t.status !== 'registration_open') throw new Part7Error(409, 'Registration can only be cancelled before the tournament starts');
  const reg = T.findRegistration(registrationId);
  if (!reg || reg.tournamentId !== tournamentId) throw new Part7Error(404, 'Registration not found');
  if (reg.status !== 'registered') throw new Part7Error(409, 'Registration is already cancelled');
  if (reg.registrantType === 'player' && reg.playerId !== viewer.id) throw new Part7Error(403, 'Only the registered player can cancel this registration');
  if (reg.registrantType === 'team') {
    const team = repo.findTeam(reg.teamId);
    if (!team || team.leaderId !== viewer.id) throw new Part7Error(403, 'Only the team leader can cancel this registration');
  }
  return T.cancelRegistration(registrationId);
}

// Bracket generation: byes are top seeds placed directly into round 2;
// the remaining participants play round-1 (play-in) matches. Round 2
// entrants are [bye seeds..., play-in winners...] paired sequentially,
// and later rounds feed by ceil(slot/2). See README for the worked
// examples (3, 5, 6 and 7 participants).
function generateBracket(tournamentId) {
  const regs = T.listRegistrations(tournamentId);
  const participants = regs.map((r) => (r.registrantType === 'player' ? { type: 'player', id: r.playerId } : { type: 'team', id: r.teamId }));
  const n = participants.length;
  const totalRounds = Math.ceil(Math.log2(n));
  const byes = Math.pow(2, totalRounds) - n;
  const byeParticipants = participants.slice(0, byes);
  const playin = participants.slice(byes);
  const db = getDb();
  const run = db.transaction(() => {
    const playinMatches = [];
    for (let i = 0; i < playin.length; i += 2) {
      const status = totalRounds === 1 ? 'ongoing' : 'ongoing';
      playinMatches.push(T.createBracketMatch({
        tournamentId, round: 1, slot: (i / 2) + 1,
        participantAType: playin[i].type, participantAId: playin[i].id,
        participantBType: playin[i + 1].type, participantBId: playin[i + 1].id,
        status,
      }));
    }
    if (totalRounds >= 2) {
      // Round 2 entrants: bye seeds, then play-in winners as feeders.
      const entrants = [];
      for (const p of byeParticipants) entrants.push({ type: p.type, id: p.id, feeder: null });
      for (const m of playinMatches) entrants.push({ type: null, id: null, feeder: m.id });
      const round2Count = Math.pow(2, totalRounds - 2) === 0 ? 1 : Math.pow(2, totalRounds - 2);
      // For totalRounds=2, round 2 is the final: exactly 1 match.
      const matches2 = totalRounds === 2 ? 1 : round2Count;
      for (let s = 0; s < matches2; s++) {
        const a = entrants[2 * s]; const b = entrants[2 * s + 1];
        const bothKnown = a && b && a.id != null && b.id != null;
        T.createBracketMatch({
          tournamentId, round: 2, slot: s + 1,
          participantAType: a && a.type ? a.type : null, participantAId: a ? a.id : null,
          participantBType: b && b.type ? b.type : null, participantBId: b ? b.id : null,
          feederAMatchId: a && a.feeder ? a.feeder : null, feederBMatchId: b && b.feeder ? b.feeder : null,
          status: bothKnown ? 'ongoing' : 'pending',
        });
      }
      for (let r = 3; r <= totalRounds; r++) {
        const count = Math.pow(2, totalRounds - r);
        const prev = T.listBracketMatches(tournamentId).filter((m) => m.round === r - 1);
        for (let s = 0; s < count; s++) {
          const fa = prev.find((m) => m.slot === 2 * s + 1);
          const fb = prev.find((m) => m.slot === 2 * s + 2);
          T.createBracketMatch({
            tournamentId, round: r, slot: s + 1,
            feederAMatchId: fa ? fa.id : null, feederBMatchId: fb ? fb.id : null,
            status: 'pending',
          });
        }
      }
    }
    return T.listBracketMatches(tournamentId);
  });
  return run();
}
function startTournament(id, viewer) {
  const t = T.findTournament(id);
  if (!t) throw new Part7Error(404, 'Tournament not found');
  if (!['owner', 'admin'].includes(viewer.role)) throw new Part7Error(403, 'Only owner/admin can start a tournament');
  if (t.status !== 'registration_open') throw new Part7Error(409, `Cannot start a ${t.status} tournament`);
  const regs = T.listRegistrations(id);
  if (regs.length < 2) throw new Part7Error(409, 'A tournament needs at least 2 registrants to start');
  const db = getDb();
  const run = db.transaction(() => {
    T.setTournamentStatus(id, 'ongoing');
    return generateBracket(id);
  });
  const bracket = run();
  // Part 8: tournament-started notifications to all registrants
  // (team members individually), tap-through to the tournament.
  try {
    const notified = new Set();
    for (const reg of regs) {
      const userIds = reg.registrantType === 'player' && reg.playerId
        ? [reg.playerId]
        : (reg.teamId ? repo.listTeamMembers(reg.teamId).map((m) => m.id) : []);
      for (const uid of userIds) {
        if (notified.has(uid)) continue;
        notified.add(uid);
        matchRoomsRepo.addNotification(uid, 'tournament_started', null,
          `Tournament #${id} has started.`,
          { category: 'tournament', tournamentId: id, targetType: 'tournament', targetId: id });
      }
    }
  } catch { /* notification must never break a tournament start */ }
  return { tournament: T.findTournament(id), bracket };
}
function recordBracketWinner(matchId, viewer, winnerType, winnerId, reason) {
  if (!['owner', 'admin', 'moderator'].includes(viewer.role)) throw new Part7Error(403, 'Only owner/admin/moderator can record a bracket winner');
  const raw = T.findBracketMatchRaw(matchId);
  if (!raw) throw new Part7Error(404, 'Bracket match not found');
  if (raw.status === 'completed') throw new Part7Error(409, 'Bracket match is already completed');
  if (raw.participant_a_id == null || raw.participant_b_id == null) throw new Part7Error(409, 'Bracket match does not have both participants yet');
  const isParticipant = (raw.participant_a_type === winnerType && raw.participant_a_id === winnerId) || (raw.participant_b_type === winnerType && raw.participant_b_id === winnerId);
  if (!isParticipant) throw new Part7Error(400, 'Winner must be one of the match participants');
  const t = T.findTournament(raw.tournament_id);
  if (!t || t.status !== 'ongoing') throw new Part7Error(409, 'Tournament is not ongoing');
  const db = getDb();
  const run = db.transaction(() => {
    T.updateBracketMatch(matchId, { status: 'completed', winner_type: winnerType, winner_id: winnerId });
    const totalRounds = Math.max(...T.listBracketMatches(raw.tournament_id).map((m) => m.round));
    if (raw.round >= totalRounds) {
      // Final: complete the tournament, snapshot champion members, pay prize once.
      const now = new Date().toISOString();
      let memberUserIds = [];
      if (winnerType === 'player') memberUserIds = [winnerId];
      else memberUserIds = repo.listTeamMembers(winnerId).map((m) => m.id);
      T.addChampionMembers(raw.tournament_id, memberUserIds);
      T.setTournamentStatus(raw.tournament_id, 'completed', { championType: winnerType, championId: winnerId, completedAt: now });
      if (t.prizeCoins > 0) {
        if (winnerType === 'player') {
          walletService.creditCoins({ userId: winnerId, amount: t.prizeCoins, type: 'tournament_prize', actorId: viewer.id, reference: `tournament:${raw.tournament_id}`, reason: `Tournament #${raw.tournament_id} prize`, idempotencyKey: `tournament:${raw.tournament_id}:prize:${winnerId}` });
        } else {
          const members = repo.listTeamMembers(winnerId);
          const base = Math.floor(t.prizeCoins / members.length);
          const remainder = t.prizeCoins - base * members.length;
          for (const m of members) {
            const amount = m.id === t.leaderId || m.role === 'leader' ? base + remainder : base;
            if (amount > 0) {
              walletService.creditCoins({ userId: m.id, amount, type: 'tournament_prize', actorId: viewer.id, reference: `tournament:${raw.tournament_id}`, reason: `Tournament #${raw.tournament_id} prize`, idempotencyKey: `tournament:${raw.tournament_id}:prize:${m.id}` });
            }
          }
        }
      }
      return { match: T.findBracketMatch(matchId), tournament: T.findTournament(raw.tournament_id), completed: true };
    }
    // Advance the winner to the feeder slot in the next round.
    const nextRaw = T.findNextBracketMatchRaw(raw.tournament_id, matchId);
    if (nextRaw) {
      const isFeederA = nextRaw.feeder_a_match_id === matchId;
      const changes = isFeederA
        ? { participant_a_type: winnerType, participant_a_id: winnerId }
        : { participant_b_type: winnerType, participant_b_id: winnerId };
      const filledA = isFeederA ? winnerId : nextRaw.participant_a_id;
      const filledB = isFeederA ? nextRaw.participant_b_id : winnerId;
      T.updateBracketMatch(nextRaw.id, { ...changes, status: (filledA != null && filledB != null) ? 'ongoing' : 'pending' });
    }
    return { match: T.findBracketMatch(matchId), tournament: T.findTournament(raw.tournament_id), completed: false };
  });
  return run();
}

// --- Leaderboards ---
function leaderboard(category, period, limit, offset) {
  const validCategories = ['top_player', 'most_wins', 'highest_win_streak', 'top_team', 'tournament_champion'];
  if (!validCategories.includes(category)) throw new Part7Error(400, 'Invalid leaderboard category');
  const start = periodStart(period);
  if (category === 'tournament_champion') {
    const champs = T.championsInPeriod(start);
    return { category, period, entries: champs.slice(offset, offset + limit), total: champs.length };
  }
  if (category === 'top_team') {
    const tourneyWins = new Map();
    const champs = T.championsInPeriod(start);
    for (const c of champs) {
      if (c.championType === 'team') tourneyWins.set(c.championId, (tourneyWins.get(c.championId) || 0) + 1);
    }
    const bracketWins = T.bracketWinsByTeam(start);
    const teamIds = new Set([...tourneyWins.keys(), ...bracketWins.keys()]);
    const entries = [...teamIds].map((teamId) => {
      const team = repo.findTeam(teamId);
      return { team: team ? { id: team.id, name: team.name, logoUrl: team.logoUrl, leaderId: team.leaderId } : { id: teamId }, tournamentWins: tourneyWins.get(teamId) || 0, bracketWins: bracketWins.get(teamId) || 0 };
    }).sort((a, b) => (b.tournamentWins - a.tournamentWins) || (b.bracketWins - a.bracketWins) || (a.team.id - b.team.id));
    return { category, period, entries: entries.slice(offset, offset + limit), total: entries.length };
  }
  // Player categories from match_history.
  const rows = T.listHistoryRowsInPeriod(start);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  if (category === 'highest_win_streak') {
    const entries = [];
    for (const [userId, userRows] of byUser.entries()) {
      const stats = computeStats(userRows);
      if (stats.wins === 0 && stats.losses === 0) continue;
      entries.push({ player: repo.displayUserById(userId), bestWinStreak: stats.bestWinStreak, wins: stats.wins, losses: stats.losses, winRate: stats.winRate });
    }
    entries.sort((a, b) => (b.bestWinStreak - a.bestWinStreak) || (b.wins - a.wins) || (a.player.id - b.player.id));
    return { category, period, entries: entries.slice(offset, offset + limit), total: entries.length };
  }
  // top_player and most_wins share the win-count ranking (label only).
  const entries = [];
  for (const [userId, userRows] of byUser.entries()) {
    const stats = computeStats(userRows);
    if (stats.wins === 0) continue;
    const firstWin = userRows.find((r) => r.result === 'win');
    entries.push({ player: repo.displayUserById(userId), wins: stats.wins, losses: stats.losses, winRate: stats.winRate, firstWinAt: firstWin ? firstWin.created_at : null });
  }
  entries.sort((a, b) => (b.wins - a.wins) || ((b.winRate ?? 0) - (a.winRate ?? 0)) || (new Date(a.firstWinAt) - new Date(b.firstWinAt)) || (a.player.id - b.player.id));
  return { category, period, entries: entries.slice(offset, offset + limit), total: entries.length };
}

module.exports.tournaments = {
  createTournament, editTournament, openRegistration, cancelTournament, registerForTournament, cancelRegistration,
  startTournament, recordBracketWinner, generateBracket, leaderboard,
};
