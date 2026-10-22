'use strict';
// Part 6 automated tests: referral codes, attach-once, direct-only
// commissions, pending/completed/cancelled flow, rate snapshots,
// dashboard privacy, fee preview and fee history. One throwaway
// SQLite file under /tmp, never the real data directory. Tests share
// one database and run in order; each test uses fresh user emails,
// and tests that change a fee or rate restore it before finishing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const referralsService = require('../src/services/referrals');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part6-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = {
  ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }),
  demoLoginEnabled: true,
};
const app = createApp(config);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function demoLogin(email, role, referralCode) {
  const body = { email, role };
  if (referralCode) body.referralCode = referralCode;
  const res = await request(app).post('/auth/demo').send(body);
  assert.equal(res.status, 200, `demo login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}
let ownerToken = null;
async function owner() {
  if (!ownerToken) ownerToken = (await demoLogin('f-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`)
    .set(auth(await owner())).send({ amount, reason: 'part6 test credit' });
  assert.equal(res.status, 200, `credit failed: ${JSON.stringify(res.body)}`);
}
async function setSetting(key, value) {
  const res = await request(app).put(`/admin/settings/${key}`)
    .set(auth(await owner())).send({ value });
  assert.equal(res.status, 200, `setSetting ${key} failed: ${JSON.stringify(res.body)}`);
}
async function balance(token) {
  const res = await request(app).get('/wallet/me').set(auth(token));
  assert.equal(res.status, 200);
  return res.body.balance;
}
async function makeRoom(prefix, overrides = {}) {
  const creator = await demoLogin(`${prefix}-creator@test.local`, 'player');
  const accepter = await demoLogin(`${prefix}-accepter@test.local`, 'player');
  const stake = overrides.stake || 100;
  await credit(creator.user.id, 10000);
  await credit(accepter.user.id, 10000);
  const ch = await request(app).post('/challenges').set(auth(creator.token)).send({
    arena: overrides.arena || 'Classic', teamSize: overrides.teamSize || '1v1',
    stake, heroRule: 'any', heroBans: [], customRules: '',
    rankRestriction: { type: 'none' },
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
  await sleep(1500);
  return { ...made, room: started };
}
function submit(roomId, token, outcome) {
  return request(app).post(`/match-rooms/${roomId}/results`).set(auth(token)).field('outcome', outcome);
}
async function dashboard(token) {
  const res = await request(app).get('/referrals/me').set(auth(token));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test('referral codes are unique and the dashboard returns a code and link template', async () => {
  const a = await demoLogin('f-code-a@test.local', 'player');
  const b = await demoLogin('f-code-b@test.local', 'player');
  assert.match(a.user.referralCode, /^[A-Z2-9]{8}$/);
  assert.match(b.user.referralCode, /^[A-Z2-9]{8}$/);
  assert.notEqual(a.user.referralCode, b.user.referralCode);
  const d = await dashboard(a.token);
  assert.equal(d.referralCode, a.user.referralCode);
  assert.equal(d.referralLink, `http://localhost:3000/signup?referral=${a.user.referralCode}`);
  assert.equal(d.totalInvites, 0);
  assert.equal(d.totalEarnings, 0);
});

test('attach once: valid, self-referral rejected, second attach rejected, unknown code rejected, same MLBB ID rejected', async () => {
  const referrer = await demoLogin('f-att-ref@test.local', 'player');
  const invitee = await demoLogin('f-att-inv@test.local', 'player');
  const ok = await request(app).post('/referrals/attach').set(auth(invitee.token)).send({ referralCode: referrer.user.referralCode });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.referrerId, referrer.user.id);
  // Second attach (a different code) is rejected, never overwritten.
  const other = await demoLogin('f-att-other@test.local', 'player');
  assert.equal((await request(app).post('/referrals/attach').set(auth(invitee.token)).send({ referralCode: other.user.referralCode })).status, 409);
  // Unknown code.
  const fresh = await demoLogin('f-att-fresh@test.local', 'player');
  assert.equal((await request(app).post('/referrals/attach').set(auth(fresh.token)).send({ referralCode: 'NOPE1234' })).status, 404);
  // Self-referral.
  const selfUser = await demoLogin('f-att-self@test.local', 'player');
  assert.equal((await request(app).post('/referrals/attach').set(auth(selfUser.token)).send({ referralCode: selfUser.user.referralCode })).status, 400);
  // Same MLBB ID on both sides.
  const ref2 = await demoLogin('f-att-ref2@test.local', 'player');
  const inv2 = await demoLogin('f-att-inv2@test.local', 'player');
  assert.equal((await request(app).put('/profile/game-ids').set(auth(ref2.token)).send({ mlbbId: '1234567', serverId: '1234' })).status, 200);
  assert.equal((await request(app).put('/profile/game-ids').set(auth(inv2.token)).send({ mlbbId: '1234567', serverId: '1234' })).status, 200);
  assert.equal((await request(app).post('/referrals/attach').set(auth(inv2.token)).send({ referralCode: ref2.user.referralCode })).status, 400);
  // Attach at signup via demo login.
  const ref3 = await demoLogin('f-att-ref3@test.local', 'player');
  const signed = await demoLogin('f-att-signed@test.local', 'player', ref3.user.referralCode);
  assert.equal(signed.user.referrerId, ref3.user.id);
});

test('commission on win with fee 1000 at 1% = 10, winner payout unchanged', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 1000 });
  try {
    const referrer = await demoLogin('f-win-ref@test.local', 'player');
    const winner = await demoLogin('f-win-w@test.local', 'player', referrer.user.referralCode);
    const loser = await demoLogin('f-win-l@test.local', 'player');
    await credit(winner.user.id, 10000);
    await credit(loser.user.id, 10000);
    // Build a room manually so the winner is the creator.
    const ch = await request(app).post('/challenges').set(auth(winner.token)).send({
      arena: 'Classic', teamSize: '1v1', stake: 1000, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
    });
    assert.equal(ch.status, 201, JSON.stringify(ch.body));
    const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(loser.token));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await setSetting('match.result_window_seconds', 1);
    const started = await startRoom(ok.body.matchRoom, { [winner.user.id]: winner.token, [loser.user.id]: loser.token });
    await setSetting('match.result_window_seconds', 300);
    await sleep(1500);
    assert.equal((await submit(started.id, winner.token, 'win')).status, 201);
    const confirmed = await submit(started.id, loser.token, 'lose');
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.outcome, 'confirmed');
    // Pot 2000, fee 1000, distributable 1000: winner payout is exactly
    // 1000 — the 10-coin commission did not come out of it.
    assert.deepEqual(confirmed.body.settlement.payouts, [{ userId: winner.user.id, side: 'A', amount: 1000 }]);
    assert.equal(confirmed.body.settlement.fee, 1000);
    const wBal = await balance(winner.token);
    assert.deepEqual([wBal.available, wBal.locked], [10000, 0]);
    const rBal = await balance(referrer.token);
    assert.equal(rBal.available, 10);
    const d = await dashboard(referrer.token);
    assert.equal(d.totalEarnings, 10);
    assert.equal(d.totalInvites, 1);
    const mine = d.commissions.filter((c) => c.roomId === started.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'completed');
    assert.equal(mine[0].amount, 10);
    assert.equal(mine[0].feeAmount, 1000);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('no commission when the referred player loses, and none when fee is 0', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 500 });
  try {
    const referrer = await demoLogin('f-lose-ref@test.local', 'player');
    const made = await makeStartedRoom('f-lose', { arena: 'Classic', stake: 100 });
    // Attach the creator as the referrer's invitee before submitting?
    // The creator was created without a referrer, so attach now (the
    // match has not settled yet, but the referrer link is what matters
    // for the settlement hook, which reads it at settlement time).
    const att = await request(app).post('/referrals/attach').set(auth(made.creator.token)).send({ referralCode: referrer.user.referralCode });
    assert.equal(att.status, 200, JSON.stringify(att.body));
    assert.equal((await submit(made.room.id, made.creator.token, 'lose')).status, 201);
    const confirmed = await submit(made.room.id, made.accepter.token, 'win');
    assert.equal(confirmed.status, 201);
    assert.equal((await dashboard(referrer.token)).totalEarnings, 0);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
  // Fee 0 (default): a win creates no commission at all.
  const referrer2 = await demoLogin('f-zero-ref@test.local', 'player');
  const made2 = await makeStartedRoom('f-zero', { arena: 'Classic', stake: 100 });
  assert.equal((await request(app).post('/referrals/attach').set(auth(made2.creator.token)).send({ referralCode: referrer2.user.referralCode })).status, 200);
  assert.equal((await submit(made2.room.id, made2.creator.token, 'win')).status, 201);
  assert.equal((await submit(made2.room.id, made2.accepter.token, 'lose')).status, 201);
  const d2 = await dashboard(referrer2.token);
  assert.equal(d2.totalEarnings, 0);
  assert.equal(d2.commissions.filter((c) => c.roomId === made2.room.id).length, 0);
});

