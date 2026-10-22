'use strict';
// Part 5 automated tests: result submission gate, side submissions,
// matching settlement, disputes, evidence upload, reputation, reports
// (including temp/permanent bans) and match history. One throwaway
// SQLite file under /tmp, never the real data directory. Tests share
// one database and run in order; each test uses fresh user emails,
// and tests that shorten a timer or change a fee restore it before
// finishing so later tests are not affected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part5-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = {
  ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }),
  demoLoginEnabled: true,
};
const app = createApp(config);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function demoLogin(email, role) {
  const res = await request(app).post('/auth/demo').send({ email, role });
  assert.equal(res.status, 200, `demo login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}
let ownerToken = null;
async function owner() {
  if (!ownerToken) ownerToken = (await demoLogin('e-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`)
    .set(auth(await owner())).send({ amount, reason: 'part5 test credit' });
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
async function addMember(roomId, leaderToken, email) {
  const m = await demoLogin(email, 'player');
  await credit(m.user.id, 10000);
  const res = await request(app).post(`/match-rooms/${roomId}/roster`).set(auth(leaderToken)).send({ userId: m.user.id });
  assert.equal(res.status, 200, `roster add failed: ${JSON.stringify(res.body)}`);
  return m;
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
  const { windowSeconds = 1 } = overrides;
  const made = await makeRoom(prefix, overrides);
  const tokensById = { ...made.tokensById };
  if (overrides.teamSize && overrides.teamSize !== '1v1') {
    // One extra member per side for team tests (2v2 in the split test).
    const a = await addMember(made.room.id, made.creator.token, `${prefix}-a1@test.local`);
    const b = await addMember(made.room.id, made.accepter.token, `${prefix}-b1@test.local`);
    tokensById[a.user.id] = a.token;
    tokensById[b.user.id] = b.token;
    made.members = [a, b];
  }
  await setSetting('match.result_window_seconds', windowSeconds);
  const started = await startRoom(made.room, tokensById);
  await setSetting('match.result_window_seconds', 300);
  // The window opens windowSeconds after the recorded startedAt, and
  // startedAt is the countdown end, which is already ~0.2s in the past
  // by the time the room is fetched as started — so wait out the full
  // window plus margin before any submission in these tests.
  await sleep(windowSeconds * 1000 + 500);
  return { ...made, room: started, tokensById };
}
async function submit(roomId, token, outcome, withEvidence = false) {
  let req = request(app).post(`/match-rooms/${roomId}/results`).set(auth(token)).field('outcome', outcome);
  if (withEvidence) req = req.attach('evidence', Buffer.from('fake-png-bytes'), 'shot.png');
  return req;
}
const png = () => Buffer.from('fake-png-bytes');

test('submission before start is rejected, and before the 5-minute window is rejected with the window named', async () => {
  const made = await makeRoom('e-early');
  // Waiting room: not started yet.
  assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 409);
  // Started room with the default 300-second window: immediate submit fails.
  await setSetting('match.result_window_seconds', 300);
  const started = await startRoom(made.room, made.tokensById);
  assert.equal(started.status, 'started');
  const early = await submit(made.room.id, made.creator.token, 'win');
  assert.equal(early.status, 400, JSON.stringify(early.body));
  assert.match(early.body.error, /not open yet/);
});

test('non-leader cannot submit, and a side cannot submit twice', async () => {
  const made = await makeStartedRoom('e-leader', { teamSize: '2v2' });
  const member = made.members[0];
  assert.equal((await submit(made.room.id, member.token, 'win')).status, 403);
  const first = await submit(made.room.id, made.creator.token, 'win');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.outcome, 'pending');
  assert.equal((await submit(made.room.id, made.creator.token, 'lose')).status, 409);
});

test('matching submissions settle: pot, equal split, loser consumed, no double settlement', async () => {
  const made = await makeStartedRoom('e-match');
  const beforeW = await balance(made.creator.token);
  const beforeL = await balance(made.accepter.token);
  assert.deepEqual([beforeW.available, beforeW.locked], [9900, 100]);
  assert.deepEqual([beforeL.available, beforeL.locked], [9900, 100]);
  assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
  const confirmed = await submit(made.room.id, made.accepter.token, 'lose');
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.outcome, 'confirmed');
  assert.equal(confirmed.body.winnerSide, 'A');
  assert.equal(confirmed.body.settlement.pot, 200);
  assert.equal(confirmed.body.settlement.fee, 0);
  assert.deepEqual(confirmed.body.settlement.payouts, [{ userId: made.creator.user.id, side: 'A', amount: 200 }]);
  const afterW = await balance(made.creator.token);
  const afterL = await balance(made.accepter.token);
  assert.deepEqual([afterW.available, afterW.locked], [10100, 0]);
  assert.deepEqual([afterL.available, afterL.locked], [9900, 0]);
  // A second submission cannot re-settle: the room is finished.
  assert.equal((await submit(made.room.id, made.accepter.token, 'lose')).status, 409);
  assert.deepEqual(await balance(made.creator.token), afterW);
});

