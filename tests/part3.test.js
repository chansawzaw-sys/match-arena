'use strict';
// Part 3 automated tests: challenge board, rank restrictions, admin hero
// restrictions, favorites, board filters, detail view, atomic accept with
// coin locks, double-accept protection, self/insufficient accept
// rejection, and cancel rules. One throwaway SQLite file under /tmp,
// never the real data directory. Tests share one database and run in
// order, so each test uses fresh user emails and distinctive stakes
// where a later filter must isolate its own challenges.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part3-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = {
  ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }),
  demoLoginEnabled: true,
};
const app = createApp(config);

async function demoLogin(email, role) {
  const res = await request(app).post('/auth/demo').send({ email, role });
  assert.equal(res.status, 200, `demo login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
let ownerToken = null;
async function owner() {
  if (!ownerToken) ownerToken = (await demoLogin('c-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`)
    .set(auth(await owner())).send({ amount, reason: 'part3 test credit' });
  assert.equal(res.status, 200, `credit failed: ${JSON.stringify(res.body)}`);
  return res.body.balance;
}
async function setRank(token, rankTier) {
  const res = await request(app).put('/profile/rank').set(auth(token)).send({ rankTier });
  assert.equal(res.status, 200, `setRank failed: ${JSON.stringify(res.body)}`);
  return res.body.user;
}
function baseChallenge(overrides = {}) {
  return {
    arena: 'Classic', teamSize: '5v5', stake: 100, heroRule: 'any',
    heroBans: [], customRules: '', rankRestriction: { type: 'none' },
    ...overrides,
  };
}
async function createChallenge(token, overrides = {}) {
  const res = await request(app).post('/challenges').set(auth(token)).send(baseChallenge(overrides));
  assert.equal(res.status, 201, `createChallenge failed: ${JSON.stringify(res.body)}`);
  return res.body.challenge;
}
async function balance(token) {
  const res = await request(app).get('/wallet/me').set(auth(token));
  assert.equal(res.status, 200);
  return res.body.balance;
}

test('creation validation: 1v1 arena with 5v5, invalid hero rule, invalid stake, duplicate bans', async () => {
  const player = await demoLogin('c-p-valid@test.local', 'player');
  const h = auth(player.token);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ arena: '1v1', teamSize: '5v5' }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ heroRule: 'wizard_only' }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ stake: 0 }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ stake: -10 }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ heroBans: [''] }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(h).send(baseChallenge({ heroBans: ['Ling', 'ling'] }))).status, 400);
  // A valid 1v1/1v1 challenge and a valid Classic/5v5 challenge both succeed.
  const one = await createChallenge(player.token, { arena: '1v1', teamSize: '1v1', stake: 10 });
  assert.equal(one.arena, '1v1');
  assert.equal(one.teamSize, '1v1');
  assert.equal(one.status, 'open');
  const classic = await createChallenge(player.token, { arena: 'Classic', teamSize: '5v5', stake: 10 });
  assert.equal(classic.status, 'open');
});