test('direct-only: a grand-referrer gets nothing from a grandchild win', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 1000 });
  try {
    const grand = await demoLogin('f-grand-a@test.local', 'player');
    const parent = await demoLogin('f-grand-b@test.local', 'player', grand.user.referralCode);
    const child = await demoLogin('f-grand-c@test.local', 'player', parent.user.referralCode);
    const opponent = await demoLogin('f-grand-opp@test.local', 'player');
    await credit(child.user.id, 10000);
    await credit(opponent.user.id, 10000);
    const ch = await request(app).post('/challenges').set(auth(child.token)).send({
      arena: 'Classic', teamSize: '1v1', stake: 1000, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
    });
    assert.equal(ch.status, 201);
    const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(opponent.token));
    assert.equal(ok.status, 200);
    await setSetting('match.result_window_seconds', 1);
    const started = await startRoom(ok.body.matchRoom, { [child.user.id]: child.token, [opponent.user.id]: opponent.token });
    await setSetting('match.result_window_seconds', 300);
    await sleep(1500);
    assert.equal((await submit(started.id, child.token, 'win')).status, 201);
    assert.equal((await submit(started.id, opponent.token, 'lose')).status, 201);
    assert.equal((await dashboard(parent.token)).totalEarnings, 10);
    assert.equal((await dashboard(grand.token)).totalEarnings, 0);
    assert.equal((await dashboard(grand.token)).commissions.filter((c) => c.roomId === started.id).length, 0);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('pending placeholders on dispute, completed on winner decision, cancelled on cancel decision', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 100 });
  try {
    const refA = await demoLogin('f-dis-refa@test.local', 'player');
    const refB = await demoLogin('f-dis-refb@test.local', 'player');
    const made = await makeStartedRoom('f-dis', { arena: 'Classic', stake: 100 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(made.creator.token)).send({ referralCode: refA.user.referralCode })).status, 200);
    assert.equal((await request(app).post('/referrals/attach').set(auth(made.accepter.token)).send({ referralCode: refB.user.referralCode })).status, 200);
    assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
    const disputed = await submit(made.room.id, made.accepter.token, 'win');
    assert.equal(disputed.status, 201);
    assert.equal(disputed.body.outcome, 'disputed');
    const pendA = (await dashboard(refA.token)).commissions.find((c) => c.roomId === made.room.id);
    assert.ok(pendA);
    assert.equal(pendA.status, 'pending');
    assert.equal(pendA.amount, null);
    const disp = await request(app).get(`/match-rooms/${made.room.id}/dispute`).set(auth(made.creator.token));
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    const decided = await request(app).post(`/disputes/${disp.body.id}/decision`).set(auth(await owner())).send({ decision: 'winner', winnerSide: 'A', reason: 'evidence reviewed' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const doneA = (await dashboard(refA.token)).commissions.find((c) => c.roomId === made.room.id);
    assert.equal(doneA.status, 'completed');
    assert.equal(doneA.amount, 1); // floor(100 * 1 / 100)
    assert.equal((await balance(refA.token)).available, 1);
    const doneB = (await dashboard(refB.token)).commissions.find((c) => c.roomId === made.room.id);
    assert.equal(doneB.status, 'cancelled');
    assert.equal((await balance(refB.token)).available, 0);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
  // Cancel decision cancels all placeholders and refunds stakes.
  await setSetting('fee.Classic', { type: 'fixed', value: 100 });
  try {
    const refC = await demoLogin('f-dis2-ref@test.local', 'player');
    const made = await makeStartedRoom('f-dis2', { arena: 'Classic', stake: 100 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(made.creator.token)).send({ referralCode: refC.user.referralCode })).status, 200);
    assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
    assert.equal((await submit(made.room.id, made.accepter.token, 'win')).status, 201);
    const disp = await request(app).get(`/match-rooms/${made.room.id}/dispute`).set(auth(made.creator.token));
    const decided = await request(app).post(`/disputes/${disp.body.id}/decision`).set(auth(await owner())).send({ decision: 'cancel', reason: 'inconclusive' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const row = (await dashboard(refC.token)).commissions.find((c) => c.roomId === made.room.id);
    assert.equal(row.status, 'cancelled');
    assert.equal((await dashboard(refC.token)).totalEarnings, 0);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('no double commission on a re-confirm attempt', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 1000 });
  try {
    const referrer = await demoLogin('f-dbl-ref@test.local', 'player');
    const made = await makeStartedRoom('f-dbl', { arena: 'Classic', stake: 1000 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(made.creator.token)).send({ referralCode: referrer.user.referralCode })).status, 200);
    assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
    assert.equal((await submit(made.room.id, made.accepter.token, 'lose')).status, 201);
    assert.equal((await submit(made.room.id, made.accepter.token, 'lose')).status, 409);
    const d = await dashboard(referrer.token);
    assert.equal(d.commissions.filter((c) => c.roomId === made.room.id).length, 1);
    assert.equal(d.totalEarnings, 10);
    assert.equal((await balance(referrer.token)).available, 10);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('rate snapshot: a rate change affects only rooms started after the change, and rate setting is owner-only', async () => {
  // Admin (non-owner) cannot change the rate; bad values are rejected.
  const admin = await demoLogin('f-rate-admin@test.local', 'admin');
  assert.equal((await request(app).put('/admin/settings/referral.commission_percent').set(auth(admin.token)).send({ value: 5 })).status, 403);
  assert.equal((await request(app).put('/admin/settings/referral.commission_percent').set(auth(await owner())).send({ value: 101 })).status, 400);
  await setSetting('referral.commission_percent', 1);
  await setSetting('fee.Classic', { type: 'fixed', value: 1000 });
  try {
    const ref1 = await demoLogin('f-rate-ref1@test.local', 'player');
    const room1 = await makeStartedRoom('f-rate1', { arena: 'Classic', stake: 1000 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(room1.creator.token)).send({ referralCode: ref1.user.referralCode })).status, 200);
    // Rate changes AFTER room1 started: room1 must still use 1%.
    await setSetting('referral.commission_percent', 10);
    const ref2 = await demoLogin('f-rate-ref2@test.local', 'player');
    const room2 = await makeStartedRoom('f-rate2', { arena: 'Classic', stake: 1000 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(room2.creator.token)).send({ referralCode: ref2.user.referralCode })).status, 200);
    assert.equal((await submit(room1.room.id, room1.creator.token, 'win')).status, 201);
    assert.equal((await submit(room1.room.id, room1.accepter.token, 'lose')).status, 201);
    assert.equal((await submit(room2.room.id, room2.creator.token, 'win')).status, 201);
    assert.equal((await submit(room2.room.id, room2.accepter.token, 'lose')).status, 201);
    assert.equal((await dashboard(ref1.token)).totalEarnings, 10);
    assert.equal((await dashboard(ref2.token)).totalEarnings, 100);
    // Decimal rates are accepted (0.5) — restore to 1 afterwards.
    await setSetting('referral.commission_percent', 0.5);
  } finally {
    await setSetting('referral.commission_percent', 1);
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('dashboard invitees expose only public fields', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 1000 });
  try {
    const referrer = await demoLogin('f-priv-ref@test.local', 'player');
    const made = await makeStartedRoom('f-priv', { arena: 'Classic', stake: 1000 });
    assert.equal((await request(app).post('/referrals/attach').set(auth(made.creator.token)).send({ referralCode: referrer.user.referralCode })).status, 200);
    assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
    assert.equal((await submit(made.room.id, made.accepter.token, 'lose')).status, 201);
    const res = await request(app).get('/referrals/me/invitees').set(auth(referrer.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.invitees.length, 1);
    const inv = res.body.invitees[0];
    assert.deepEqual(Object.keys(inv).sort(), ['commissionEarned', 'displayName', 'feeContributed', 'matchesWon']);
    assert.equal(inv.matchesWon, 1);
    assert.equal(inv.feeContributed, 1000);
    assert.equal(inv.commissionEarned, 10);
    // Another user sees only their own invitees, not this referrer's.
    const other = await demoLogin('f-priv-other@test.local', 'player');
    assert.deepEqual((await request(app).get('/referrals/me/invitees').set(auth(other.token))).body.invitees, []);
    // Staff aggregate has counts only, no private fields.
    assert.equal((await request(app).get('/referrals/admin/aggregate').set(auth(other.token))).status, 403);
    const agg = await request(app).get('/referrals/admin/aggregate').set(auth(await owner()));
    assert.equal(agg.status, 200);
    assert.ok(!JSON.stringify(agg.body).includes('@test.local'));
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('fee preview math matches settlement math, and fee history is owner/admin only', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 100 });
  try {
    const prev = await request(app).get('/fees/preview?arena=Classic&stake=100&participantCount=2').set(auth((await demoLogin('f-prev-u@test.local', 'player')).token));
    assert.equal(prev.status, 200);
    assert.equal(prev.body.preview, true);
    assert.equal(prev.body.pot, 200);
    assert.equal(prev.body.fee, 100);
    assert.equal(prev.body.distributable, 100);
    assert.equal(prev.body.perWinnerPayout, 100);
    // Unauthenticated preview is rejected.
    assert.equal((await request(app).get('/fees/preview?arena=Classic&stake=100&participantCount=2')).status, 401);
    // Percent preview.
    await setSetting('fee.Classic', { type: 'percent', value: 10 });
    const prev2 = await request(app).get('/fees/preview?arena=Classic&stake=100&participantCount=4').set(auth((await demoLogin('f-prev-u2@test.local', 'player')).token));
    assert.equal(prev2.body.pot, 400);
    assert.equal(prev2.body.fee, 40);
    assert.equal(prev2.body.distributable, 360);
    assert.equal(prev2.body.perWinnerPayout, 180);
    // Settle a match with the same percent fee and check history.
    const made = await makeStartedRoom('f-prev', { arena: 'Classic', stake: 100 });
    assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
    const confirmed = await submit(made.room.id, made.accepter.token, 'lose');
    assert.equal(confirmed.body.settlement.fee, 20); // pot 200 at 10%
    const hist = await request(app).get('/fees/history?arena=Classic').set(auth(await owner()));
    assert.equal(hist.status, 200);
    assert.ok(hist.body.fees.some((f) => f.roomId === made.room.id && f.amount === 20));
    const player = await demoLogin('f-prev-player@test.local', 'player');
    assert.equal((await request(app).get('/fees/history').set(auth(player.token))).status, 403);
  } finally {
    await setSetting('fee.Classic', { type: 'percent', value: 0 });
  }
});

test('synthetic settlement guard and commission math helpers', () => {
  assert.equal(referralsService.participantsShareUser([
    { userId: 1, side: 'A' }, { userId: 1, side: 'B' },
  ]), true);
  assert.equal(referralsService.participantsShareUser([
    { userId: 1, side: 'A' }, { userId: 2, side: 'B' },
  ]), false);
  assert.equal(referralsService.computeCommissionAmount(1000, 1), 10);
  assert.equal(referralsService.computeCommissionAmount(99, 1), 0);
  assert.equal(referralsService.computeCommissionAmount(0, 1), 0);
});
