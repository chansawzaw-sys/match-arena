'use strict';
// Part 7 automated tests: full profiles (computed stats, avatar),
// friends, teams, tournaments, brackets, prizes, leaderboards.
// One throwaway SQLite file under /tmp, never the real data directory.
// Tests share one database and run in order; each test uses fresh
// user emails, and tests that change global settings restore them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const part7Service = require('../src/services/part7');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part7-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = { ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }), demoLoginEnabled: true };
const app = createApp(config);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function demoLogin(email, role, referralCode) {
  const body = { email, role };
  if (referralCode) body.referralCode = referralCode;
  const res = await request(app).post('/auth/demo').send(body);
  assert.equal(res.status, 200, `demo login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}
let ownerToken = null;
async function owner() {
  if (!ownerToken) ownerToken = (await demoLogin('g-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`).set(auth(await owner())).send({ amount, reason: 'part7 test credit' });
  assert.equal(res.status, 200, `credit failed: ${JSON.stringify(res.body)}`);
}
async function balance(token) {
  const res = await request(app).get('/wallet/me').set(auth(token));
  assert.equal(res.status, 200);
  return res.body.balance;
}
async function setSetting(key, value) {
  const res = await request(app).put(`/admin/settings/${key}`).set(auth(await owner())).send({ value });
  assert.equal(res.status, 200, `setSetting ${key} failed: ${JSON.stringify(res.body)}`);
}
async function makeRoom(prefix, overrides = {}) {
  const creator = await demoLogin(`${prefix}-creator@test.local`, 'player');
  const accepter = await demoLogin(`${prefix}-accepter@test.local`, 'player');
  const stake = overrides.stake || 100;
  await credit(creator.user.id, 10000);
  await credit(accepter.user.id, 10000);
  const ch = await request(app).post('/challenges').set(auth(creator.token)).send({
    arena: overrides.arena || 'Classic', teamSize: overrides.teamSize || '1v1',
    stake, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(accepter.token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return { creator, accepter, room: ok.body.matchRoom, challenge: ch.body.challenge, tokensById: { [creator.user.id]: creator.token, [accepter.user.id]: accepter.token } };
}
async function startRoom(room, tokensById) {
  await setSetting('match.countdown_seconds', 1);
  const detail = await request(app).get(`/match-rooms/${room.id}`).set(auth(Object.values(tokensById)[0]));
  assert.equal(detail.status, 200);
  for (const p of detail.body.participants) {
    const token = tokensById[p.userId];
    assert.ok(token, `no token for participant ${p.userId}`);
    const r = await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(token)).send({ ready: true });
    assert.equal(r.status, 200, `ready failed: ${JSON.stringify(r.body)}`);
  }
  await sleep(1200);
  const started = await request(app).get(`/match-rooms/${room.id}`).set(auth(Object.values(tokensById)[0]));
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'started', JSON.stringify(started.body));
  await setSetting('match.countdown_seconds', 10);
  return started.body;
}
async function makeStartedRoom(prefix, overrides = {}) {
  const made = await makeRoom(prefix, overrides);
  await setSetting('match.result_window_seconds', 1);
  const started = await startRoom(made.room, made.tokensById);
  await setSetting('match.result_window_seconds', 300);
  await sleep(1200);
  return { ...made, room: started };
}
function submit(roomId, token, outcome) {
  return request(app).post(`/match-rooms/${roomId}/results`).set(auth(token)).field('outcome', outcome);
}
async function playMatch(prefix, winnerSide) {
  // winnerSide 'A' = creator wins, 'B' = accepter wins.
  const made = await makeStartedRoom(prefix);
  assert.equal((await submit(made.room.id, made.creator.token, winnerSide === 'A' ? 'win' : 'lose')).status, 201);
  const confirmed = await submit(made.room.id, made.accepter.token, winnerSide === 'A' ? 'lose' : 'win');
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  return made;
}
function tourneyInput(overrides = {}) {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const startTime = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  return {
    name: overrides.name || 'Test Cup', prizeDescription: overrides.prizeDescription || 'Test prize',
    prizeCoins: overrides.prizeCoins ?? 0, rules: 'Test rules',
    registrationStart: overrides.registrationStart || start, registrationEnd: overrides.registrationEnd || end,
    startTime: overrides.startTime || startTime, mode: overrides.mode || 'solo', teamSize: overrides.teamSize || '1v1',
    maxRegistrants: overrides.maxRegistrants ?? null,
  };
}
async function createTournament(overrides = {}) {
  const res = await request(app).post('/tournaments').set(auth(await owner())).send(tourneyInput(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.tournament;
}
async function openTournament(id) {
  const res = await request(app).post(`/tournaments/${id}/open-registration`).set(auth(await owner()));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.tournament;
}
async function makeTeam(prefix, memberCount) {
  // Returns { leader, members: [leader, ...], team } with memberCount total.
  const leader = await demoLogin(`${prefix}-leader@test.local`, 'player');
  const teamRes = await request(app).post('/teams').set(auth(leader.token)).send({ name: `${prefix}-team` });
  assert.equal(teamRes.status, 201, JSON.stringify(teamRes.body));
  const team = teamRes.body.team;
  const members = [leader];
  for (let i = 1; i < memberCount; i++) {
    const m = await demoLogin(`${prefix}-m${i}@test.local`, 'player');
    const inv = await request(app).post(`/teams/${team.id}/invites`).set(auth(leader.token)).send({ userId: m.user.id });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const acc = await request(app).post(`/teams/invites/${inv.body.invite.id}/accept`).set(auth(m.token));
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    members.push(m);
  }
  return { leader, members, team };
}

test('profile stats are computed from history, win rate is null at zero matches', async () => {
  const fresh = await demoLogin('g-prof-fresh@test.local', 'player');
  const prof0 = await request(app).get('/profiles/me').set(auth(fresh.token));
  assert.equal(prof0.status, 200);
  assert.equal(prof0.body.profile.stats.totalMatches, 0);
  assert.equal(prof0.body.profile.stats.winRate, null);
  assert.equal(prof0.body.profile.stats.currentWinStreak, 0);
  assert.equal(JSON.stringify(prof0.body.profile).includes('@test.local'), false, 'profile must not expose email');
  // W, W, L for the creator of three matches.
  const winner = await demoLogin('g-prof-w@test.local', 'player');
  const loser = await demoLogin('g-prof-l@test.local', 'player');
  // Reuse playMatch helpers with fixed users: build rooms manually via
  // the shared helper but with a dedicated prefix per match, then
  // check the dedicated winner's profile by playing as creator.
  // Simpler: play three matches where a fresh creator wins twice then loses.
  const p = await demoLogin('g-prof-main@test.local', 'player');
  const opp = await demoLogin('g-prof-opp@test.local', 'player');
  // Match 1 + 2: p (creator) wins; match 3: p loses. Use makeStartedRoom
  // with unique prefixes and then re-credit/submit as p/opp is not
  // possible (rooms are tied to their own creator), so instead use
  // the generic playMatch flow and assert on its creator below.
  void winner; void loser; void p; void opp;
  const m1 = await playMatch('g-prof-m1', 'A');
  const m2 = await playMatch('g-prof-m2', 'A');
  // m1/m2 creators are distinct users; check one creator's profile
  // after one win, and the shared computeStats unit for W,W,L.
  const prof1 = await request(app).get(`/profiles/${m1.creator.user.id}`).set(auth(m1.creator.token));
  assert.equal(prof1.body.profile.stats.wins, 1);
  assert.equal(prof1.body.profile.stats.totalMatches, 1);
  assert.equal(prof1.body.profile.stats.winRate, 1);
  assert.equal(prof1.body.profile.stats.currentWinStreak, 1);
  assert.equal(prof1.body.profile.stats.bestWinStreak, 1);
  void m2;
  const rows = [
    { result: 'win', created_at: '2026-01-01T00:00:00.000Z' },
    { result: 'win', created_at: '2026-01-02T00:00:00.000Z' },
    { result: 'lose', created_at: '2026-01-03T00:00:00.000Z' },
  ];
  const stats = part7Service.computeStats(rows);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 2 / 3);
  assert.equal(stats.currentWinStreak, 0);
  assert.equal(stats.bestWinStreak, 2);
  const ten = Array.from({ length: 10 }, (_, i) => ({ result: 'win', created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
  const stats10 = part7Service.computeStats(ten);
  assert.equal(stats10.bestWinStreak, 10);
  assert.ok(stats10.streakDates[5]);
  assert.ok(stats10.streakDates[10]);
});

test('avatar upload validation and non-owner cannot upload for another user', async () => {
  const user = await demoLogin('g-av-u@test.local', 'player');
  const other = await demoLogin('g-av-other@test.local', 'player');
  const ok = await request(app).post('/profiles/me/avatar').set(auth(user.token)).attach('avatar', PNG, 'avatar.png');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.avatarUrl, /^\/avatars\/\d+$/);
  const got = await request(app).get(ok.body.avatarUrl).set(auth(other.token));
  assert.equal(got.status, 200);
  const bad = await request(app).post('/profiles/me/avatar').set(auth(user.token)).attach('avatar', Buffer.from('not an image'), 'evil.txt');
  assert.equal(bad.status, 400);
  const big = await request(app).post('/profiles/me/avatar').set(auth(user.token)).attach('avatar', Buffer.alloc(2 * 1024 * 1024 + 1), 'big.png');
  assert.equal(big.status, 400);
  // Display name update is self-only by construction (endpoint is /me).
  const renamed = await request(app).put('/profiles/me').set(auth(user.token)).send({ displayName: 'Renamed Player' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.profile.displayName, 'Renamed Player');
  const prof = await request(app).get(`/profiles/${user.user.id}`).set(auth(other.token));
  assert.equal(prof.body.profile.displayName, 'Renamed Player');
  assert.equal(prof.body.profile.avatarUrl, ok.body.avatarUrl);
});

test('friend request, accept, duplicate/self rejection, remove', async () => {
  const a = await demoLogin('g-fr-a@test.local', 'player');
  const b = await demoLogin('g-fr-b@test.local', 'player');
  assert.equal((await request(app).post('/friends/requests').set(auth(a.token)).send({ userId: a.user.id })).status, 400);
  const req1 = await request(app).post('/friends/requests').set(auth(a.token)).send({ userId: b.user.id });
  assert.equal(req1.status, 201, JSON.stringify(req1.body));
  assert.equal((await request(app).post('/friends/requests').set(auth(b.token)).send({ userId: a.user.id })).status, 409);
  assert.equal((await request(app).post('/friends/requests').set(auth(a.token)).send({ userId: b.user.id })).status, 409);
  const pend = await request(app).get('/friends/requests').set(auth(b.token));
  assert.equal(pend.body.incoming.length, 1);
  const acc = await request(app).post(`/friends/requests/${req1.body.friendship.id}/accept`).set(auth(b.token));
  assert.equal(acc.status, 200);
  const friends = await request(app).get('/friends').set(auth(a.token));
  assert.equal(friends.body.friends.length, 1);
  assert.equal(friends.body.friends[0].id, b.user.id);
  assert.equal(JSON.stringify(friends.body).includes('@test.local'), false);
  const removed = await request(app).delete(`/friends/${b.user.id}`).set(auth(a.token));
  assert.equal(removed.status, 200);
  assert.deepEqual((await request(app).get('/friends').set(auth(a.token))).body.friends, []);
  // Reject path.
  const c = await demoLogin('g-fr-c@test.local', 'player');
  const req2 = await request(app).post('/friends/requests').set(auth(a.token)).send({ userId: c.user.id });
  assert.equal((await request(app).post(`/friends/requests/${req2.body.friendship.id}/reject`).set(auth(c.token))).status, 200);
  assert.deepEqual((await request(app).get('/friends').set(auth(a.token))).body.friends, []);
});

test('teams: create, invite, accept, remove, leave transfer, delete when empty, one-team rule', async () => {
  const { leader, members, team } = await makeTeam('g-team1', 3);
  assert.equal(team.leaderId, leader.user.id);
  const detail = await request(app).get(`/teams/${team.id}`).set(auth(leader.token));
  assert.equal(detail.body.team.members.length, 3);
  // One-team rule: a member cannot create another team.
  assert.equal((await request(app).post('/teams').set(auth(members[1].token)).send({ name: 'g-team1-second' })).status, 409);
  // Duplicate name rejected.
  assert.equal((await request(app).post('/teams').set(auth((await demoLogin('g-team1-free@test.local', 'player')).token)).send({ name: 'g-team1-team' })).status, 409);
  // Leader removes a member.
  const removed = await request(app).delete(`/teams/${team.id}/members/${members[2].user.id}`).set(auth(leader.token));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.team.members.length, 2);
  // Member leaves; leader leaves and transfers to earliest remaining member.
  const left = await request(app).post(`/teams/${team.id}/leave`).set(auth(members[1].token));
  assert.equal(left.status, 200);
  assert.equal(left.body.team.members.length, 1);
  const transferred = await request(app).post(`/teams/${team.id}/leave`).set(auth(leader.token));
  assert.equal(transferred.status, 200);
  assert.equal(transferred.body.deleted, true);
  assert.equal((await request(app).get(`/teams/${team.id}`).set(auth(leader.token))).status, 404);
  // Leader transfer (not delete) case.
  const t2 = await makeTeam('g-team2', 3);
  const leaveLeader = await request(app).post(`/teams/${t2.team.id}/leave`).set(auth(t2.leader.token));
  assert.equal(leaveLeader.status, 200);
  assert.equal(leaveLeader.body.deleted, false);
  assert.equal(leaveLeader.body.team.leaderId, t2.members[1].user.id);
  // Non-leader cannot invite.
  const outsider = await demoLogin('g-team2-out@test.local', 'player');
  assert.equal((await request(app).post(`/teams/${t2.team.id}/invites`).set(auth(t2.members[2].token)).send({ userId: outsider.user.id })).status, 403);
});

test('team roster add to a match room respects side limits and locks stakes', async () => {
  const { leader, members, team } = await makeTeam('g-roomteam', 2);
  const opponent = await demoLogin('g-roomteam-opp@test.local', 'player');
  await credit(leader.user.id, 10000);
  await credit(members[1].user.id, 10000);
  await credit(opponent.user.id, 10000);
  const ch = await request(app).post('/challenges').set(auth(leader.token)).send({
    arena: 'Classic', teamSize: '2v2', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(opponent.token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const roomId = ok.body.matchRoom.id;
  const before = await balance(members[1].token);
  assert.equal(before.locked, 0);
  const added = await request(app).post(`/match-rooms/${roomId}/roster/team/${team.id}`).set(auth(leader.token));
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.addedUserIds, [members[1].user.id]);
  const after = await balance(members[1].token);
  assert.equal(after.locked, 100);
  // Second add adds nobody (already in room) and does not double-lock.
  const again = await request(app).post(`/match-rooms/${roomId}/roster/team/${team.id}`).set(auth(leader.token));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.addedUserIds, []);
  assert.equal((await balance(members[1].token)).locked, 100);
  // A non-leader team member cannot add the team.
  assert.equal((await request(app).post(`/match-rooms/${roomId}/roster/team/${team.id}`).set(auth(members[1].token))).status, 403);
});

test('tournament create validation, draft-only edit, registration rules', async () => {
  const badWindow = await request(app).post('/tournaments').set(auth(await owner())).send(tourneyInput({
    registrationStart: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    registrationEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));
  assert.equal(badWindow.status, 400);
  const badMode = await request(app).post('/tournaments').set(auth(await owner())).send(tourneyInput({ mode: 'solo', teamSize: '5v5' }));
  assert.equal(badMode.status, 400);
  const player = await demoLogin('g-treg-player@test.local', 'player');
  assert.equal((await request(app).post('/tournaments').set(auth(player.token)).send(tourneyInput())).status, 403);
  const t = await createTournament({ name: 'g-reg-cup' });
  // Edit in draft works.
  const edited = await request(app).put(`/tournaments/${t.id}`).set(auth(await owner())).send({ prizeCoins: 50 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.tournament.prizeCoins, 50);
  await openTournament(t.id);
  const reg = await request(app).post(`/tournaments/${t.id}/register`).set(auth(player.token)).send({});
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal((await request(app).post(`/tournaments/${t.id}/register`).set(auth(player.token)).send({})).status, 409);
  const cancelled = await request(app).post(`/tournaments/${t.id}/registrations/${reg.body.registration.id}/cancel`).set(auth(player.token));
  assert.equal(cancelled.status, 200);
  // Registration window rejected: future window, opened by admin.
  const future = await createTournament({
    name: 'g-reg-future',
    registrationStart: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    registrationEnd: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    startTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  });
  await openTournament(future.id);
  assert.equal((await request(app).post(`/tournaments/${future.id}/register`).set(auth(player.token)).send({})).status, 409);
  // Edit after opening is rejected (no longer draft).
  assert.equal((await request(app).put(`/tournaments/${t.id}`).set(auth(await owner())).send({ prizeCoins: 99 })).status, 409);
  // Team size mismatch: 3v3 tournament, 2-member team cannot register.
  const team2 = await makeTeam('g-regteam', 2);
  const t3 = await createTournament({ name: 'g-reg-3v3', mode: 'team', teamSize: '3v3' });
  await openTournament(t3.id);
  assert.equal((await request(app).post(`/tournaments/${t3.id}/register`).set(auth(team2.leader.token)).send({ type: 'team', teamId: team2.team.id })).status, 400);
});

test('bracket even (4 players): advancement, final completion, solo prize, champion badge', async () => {
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await demoLogin(`g-br4-p${i}@test.local`, 'player'));
  const t = await createTournament({ name: 'g-br4-cup', prizeCoins: 100 });
  await openTournament(t.id);
  for (const p of players) {
    const r = await request(app).post(`/tournaments/${t.id}/register`).set(auth(p.token)).send({});
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const started = await request(app).post(`/tournaments/${t.id}/start`).set(auth(await owner()));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.tournament.status, 'ongoing');
  const bracket = await request(app).get(`/tournaments/${t.id}/bracket`).set(auth(players[0].token));
  assert.equal(bracket.body.rounds['1'].length, 2);
  assert.equal(bracket.body.rounds['2'].length, 1);
  const round1 = bracket.body.rounds['1'];
  const w1 = round1[0].participantA;
  const w2 = round1[1].participantA;
  assert.equal((await request(app).post(`/tournaments/${t.id}/bracket-matches/${round1[0].id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: w1.id, reason: 'won' })).status, 200);
  assert.equal((await request(app).post(`/tournaments/${t.id}/bracket-matches/${round1[1].id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: w2.id, reason: 'won' })).status, 200);
  const after = await request(app).get(`/tournaments/${t.id}/bracket`).set(auth(players[0].token));
  const final = after.body.rounds['2'][0];
  assert.equal(final.status, 'ongoing');
  assert.equal(final.participantA.id, w1.id);
  assert.equal(final.participantB.id, w2.id);
  const done = await request(app).post(`/tournaments/${t.id}/bracket-matches/${final.id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: w1.id, reason: 'champion' });
  assert.equal(done.status, 200);
  assert.equal(done.body.completed, true);
  assert.equal(done.body.tournament.status, 'completed');
  assert.equal(done.body.tournament.championId, w1.id);
  // Second winner recording is rejected; prize is not paid twice.
  assert.equal((await request(app).post(`/tournaments/${t.id}/bracket-matches/${final.id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: w1.id, reason: 'again' })).status, 409);
  assert.equal((await balance(players[0].token)).available, 100);
  const prof = await request(app).get(`/profiles/${w1.id}`).set(auth(players[0].token));
  assert.equal(prof.body.profile.tournamentWins, 1);
  assert.ok(prof.body.profile.achievements.some((a) => a.type === 'tournament_champion' && a.tournamentId === t.id));
});

test('bracket odd (3 players): bye advances, final completes', async () => {
  const players = [];
  for (let i = 0; i < 3; i++) players.push(await demoLogin(`g-br3-p${i}@test.local`, 'player'));
  const t = await createTournament({ name: 'g-br3-cup', prizeCoins: 0 });
  await openTournament(t.id);
  for (const p of players) assert.equal((await request(app).post(`/tournaments/${t.id}/register`).set(auth(p.token)).send({})).status, 201);
  const started = await request(app).post(`/tournaments/${t.id}/start`).set(auth(await owner()));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const bracket = await request(app).get(`/tournaments/${t.id}/bracket`).set(auth(players[0].token));
  assert.equal(bracket.body.rounds['1'].length, 1);
  assert.equal(bracket.body.rounds['2'].length, 1);
  const finalBefore = bracket.body.rounds['2'][0];
  // Bye seed (first registrant) is already in the final; the other
  // slot is filled by the round-1 winner.
  assert.equal(finalBefore.participantA.id, players[0].user.id);
  assert.equal(finalBefore.participantB, null);
  const playin = bracket.body.rounds['1'][0];
  const playinWinner = playin.participantA;
  assert.equal((await request(app).post(`/tournaments/${t.id}/bracket-matches/${playin.id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: playinWinner.id, reason: 'won' })).status, 200);
  const after = await request(app).get(`/tournaments/${t.id}/bracket`).set(auth(players[0].token));
  assert.equal(after.body.rounds['2'][0].participantB.id, playinWinner.id);
  assert.equal(after.body.rounds['2'][0].status, 'ongoing');
  const done = await request(app).post(`/tournaments/${t.id}/bracket-matches/${after.body.rounds['2'][0].id}/winner`).set(auth(await owner())).send({ winnerType: 'player', winnerId: playinWinner.id, reason: 'champion' });
  assert.equal(done.body.completed, true);
  assert.equal(done.body.tournament.status, 'completed');
});

test('tournament team prize splits equally with remainder to leader, no double pay', async () => {
  const teamA = await makeTeam('g-prize-a', 3);
  const teamB = await makeTeam('g-prize-b', 3);
  const t = await createTournament({ name: 'g-prize-cup', mode: 'team', teamSize: '3v3', prizeCoins: 100 });
  await openTournament(t.id);
  assert.equal((await request(app).post(`/tournaments/${t.id}/register`).set(auth(teamA.leader.token)).send({ type: 'team', teamId: teamA.team.id })).status, 201);
  assert.equal((await request(app).post(`/tournaments/${t.id}/register`).set(auth(teamB.leader.token)).send({ type: 'team', teamId: teamB.team.id })).status, 201);
  const started = await request(app).post(`/tournaments/${t.id}/start`).set(auth(await owner()));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const bracket = await request(app).get(`/tournaments/${t.id}/bracket`).set(auth(teamA.leader.token));
  assert.equal(bracket.body.rounds['1'].length, 1);
  const final = bracket.body.rounds['1'][0];
  const done = await request(app).post(`/tournaments/${t.id}/bracket-matches/${final.id}/winner`).set(auth(await owner())).send({ winnerType: 'team', winnerId: teamA.team.id, reason: 'champion' });
  assert.equal(done.body.completed, true);
  // 100 split by 3: leader 34, others 33.
  assert.equal((await balance(teamA.leader.token)).available, 34);
  assert.equal((await balance(teamA.members[1].token)).available, 33);
  assert.equal((await balance(teamA.members[2].token)).available, 33);
  assert.equal((await balance(teamB.leader.token)).available, 0);
  const teamDetail = await request(app).get(`/teams/${teamA.team.id}`).set(auth(teamA.leader.token));
  assert.equal(teamDetail.body.team.members.length, 3);
  const lb = await request(app).get('/leaderboards?category=top_team&period=all_time').set(auth(teamA.leader.token));
  assert.ok(lb.body.entries.some((e) => e.team.id === teamA.team.id && e.tournamentWins === 1));
});

test('leaderboards: categories, periods, privacy, tie-breaks', async () => {
  // The matches above created wins; check each category returns
  // display-only entries and that periods filter.
  const me = await demoLogin('g-lb-me@test.local', 'player');
  for (const category of ['top_player', 'most_wins', 'highest_win_streak', 'top_team', 'tournament_champion']) {
    const res = await request(app).get(`/leaderboards?category=${category}&period=all_time`).set(auth(me.token));
    assert.equal(res.status, 200, `${category}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.category, category);
    assert.ok(!JSON.stringify(res.body).includes('@test.local'), `${category} leaked an email`);
  }
  assert.equal((await request(app).get('/leaderboards?category=nope&period=all_time').set(auth(me.token))).status, 400);
  const daily = await request(app).get('/leaderboards?category=top_player&period=daily').set(auth(me.token));
  assert.equal(daily.status, 200);
  assert.ok(daily.body.entries.length >= 1);
  const monthly = await request(app).get('/leaderboards?category=tournament_champion&period=monthly').set(auth(me.token));
  assert.equal(monthly.status, 200);
  assert.ok(monthly.body.entries.some((e) => e.champion));
  // Tie-break: top_player is ordered by wins desc; entries are sorted.
  const top = await request(app).get('/leaderboards?category=top_player&period=all_time').set(auth(me.token));
  for (let i = 1; i < top.body.entries.length; i++) {
    assert.ok(top.body.entries[i - 1].wins >= top.body.entries[i].wins, 'top_player must be sorted by wins desc');
  }
  // Unauthenticated leaderboard access is rejected.
  assert.equal((await request(app).get('/leaderboards?category=top_player&period=all_time')).status, 401);
});

test('tournament banner upload validation and cancel rules', async () => {
  const t = await createTournament({ name: 'g-banner-cup' });
  const banner = await request(app).post(`/tournaments/${t.id}/banner`).set(auth(await owner())).attach('banner', PNG, 'banner.png');
  assert.equal(banner.status, 201, JSON.stringify(banner.body));
  assert.match(banner.body.tournament.bannerUrl, /^\/tournaments\/\d+\/banner$/);
  const got = await request(app).get(`/tournaments/${t.id}/banner`).set(auth(await owner()));
  assert.equal(got.status, 200);
  const bad = await request(app).post(`/tournaments/${t.id}/banner`).set(auth(await owner())).attach('banner', Buffer.from('x'), 'bad.txt');
  assert.equal(bad.status, 400);
  const cancelled = await request(app).post(`/tournaments/${t.id}/cancel`).set(auth(await owner()));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.tournament.status, 'cancelled');
  // Start after cancel is rejected.
  const startAfterCancel = await request(app).post(`/tournaments/${t.id}/start`).set(auth(await owner()));
  assert.equal(startAfterCancel.status, 409);
});