test('rank-restricted creation requires a creator rank, and accept enforces same-rank and range', async () => {
  const creator = await demoLogin('c-p-rank-creator@test.local', 'player');
  // Creator with no rank cannot create a rank-restricted challenge.
  assert.equal((await request(app).post('/challenges').set(auth(creator.token))
    .send(baseChallenge({ rankRestriction: { type: 'same_rank_only' } }))).status, 400);
  await setRank(creator.token, 'Epic');

  // Same-rank: Epic accepter passes, Legend accepter fails, unset accepter fails.
  const same1 = await createChallenge(creator.token, { rankRestriction: { type: 'same_rank_only' }, stake: 50 });
  const epic = await demoLogin('c-p-rank-epic@test.local', 'player');
  await setRank(epic.token, 'Epic');
  await credit(creator.user.id, 500);
  await credit(epic.user.id, 500);
  const ok = await request(app).post(`/challenges/${same1.id}/accept`).set(auth(epic.token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.challenge.status, 'matched');

  const same2 = await createChallenge(creator.token, { rankRestriction: { type: 'same_rank_only' }, stake: 50 });
  const legend = await demoLogin('c-p-rank-legend@test.local', 'player');
  await setRank(legend.token, 'Legend');
  await credit(legend.user.id, 500);
  assert.equal((await request(app).post(`/challenges/${same2.id}/accept`).set(auth(legend.token))).status, 400);
  const unset = await demoLogin('c-p-rank-unset@test.local', 'player');
  await credit(unset.user.id, 500);
  assert.equal((await request(app).post(`/challenges/${same2.id}/accept`).set(auth(unset.token))).status, 400);
  // Failed accepts locked nothing for the Legend player.
  assert.deepEqual([ (await balance(legend.token)).locked, (await balance(unset.token)).locked ], [0, 0]);

  // Range Epic-Legend: Legend passes, Mythic fails, unset fails.
  const range1 = await createChallenge(creator.token, {
    rankRestriction: { type: 'range', minTier: 'Epic', maxTier: 'Legend' }, stake: 50,
  });
  const rangeOk = await request(app).post(`/challenges/${range1.id}/accept`).set(auth(legend.token));
  assert.equal(rangeOk.status, 200);
  const range2 = await createChallenge(creator.token, {
    rankRestriction: { type: 'range', minTier: 'Epic', maxTier: 'Legend' }, stake: 50,
  });
  const mythic = await demoLogin('c-p-rank-mythic@test.local', 'player');
  await setRank(mythic.token, 'Mythic');
  await credit(mythic.user.id, 500);
  assert.equal((await request(app).post(`/challenges/${range2.id}/accept`).set(auth(mythic.token))).status, 400);
  assert.equal((await request(app).post(`/challenges/${range2.id}/accept`).set(auth(unset.token))).status, 400);
  // An inverted range is rejected at creation.
  assert.equal((await request(app).post('/challenges').set(auth(creator.token))
    .send(baseChallenge({ rankRestriction: { type: 'range', minTier: 'Legend', maxTier: 'Epic' } }))).status, 400);
});

test('admin hero restrictions: conflict rejection, player cannot manage, deactivation lifts the ban', async () => {
  const ownerToken = await owner();
  const player = await demoLogin('c-p-hero@test.local', 'player');
  assert.equal((await request(app).post('/challenges/hero-restrictions').set(auth(player.token))
    .send({ heroName: 'Nope', restriction: 'banned', reason: 'player test' })).status, 403);
  const allowed = await request(app).post('/challenges/hero-restrictions').set(auth(ownerToken))
    .send({ heroName: 'Ling', restriction: 'allowed', reason: 'signature hero allowed' });
  assert.equal(allowed.status, 201);
  const banned = await request(app).post('/challenges/hero-restrictions').set(auth(ownerToken))
    .send({ heroName: 'Gusion', restriction: 'banned', reason: 'banned this season' });
  assert.equal(banned.status, 201);
  // A second active rule for the same hero is a conflict.
  assert.equal((await request(app).post('/challenges/hero-restrictions').set(auth(ownerToken))
    .send({ heroName: 'ling', restriction: 'banned', reason: 'duplicate' })).status, 409);
  // Banning a globally allowed hero is rejected; requiring a globally banned hero is rejected.
  assert.equal((await request(app).post('/challenges').set(auth(player.token))
    .send(baseChallenge({ heroBans: ['Ling'] }))).status, 400);
  assert.equal((await request(app).post('/challenges').set(auth(player.token))
    .send(baseChallenge({ requiredHero: 'Gusion' }))).status, 400);
  // Banning a globally banned hero is consistent, not a conflict.
  const ok = await createChallenge(player.token, { heroBans: ['Gusion'], stake: 10 });
  assert.equal(ok.heroBans[0], 'Gusion');
  // Deactivating the ban lifts it: requiring Gusion then succeeds.
  const deactivated = await request(app).put(`/challenges/hero-restrictions/${banned.body.restriction.id}`)
    .set(auth(ownerToken)).send({ active: false });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.restriction.active, false);
  const after = await createChallenge(player.token, { requiredHero: 'Gusion', stake: 10 });
  assert.equal(after.requiredHero, 'Gusion');
});

