'use strict';
// Part 7 repository: the only place that reads/writes friends, teams,
// tournaments, brackets and profile images. Routes never touch SQL;
// the service in src/services/part7.js owns the rules. Profile
// display fields never include email, balances or other private data.
const { getDb } = require('../index');
const usersRepo = require('./users');
const resultsRepo = require('./results');

function displayUser(row) {
  if (!row) return null;
  return {
    id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url ?? null,
    mlbbId: row.mlbb_id ?? null, serverId: row.server_id ?? null, rankTier: row.rank_tier ?? null,
  };
}
function displayUserById(id) {
  return displayUser(usersRepo.findById(id));
}

// --- Images ---
function addImage({ kind, ownerId, originalName, mime, size, storedPath }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO profile_images (kind, owner_id, original_name, mime, size, stored_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(kind, ownerId, originalName, mime, size, storedPath, now);
  const row = getDb().prepare('SELECT * FROM profile_images WHERE id = ?').get(result.lastInsertRowid);
  return { id: row.id, kind: row.kind, ownerId: row.owner_id, originalName: row.original_name, mime: row.mime, size: row.size, createdAt: row.created_at };
}
function findImage(id) {
  return getDb().prepare('SELECT * FROM profile_images WHERE id = ?').get(id) || null;
}

// --- Friends ---
function findFriendshipBetween(a, b) {
  return getDb().prepare(
    "SELECT * FROM friendships WHERE ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)) AND status IN ('pending', 'accepted')",
  ).get(a, b, b, a) || null;
}
function createFriendship(requesterId, addresseeId) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(requesterId, addresseeId, 'pending', now, now);
  return publicFriendship(getDb().prepare('SELECT * FROM friendships WHERE id = ?').get(result.lastInsertRowid));
}
function publicFriendship(row) {
  if (!row) return null;
  return { id: row.id, requesterId: row.requester_id, addresseeId: row.addressee_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function findFriendship(id) {
  return publicFriendship(getDb().prepare('SELECT * FROM friendships WHERE id = ?').get(id));
}
function setFriendshipStatus(id, status) {
  getDb().prepare('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  return findFriendship(id);
}
function deleteFriendship(id) {
  return getDb().prepare('DELETE FROM friendships WHERE id = ?').run(id).changes > 0;
}
function listFriends(userId) {
  const rows = getDb().prepare(
    "SELECT * FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?) ORDER BY id ASC",
  ).all(userId, userId);
  return rows.map((r) => displayUserById(r.requester_id === userId ? r.addressee_id : r.requester_id)).filter(Boolean);
}
function listPending(userId) {
  const incoming = getDb().prepare("SELECT * FROM friendships WHERE status = 'pending' AND addressee_id = ? ORDER BY id ASC").all(userId).map(publicFriendship);
  const outgoing = getDb().prepare("SELECT * FROM friendships WHERE status = 'pending' AND requester_id = ? ORDER BY id ASC").all(userId).map(publicFriendship);
  return { incoming, outgoing };
}
function countFriends(userId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)").get(userId, userId).n;
}

// --- Teams ---
function publicTeam(row, members) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, leaderId: row.leader_id, logoUrl: row.logo_url ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    members: members || listTeamMembers(row.id),
  };
}
function findTeamRaw(id) {
  return getDb().prepare('SELECT * FROM teams WHERE id = ?').get(id) || null;
}
function findTeam(id) {
  const row = findTeamRaw(id);
  return row ? publicTeam(row) : null;
}
function findTeamByName(name) {
  const row = getDb().prepare('SELECT * FROM teams WHERE lower(name) = lower(?)').get(name);
  return row ? publicTeam(row) : null;
}
function createTeam({ name, leaderId }) {
  const now = new Date().toISOString();
  const result = getDb().prepare('INSERT INTO teams (name, leader_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, leaderId, now, now);
  const id = result.lastInsertRowid;
  getDb().prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(id, leaderId, 'leader', now);
  return findTeam(id);
}
function listTeamMembers(teamId) {
  const rows = getDb().prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at ASC, user_id ASC').all(teamId);
  return rows.map((r) => ({ ...displayUserById(r.user_id), role: r.role, joinedAt: r.joined_at }));
}
function findTeamMember(teamId, userId) {
  return getDb().prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) || null;
}
function teamsForUser(userId) {
  const rows = getDb().prepare('SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.id ASC').all(userId);
  return rows.map((r) => publicTeam(r));
}
function addTeamMember(teamId, userId, role = 'member') {
  getDb().prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(teamId, userId, role, new Date().toISOString());
}
function removeTeamMember(teamId, userId) {
  return getDb().prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId).changes > 0;
}
function setTeamLeader(teamId, userId) {
  getDb().prepare("UPDATE team_members SET role = 'member' WHERE team_id = ?").run(teamId);
  getDb().prepare("UPDATE team_members SET role = 'leader' WHERE team_id = ? AND user_id = ?").run(teamId, userId);
  getDb().prepare('UPDATE teams SET leader_id = ?, updated_at = ? WHERE id = ?').run(userId, new Date().toISOString(), teamId);
}
function deleteTeam(teamId) {
  getDb().prepare('DELETE FROM team_invites WHERE team_id = ?').run(teamId);
  getDb().prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  return getDb().prepare('DELETE FROM teams WHERE id = ?').run(teamId).changes > 0;
}
function setTeamLogo(teamId, logoUrl) {
  getDb().prepare('UPDATE teams SET logo_url = ?, updated_at = ? WHERE id = ?').run(logoUrl, new Date().toISOString(), teamId);
  return findTeam(teamId);
}
function createTeamInvite(teamId, inviterId, inviteeId) {
  const now = new Date().toISOString();
  const result = getDb().prepare('INSERT INTO team_invites (team_id, inviter_id, invitee_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(teamId, inviterId, inviteeId, 'pending', now, now);
  const row = getDb().prepare('SELECT * FROM team_invites WHERE id = ?').get(result.lastInsertRowid);
  return { id: row.id, teamId: row.team_id, inviterId: row.inviter_id, inviteeId: row.invitee_id, status: row.status, createdAt: row.created_at };
}
function findTeamInvite(id) {
  const row = getDb().prepare('SELECT * FROM team_invites WHERE id = ?').get(id);
  return row ? { id: row.id, teamId: row.team_id, inviterId: row.inviter_id, inviteeId: row.invitee_id, status: row.status, createdAt: row.created_at } : null;
}
function findPendingInvite(teamId, inviteeId) {
  const row = getDb().prepare("SELECT * FROM team_invites WHERE team_id = ? AND invitee_id = ? AND status = 'pending'").get(teamId, inviteeId);
  return row ? findTeamInvite(row.id) : null;
}
function setTeamInviteStatus(id, status) {
  getDb().prepare('UPDATE team_invites SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  return findTeamInvite(id);
}
function listTeamInvitesForUser(userId) {
  const rows = getDb().prepare("SELECT * FROM team_invites WHERE invitee_id = ? AND status = 'pending' ORDER BY id ASC").all(userId);
  return rows.map((r) => findTeamInvite(r.id));
}

module.exports = {
  displayUser, displayUserById, addImage, findImage,
  findFriendshipBetween, createFriendship, publicFriendship, findFriendship, setFriendshipStatus, deleteFriendship, listFriends, listPending, countFriends,
  publicTeam, findTeamRaw, findTeam, findTeamByName, createTeam, listTeamMembers, findTeamMember, teamsForUser, addTeamMember, removeTeamMember, setTeamLeader, deleteTeam, setTeamLogo,
  createTeamInvite, findTeamInvite, findPendingInvite, setTeamInviteStatus, listTeamInvitesForUser,
};

// --- Tournaments ---
function publicTournament(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, bannerUrl: row.banner_url ?? null,
    prizeDescription: row.prize_description || '', prizeCoins: row.prize_coins,
    rules: row.rules || '', registrationStart: row.registration_start,
    registrationEnd: row.registration_end, startTime: row.start_time,
    mode: row.mode, teamSize: row.team_size, maxRegistrants: row.max_registrants ?? null,
    status: row.status, championType: row.champion_type ?? null, championId: row.champion_id ?? null,
    completedAt: row.completed_at ?? null, createdBy: row.created_by ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function findTournamentRaw(id) {
  return getDb().prepare('SELECT * FROM tournaments WHERE id = ?').get(id) || null;
}
function findTournament(id) {
  const row = findTournamentRaw(id);
  return row ? publicTournament(row) : null;
}
function createTournament(input) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO tournaments (name, prize_description, prize_coins, rules, registration_start, registration_end, start_time, mode, team_size, max_registrants, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.name, input.prizeDescription || '', input.prizeCoins, input.rules || '', input.registrationStart, input.registrationEnd, input.startTime, input.mode, input.teamSize, input.maxRegistrants ?? null, 'draft', input.createdBy ?? null, now, now);
  return findTournament(result.lastInsertRowid);
}
function updateTournament(id, changes) {
  const cur = findTournamentRaw(id);
  if (!cur) return null;
  // Accept both camelCase (from the service) and snake_case keys.
  const next = {
    name: changes.name ?? cur.name,
    prize_description: changes.prizeDescription ?? changes.prize_description ?? cur.prize_description,
    prize_coins: changes.prizeCoins ?? changes.prize_coins ?? cur.prize_coins,
    rules: changes.rules ?? cur.rules,
    registration_start: changes.registrationStart ?? changes.registration_start ?? cur.registration_start,
    registration_end: changes.registrationEnd ?? changes.registration_end ?? cur.registration_end,
    start_time: changes.startTime ?? changes.start_time ?? cur.start_time,
    mode: changes.mode ?? cur.mode,
    team_size: changes.teamSize ?? changes.team_size ?? cur.team_size,
    max_registrants: changes.maxRegistrants !== undefined ? changes.maxRegistrants : (changes.max_registrants !== undefined ? changes.max_registrants : cur.max_registrants),
  };
  getDb().prepare(
    'UPDATE tournaments SET name = ?, prize_description = ?, prize_coins = ?, rules = ?, registration_start = ?, registration_end = ?, start_time = ?, mode = ?, team_size = ?, max_registrants = ?, updated_at = ? WHERE id = ?',
  ).run(next.name, next.prize_description, next.prize_coins, next.rules, next.registration_start, next.registration_end, next.start_time, next.mode, next.team_size, next.max_registrants ?? null, new Date().toISOString(), id);
  return findTournament(id);
}
function setTournamentStatus(id, status, extra = {}) {
  const sets = ['status = ?', 'updated_at = ?'];
  const params = [status, new Date().toISOString()];
  if (extra.championType !== undefined) { sets.push('champion_type = ?'); params.push(extra.championType); }
  if (extra.championId !== undefined) { sets.push('champion_id = ?'); params.push(extra.championId); }
  if (extra.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(extra.completedAt); }
  if (extra.bannerUrl !== undefined) { sets.push('banner_url = ?'); params.push(extra.bannerUrl); }
  params.push(id);
  getDb().prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return findTournament(id);
}
function listTournaments({ status, limit = 50, offset = 0 } = {}) {
  const conditions = []; const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(`SELECT * FROM tournaments ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM tournaments ${where}`).get(...params).n;
  return { tournaments: rows.map(publicTournament), total };
}
function createRegistration({ tournamentId, registrantType, playerId = null, teamId = null }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO tournament_registrations (tournament_id, registrant_type, player_id, team_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(tournamentId, registrantType, playerId, teamId, 'registered', now);
  const row = getDb().prepare('SELECT * FROM tournament_registrations WHERE id = ?').get(result.lastInsertRowid);
  return publicRegistration(row);
}
function publicRegistration(row) {
  if (!row) return null;
  return { id: row.id, tournamentId: row.tournament_id, registrantType: row.registrant_type, playerId: row.player_id ?? null, teamId: row.team_id ?? null, status: row.status, createdAt: row.created_at };
}
function listRegistrations(tournamentId) {
  const rows = getDb().prepare("SELECT * FROM tournament_registrations WHERE tournament_id = ? AND status = 'registered' ORDER BY id ASC").all(tournamentId);
  return rows.map((r) => {
    const base = publicRegistration(r);
    if (r.registrant_type === 'player') return { ...base, player: displayUserById(r.player_id) };
    const team = findTeam(r.team_id);
    return { ...base, team };
  });
}
function findRegistration(id) {
  return publicRegistration(getDb().prepare('SELECT * FROM tournament_registrations WHERE id = ?').get(id));
}
function cancelRegistration(id) {
  getDb().prepare("UPDATE tournament_registrations SET status = 'cancelled' WHERE id = ?").run(id);
  return findRegistration(id);
}
function countRegistrations(tournamentId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM tournament_registrations WHERE tournament_id = ? AND status = 'registered'").get(tournamentId).n;
}

// --- Bracket ---
function publicBracketMatch(row) {
  if (!row) return null;
  const participant = (type, id) => {
    if (id == null) return null;
    if (type === 'player') return { type, ...displayUserById(id) };
    const team = findTeam(id);
    return team ? { type, ...team } : { type, id };
  };
  return {
    id: row.id, tournamentId: row.tournament_id, round: row.round, slot: row.slot,
    participantA: participant(row.participant_a_type, row.participant_a_id),
    participantB: participant(row.participant_b_type, row.participant_b_id),
    feederAMatchId: row.feeder_a_match_id ?? null, feederBMatchId: row.feeder_b_match_id ?? null,
    status: row.status,
    winner: row.winner_id != null ? participant(row.winner_type, row.winner_id) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function createBracketMatch(input) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO tournament_bracket_matches (tournament_id, round, slot, participant_a_type, participant_a_id, participant_b_type, participant_b_id, feeder_a_match_id, feeder_b_match_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.tournamentId, input.round, input.slot, input.participantAType ?? null, input.participantAId ?? null, input.participantBType ?? null, input.participantBId ?? null, input.feederAMatchId ?? null, input.feederBMatchId ?? null, input.status || 'pending', now, now);
  return publicBracketMatch(getDb().prepare('SELECT * FROM tournament_bracket_matches WHERE id = ?').get(result.lastInsertRowid));
}
function findBracketMatchRaw(id) {
  return getDb().prepare('SELECT * FROM tournament_bracket_matches WHERE id = ?').get(id) || null;
}
function findBracketMatch(id) {
  const row = findBracketMatchRaw(id);
  return row ? publicBracketMatch(row) : null;
}
function listBracketMatches(tournamentId) {
  const rows = getDb().prepare('SELECT * FROM tournament_bracket_matches WHERE tournament_id = ? ORDER BY round ASC, slot ASC').all(tournamentId);
  return rows.map(publicBracketMatch);
}
function updateBracketMatch(id, changes) {
  const cur = findBracketMatchRaw(id);
  if (!cur) return null;
  const next = { ...cur, ...changes, updated_at: new Date().toISOString() };
  getDb().prepare(
    'UPDATE tournament_bracket_matches SET participant_a_type = ?, participant_a_id = ?, participant_b_type = ?, participant_b_id = ?, status = ?, winner_type = ?, winner_id = ?, updated_at = ? WHERE id = ?',
  ).run(next.participant_a_type ?? null, next.participant_a_id ?? null, next.participant_b_type ?? null, next.participant_b_id ?? null, next.status, next.winner_type ?? null, next.winner_id ?? null, next.updated_at, id);
  return findBracketMatch(id);
}
function findNextBracketMatch(tournamentId, feederMatchId) {
  const row = getDb().prepare('SELECT * FROM tournament_bracket_matches WHERE tournament_id = ? AND (feeder_a_match_id = ? OR feeder_b_match_id = ?)').get(tournamentId, feederMatchId, feederMatchId);
  return row ? publicBracketMatch(row) : null;
}
function findNextBracketMatchRaw(tournamentId, feederMatchId) {
  return getDb().prepare('SELECT * FROM tournament_bracket_matches WHERE tournament_id = ? AND (feeder_a_match_id = ? OR feeder_b_match_id = ?)').get(tournamentId, feederMatchId, feederMatchId) || null;
}
function addChampionMembers(tournamentId, userIds) {
  for (const uid of userIds) {
    getDb().prepare('INSERT OR IGNORE INTO tournament_champion_members (tournament_id, user_id) VALUES (?, ?)').run(tournamentId, uid);
  }
}
function tournamentWinsForUser(userId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM tournament_champion_members WHERE user_id = ?').get(userId).n;
}
function tournamentWinsForTeam(teamId) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM tournaments WHERE status = 'completed' AND champion_type = 'team' AND champion_id = ?").get(teamId).n;
}
function championsInPeriod(periodStart) {
  const rows = periodStart
    ? getDb().prepare("SELECT * FROM tournaments WHERE status = 'completed' AND completed_at >= ? ORDER BY completed_at DESC, id DESC").all(periodStart)
    : getDb().prepare("SELECT * FROM tournaments WHERE status = 'completed' ORDER BY completed_at DESC, id DESC").all();
  return rows.map((r) => {
    const t = publicTournament(r);
    const champion = r.champion_type === 'player' ? { type: 'player', ...displayUserById(r.champion_id) } : { type: 'team', ...(findTeam(r.champion_id) || { id: r.champion_id }) };
    return { ...t, champion };
  });
}

// --- Stats / leaderboards (computed from match_history, never edited) ---
function listHistoryRows(userId, periodStart) {
  if (periodStart) return getDb().prepare('SELECT * FROM match_history WHERE user_id = ? AND created_at >= ? ORDER BY id ASC').all(userId, periodStart);
  return getDb().prepare('SELECT * FROM match_history WHERE user_id = ? ORDER BY id ASC').all(userId);
}
function listHistoryRowsInPeriod(periodStart) {
  if (periodStart) return getDb().prepare('SELECT * FROM match_history WHERE created_at >= ? ORDER BY user_id ASC, id ASC').all(periodStart);
  return getDb().prepare('SELECT * FROM match_history ORDER BY user_id ASC, id ASC').all();
}
function bracketWinsByTeam(periodStart) {
  const rows = periodStart
    ? getDb().prepare("SELECT winner_id, COUNT(*) AS n FROM tournament_bracket_matches WHERE winner_type = 'team' AND status = 'completed' AND updated_at >= ? GROUP BY winner_id").all(periodStart)
    : getDb().prepare("SELECT winner_id, COUNT(*) AS n FROM tournament_bracket_matches WHERE winner_type = 'team' AND status = 'completed' GROUP BY winner_id").all();
  return new Map(rows.map((r) => [r.winner_id, r.n]));
}

module.exports.tournaments = {
  publicTournament, findTournamentRaw, findTournament, createTournament, updateTournament, setTournamentStatus, listTournaments,
  createRegistration, publicRegistration, listRegistrations, findRegistration, cancelRegistration, countRegistrations,
  publicBracketMatch, createBracketMatch, findBracketMatchRaw, findBracketMatch, listBracketMatches, updateBracketMatch, findNextBracketMatch, findNextBracketMatchRaw,
  addChampionMembers, tournamentWinsForUser, tournamentWinsForTeam, championsInPeriod,
  listHistoryRows, listHistoryRowsInPeriod, bracketWinsByTeam,
};