test('fee snapshot at start is used even if the fee changes before settlement, with remainder to the first winner', async () => {
  await setSetting('fee.Classic', { type: 'fixed', value: 1 });
  const made = await makeStartedRoom('e-fee', { teamSize: '2v2', stake: 100 });
  // Change the fee after the room started: settlement must still use
  // the snapshot (fixed 1), not the new 0.
  await setSetting('fee.Classic', { type: 'percent', value: 0 });
  // Side A wins: creator (leader, first winner) + member A.
  await submit(made.room.id, made.creator.token, 'win');
  const confirmed = await submit(made.room.id, made.accepter.token, 'lose');
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  // Pot 400, fee 1, distributable 399, winners 2: base 199, remainder 1
  // to the first winner (the leader).
  assert.equal(confirmed.body.settlement.pot, 400);
  assert.equal(confirmed.body.settlement.fee, 1);
  const payouts = confirmed.body.settlement.payouts;
  assert.equal(payouts.find((p) => p.userId === made.creator.user.id).amount, 200);
  assert.equal(payouts.find((p) => p.userId === made.members[0].user.id).amount, 199);
  await setSetting('fee.Classic', { type: 'percent', value: 0 });
});

test('mismatching submissions open a dispute with coins still locked; moderator cannot decide, owner winner decision settles and penalises the false side', async () => {
  const made = await makeStartedRoom('e-dispute');
  await submit(made.room.id, made.creator.token, 'win');
  const disputed = await submit(made.room.id, made.accepter.token, 'win');
  assert.equal(disputed.status, 201, JSON.stringify(disputed.body));
  assert.equal(disputed.body.outcome, 'disputed');
  assert.ok(disputed.body.dispute);
  const locked = await balance(made.creator.token);
  assert.equal(locked.locked, 100);
  const room = await request(app).get(`/match-rooms/${made.room.id}`).set(auth(made.creator.token));
  assert.equal(room.body.status, 'disputed');
  const disputeId = disputed.body.dispute.id;
  const moderator = await demoLogin('e-dispute-mod@test.local', 'moderator');
  assert.equal((await request(app).post(`/disputes/${disputeId}/decision`).set(auth(moderator.token))
    .send({ decision: 'winner', winnerSide: 'A', reason: 'mod tries' })).status, 403);
  const note = await request(app).post(`/disputes/${disputeId}/notes`).set(auth(moderator.token)).send({ note: 'checked evidence' });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const decided = await request(app).post(`/disputes/${disputeId}/decision`).set(auth(await owner()))
    .send({ decision: 'winner', winnerSide: 'A', reason: 'screenshot shows A won' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.settlement.winnerSide, 'A');
  assert.equal((await request(app).post(`/disputes/${disputeId}/decision`).set(auth(await owner()))
    .send({ decision: 'winner', winnerSide: 'B', reason: 'again' })).status, 409);
  // Losing side leader (B) was penalised -20; winning leader untouched.
  const repB = await request(app).get(`/reputation/${made.accepter.user.id}`).set(auth(await owner()));
  assert.equal(repB.body.reputation.score, 80);
  assert.equal(repB.body.reputation.badge, 'Good');
  const repA = await request(app).get(`/reputation/${made.creator.user.id}`).set(auth(await owner()));
  assert.equal(repA.body.reputation.score, 100);
});

test('admin cancel decision refunds both stakes and writes cancelled history', async () => {
  const made = await makeStartedRoom('e-cancel');
  await submit(made.room.id, made.creator.token, 'win');
  const disputed = await submit(made.room.id, made.accepter.token, 'win');
  const disputeId = disputed.body.dispute.id;
  const decided = await request(app).post(`/disputes/${disputeId}/decision`).set(auth(await owner()))
    .send({ decision: 'cancel', reason: 'evidence inconclusive' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((await balance(made.creator.token)).locked, 0);
  assert.equal((await balance(made.creator.token)).available, 10000);
  const hist = await request(app).get('/match-history/mine').set(auth(made.creator.token));
  const entry = hist.body.history.find((h) => h.matchId === made.room.id);
  assert.ok(entry);
  assert.equal(entry.result, 'cancelled');
  assert.equal(entry.status, 'cancelled');
});

test('evidence upload: images accepted, non-images and oversize rejected, download restricted to participants/staff', async () => {
  const made = await makeStartedRoom('e-evidence');
  const withShot = await submit(made.room.id, made.creator.token, 'win', true);
  assert.equal(withShot.status, 201, JSON.stringify(withShot.body));
  assert.equal(withShot.body.evidence.length, 1);
  const evidenceId = withShot.body.evidence[0].id;
  const outsider = await demoLogin('e-evidence-out@test.local', 'player');
  assert.equal((await request(app).get(`/evidence/${evidenceId}`).set(auth(outsider.token))).status, 403);
  const mine = await request(app).get(`/evidence/${evidenceId}`).set(auth(made.accepter.token));
  assert.equal(mine.status, 200);
  assert.match(mine.headers['content-type'], /image\/png/);
  // Non-image rejected (on a fresh room, so the submission itself is valid).
  const made2 = await makeStartedRoom('e-evidence2');
  const bad = await request(app).post(`/match-rooms/${made2.room.id}/results`).set(auth(made2.creator.token))
    .field('outcome', 'win').attach('evidence', Buffer.from('not an image'), 'notes.txt');
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  // Oversize rejected.
  const big = await request(app).post(`/match-rooms/${made2.room.id}/results`).set(auth(made2.creator.token))
    .field('outcome', 'win').attach('evidence', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png');
  assert.equal(big.status, 400, JSON.stringify(big.body));
  // Dispute evidence is capped at 3 files.
  const made3 = await makeStartedRoom('e-evidence3');
  await submit(made3.room.id, made3.creator.token, 'win');
  const disputed = await submit(made3.room.id, made3.accepter.token, 'win');
  const disputeId = disputed.body.dispute.id;
  const three = await request(app).post(`/disputes/${disputeId}/evidence`).set(auth(made3.creator.token))
    .attach('evidence', png(), 'a.png').attach('evidence', png(), 'b.png').attach('evidence', png(), 'c.png');
  assert.equal(three.status, 201, JSON.stringify(three.body));
  const fourth = await request(app).post(`/disputes/${disputeId}/evidence`).set(auth(made3.creator.token))
    .attach('evidence', png(), 'd.png');
  assert.equal(fourth.status, 400);
});

test('reputation: manual penalty, badge thresholds, and self-only/staff viewing', async () => {
  const player = await demoLogin('e-rep@test.local', 'player');
  const me = await request(app).get('/reputation/me').set(auth(player.token));
  assert.equal(me.body.reputation.score, 100);
  assert.equal(me.body.reputation.badge, 'Trusted');
  assert.equal((await request(app).post(`/reputation/${player.user.id}/penalty`).set(auth(player.token))
    .send({ points: 10, reason: 'self penalty' })).status, 403);
  const penalised = await request(app).post(`/reputation/${player.user.id}/penalty`).set(auth(await owner()))
    .send({ points: 20, reason: 'toxic behaviour in a match' });
  assert.equal(penalised.status, 200, JSON.stringify(penalised.body));
  assert.equal(penalised.body.reputation.score, 80);
  assert.equal(penalised.body.reputation.badge, 'Good');
  const more = await request(app).post(`/reputation/${player.user.id}/penalty`).set(auth(await owner()))
    .send({ points: 50, reason: 'repeated delaying' });
  assert.equal(more.body.reputation.score, 30);
  assert.equal(more.body.reputation.badge, 'Low');
  const other = await demoLogin('e-rep-other@test.local', 'player');
  assert.equal((await request(app).get(`/reputation/${player.user.id}`).set(auth(other.token))).status, 403);
  const events = await request(app).get(`/reputation/${player.user.id}/events`).set(auth(player.token));
  assert.equal(events.body.events.length, 2);
});

test('reports: case id format, self-report rejected, investigate vs resolve permissions, warning, temp ban with expiry, permanent ban', async () => {
  const reporter = await demoLogin('e-report-r@test.local', 'player');
  const reported = await demoLogin('e-report-t@test.local', 'player');
  assert.equal((await request(app).post('/reports').set(auth(reporter.token))
    .field('reportedUserId', String(reporter.user.id)).field('category', 'cheating').field('reason', 'self')).status, 400);
  const created = await request(app).post('/reports').set(auth(reporter.token))
    .field('reportedUserId', String(reported.user.id)).field('category', 'fake_screenshot').field('reason', 'screenshot does not match');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.report.caseId, /^REP-\d{8}-\d{4}$/);
  assert.equal(created.body.report.status, 'open');
  const reportId = created.body.report.id;
  assert.equal((await request(app).post(`/reports/${reportId}/investigate`).set(auth(reporter.token)).send({})).status, 403);
  const moderator = await demoLogin('e-report-mod@test.local', 'moderator');
  const inv = await request(app).post(`/reports/${reportId}/investigate`).set(auth(moderator.token)).send({ note: 'looking into it' });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(inv.body.report.status, 'investigating');
  assert.equal((await request(app).post(`/reports/${reportId}/resolve`).set(auth(moderator.token))
    .send({ resolution: 'mod tries', action: 'warning' })).status, 403);
  const resolved = await request(app).post(`/reports/${reportId}/resolve`).set(auth(await owner()))
    .send({ resolution: 'evidence confirmed', action: 'warning' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.report.status, 'resolved');
  assert.equal(resolved.body.report.actionTaken, 'warning');
  const rep = await request(app).get(`/reputation/${reported.user.id}`).set(auth(await owner()));
  assert.equal(rep.body.reputation.warningCount, 1);

  // Temporary ban: login blocked, then allowed again after expiry.
  const tempTarget = await demoLogin('e-report-temp@test.local', 'player');
  const tempReport = await request(app).post('/reports').set(auth(reporter.token))
    .field('reportedUserId', String(tempTarget.user.id)).field('category', 'toxic_behaviour').field('reason', 'abuse in chat');
  const until = new Date(Date.now() + 2000).toISOString();
  const tempResolved = await request(app).post(`/reports/${tempReport.body.report.id}/resolve`).set(auth(await owner()))
    .send({ resolution: 'temp ban', action: 'temp_ban', tempBanUntil: until });
  assert.equal(tempResolved.status, 200, JSON.stringify(tempResolved.body));
  assert.equal((await request(app).post('/auth/demo').send({ email: 'e-report-temp@test.local', role: 'player' })).status, 403);
  await sleep(2200);
  assert.equal((await request(app).post('/auth/demo').send({ email: 'e-report-temp@test.local', role: 'player' })).status, 200);

  // Permanent ban: login stays blocked.
  const permTarget = await demoLogin('e-report-perm@test.local', 'player');
  const permReport = await request(app).post('/reports').set(auth(reporter.token))
    .field('reportedUserId', String(permTarget.user.id)).field('category', 'fake_account').field('reason', 'multiple fake accounts');
  const permResolved = await request(app).post(`/reports/${permReport.body.report.id}/resolve`).set(auth(await owner()))
    .send({ resolution: 'permanent', action: 'permanent_ban' });
  assert.equal(permResolved.status, 200);
  assert.equal((await request(app).post('/auth/demo').send({ email: 'e-report-perm@test.local', role: 'player' })).status, 403);
});

test('match history: confirmed entries for winner and loser, staff lookup by match id, player lookup forbidden', async () => {
  const made = await makeStartedRoom('e-history');
  await submit(made.room.id, made.creator.token, 'win');
  await submit(made.room.id, made.accepter.token, 'lose');
  const mine = await request(app).get('/match-history/mine').set(auth(made.creator.token));
  const entry = mine.body.history.find((h) => h.matchId === made.room.id);
  assert.ok(entry);
  assert.equal(entry.result, 'win');
  assert.equal(entry.payout, 200);
  assert.equal(entry.arena, 'Classic');
  const loserHist = await request(app).get('/match-history/mine?result=lose').set(auth(made.accepter.token));
  assert.ok(loserHist.body.history.find((h) => h.matchId === made.room.id));
  const staff = await request(app).get(`/match-history/${made.room.id}`).set(auth(await owner()));
  assert.equal(staff.status, 200);
  assert.equal(staff.body.history.length, 2);
  assert.equal((await request(app).get(`/match-history/${made.room.id}`).set(auth(made.creator.token))).status, 403);
});