test('favorites: save, list privately, use with overrides, delete', async () => {
  const player = await demoLogin('c-p-fav@test.local', 'player');
  const other = await demoLogin('c-p-fav-other@test.local', 'player');
  const created = await request(app).post('/challenges/favorites').set(auth(player.token)).send({
    name: 'My classic', arena: 'Classic', teamSize: '5v5', heroRule: 'fighter_only',
    heroBans: ['Alpha'], customRules: 'No trash talk', rankRestriction: { type: 'none' },
  });
  assert.equal(created.status, 201);
  const fav = created.body.favorite;
  assert.equal(fav.name, 'My classic');
  const mine = await request(app).get('/challenges/favorites').set(auth(player.token));
  assert.ok(mine.body.favorites.some((f) => f.id === fav.id));
  const theirs = await request(app).get('/challenges/favorites').set(auth(other.token));
  assert.ok(!theirs.body.favorites.some((f) => f.id === fav.id));
  assert.equal((await request(app).delete(`/challenges/favorites/${fav.id}`).set(auth(other.token))).status, 404);
  // Use the favorite, overriding team size only.
  const used = await request(app).post('/challenges/from-favorite').set(auth(player.token))
    .send({ favoriteId: fav.id, stake: 120, overrides: { teamSize: '3v3' } });
  assert.equal(used.status, 201, JSON.stringify(used.body));
  assert.equal(used.body.challenge.teamSize, '3v3');
  assert.equal(used.body.challenge.heroRule, 'fighter_only');
  assert.equal(used.body.challenge.stake, 120);
  assert.deepEqual(used.body.challenge.heroBans, ['Alpha']);
  // Using another player's favorite is forbidden, and deleting your own works.
  assert.equal((await request(app).post('/challenges/from-favorite').set(auth(other.token))
    .send({ favoriteId: fav.id, stake: 10 })).status, 403);
  assert.equal((await request(app).delete(`/challenges/favorites/${fav.id}`).set(auth(player.token))).status, 200);
  assert.equal((await request(app).delete(`/challenges/favorites/${fav.id}`).set(auth(player.token))).status, 404);
});

test('board filters and detail view show full rules', async () => {
  const player = await demoLogin('c-p-board@test.local', 'player');
  const a = await createChallenge(player.token, { arena: 'Classic', teamSize: '5v5', heroRule: 'any', stake: 777, customRules: 'Board A' });
  const b = await createChallenge(player.token, { arena: 'Brawl', teamSize: '2v2', heroRule: 'fighter_only', stake: 888, customRules: 'Board B' });
  const c = await createChallenge(player.token, { arena: '1v1', teamSize: '1v1', heroRule: 'mage_only', stake: 999, customRules: 'Board C' });
  const byArena = await request(app).get('/challenges?arena=Brawl&coinMin=880&coinMax=890').set(auth(player.token));
  assert.ok(byArena.body.challenges.some((ch) => ch.id === b.id));
  assert.ok(!byArena.body.challenges.some((ch) => ch.id === a.id || ch.id === c.id));
  const byCoin = await request(app).get('/challenges?coinMin=770&coinMax=780').set(auth(player.token));
  assert.ok(byCoin.body.challenges.some((ch) => ch.id === a.id));
  assert.ok(!byCoin.body.challenges.some((ch) => ch.id === b.id));
  const byHero = await request(app).get('/challenges?heroRule=mage_only&coin=999').set(auth(player.token));
  assert.ok(byHero.body.challenges.some((ch) => ch.id === c.id));
  const byTeam = await request(app).get('/challenges?teamSize=2v2&coin=888').set(auth(player.token));
  assert.ok(byTeam.body.challenges.some((ch) => ch.id === b.id));
  const detail = await request(app).get(`/challenges/${a.id}`).set(auth(player.token));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.challenge.customRules, 'Board A');
  assert.equal(detail.body.challenge.stake, 777);
  assert.equal(detail.body.challenge.heroRule, 'any');
  assert.equal(detail.body.challenge.creatorId, player.user.id);
  assert.equal(detail.body.challenge.participants.length, 1);
  assert.equal(detail.body.challenge.participants[0].role, 'creator');
  assert.equal((await request(app).get('/challenges/999999').set(auth(player.token))).status, 404);
  // Since filter: a future timestamp returns nothing; the epoch returns challenges.
  const future = await request(app).get('/challenges?since=2100-01-01T00:00:00.000Z').set(auth(player.token));
  assert.equal(future.body.total, 0);
  const epoch = await request(app).get('/challenges?since=1970-01-01T00:00:00.000Z').set(auth(player.token));
  assert.ok(epoch.body.total > 0);
  const sinceA = await request(app).get(`/challenges?since=${encodeURIComponent(a.updatedAt)}`).set(auth(player.token));
  assert.ok(sinceA.body.challenges.some((ch) => ch.id === a.id));
});

test('accept locks both stakes and creates a match room; double accept fails with no double lock', async () => {
  const creator = await demoLogin('c-p-acc-creator@test.local', 'player');
  const accepter = await demoLogin('c-p-acc-1@test.local', 'player');
  const second = await demoLogin('c-p-acc-2@test.local', 'player');
  await credit(creator.user.id, 1000);
  await credit(accepter.user.id, 1000);
  await credit(second.user.id, 1000);
  const challenge = await createChallenge(creator.token, { stake: 250 });
  const first = await request(app).post(`/challenges/${challenge.id}/accept`).set(auth(accepter.token));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.challenge.status, 'matched');
  assert.ok(first.body.matchRoom);
  assert.equal(first.body.matchRoom.challengeId, challenge.id);
  assert.equal(first.body.matchRoom.creatorId, creator.user.id);
  assert.equal(first.body.matchRoom.accepterId, accepter.user.id);
  assert.equal(first.body.matchRoom.stake, 250);
  // Part 4 supersedes Part 3's 'created' status: a room is now born waiting_ready.
  assert.equal(first.body.matchRoom.status, 'waiting_ready');
  assert.deepEqual([(await balance(creator.token)).available, (await balance(creator.token)).locked], [750, 250]);
  assert.deepEqual([(await balance(accepter.token)).available, (await balance(accepter.token)).locked], [750, 250]);
  // Second accept fails and locks nothing for the second player.
  assert.equal((await request(app).post(`/challenges/${challenge.id}/accept`).set(auth(second.token))).status, 409);
  assert.deepEqual([(await balance(second.token)).available, (await balance(second.token)).locked], [1000, 0]);
  assert.deepEqual([(await balance(creator.token)).available, (await balance(creator.token)).locked], [750, 250]);
  // Detail now shows the match room and both participants.
  const detail = await request(app).get(`/challenges/${challenge.id}`).set(auth(creator.token));
  assert.ok(detail.body.matchRoom);
  assert.equal(detail.body.challenge.participants.length, 2);
});

test('self-accept and insufficient-balance accept fail with no lock', async () => {
  const creator = await demoLogin('c-p-acc-self@test.local', 'player');
  await credit(creator.user.id, 1000);
  const own = await createChallenge(creator.token, { stake: 100 });
  assert.equal((await request(app).post(`/challenges/${own.id}/accept`).set(auth(creator.token))).status, 400);
  assert.deepEqual([(await balance(creator.token)).available, (await balance(creator.token)).locked], [1000, 0]);
  const poor = await demoLogin('c-p-acc-poor@test.local', 'player');
  assert.equal((await request(app).post(`/challenges/${own.id}/accept`).set(auth(poor.token))).status, 400);
  assert.deepEqual([(await balance(creator.token)).available, (await balance(creator.token)).locked], [1000, 0]);
  assert.deepEqual([(await balance(poor.token)).available, (await balance(poor.token)).locked], [0, 0]);
  // The challenge is still open after failed accepts.
  const detail = await request(app).get(`/challenges/${own.id}`).set(auth(creator.token));
  assert.equal(detail.body.challenge.status, 'open');
});

test('cancel open succeeds, cancel matched is rejected, non-creator cancel is forbidden', async () => {
  const creator = await demoLogin('c-p-cancel-creator@test.local', 'player');
  const other = await demoLogin('c-p-cancel-other@test.local', 'player');
  const accepter = await demoLogin('c-p-cancel-acc@test.local', 'player');
  await credit(creator.user.id, 1000);
  await credit(accepter.user.id, 1000);
  const open = await createChallenge(creator.token, { stake: 100 });
  assert.equal((await request(app).post(`/challenges/${open.id}/cancel`).set(auth(other.token))).status, 403);
  const cancelled = await request(app).post(`/challenges/${open.id}/cancel`).set(auth(creator.token));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.challenge.status, 'cancelled');
  const matched = await createChallenge(creator.token, { stake: 100 });
  assert.equal((await request(app).post(`/challenges/${matched.id}/accept`).set(auth(accepter.token))).status, 200);
  assert.equal((await request(app).post(`/challenges/${matched.id}/cancel`).set(auth(creator.token))).status, 409);
  // Audit recorded the accept and the cancel.
  const ownerToken = await owner();
  const audit = await request(app).get('/admin/audit-log?action=challenge.accepted').set(auth(ownerToken));
  assert.ok(audit.body.entries.some((e) => e.targetId === String(matched.id)));
});
