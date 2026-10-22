'use strict';
// Part 4 automated tests: private match rooms — room detail/privacy,
// game IDs, per-room roster, mini chat, voice signalling, ready and
// countdown with full-roster rules, server timers, ready-timeout and
// leader-leave cancellation with refunds, reconnect, and notification
// records. One throwaway SQLite file under /tmp, never the real data
// directory. Tests share one database and run in order; each test uses
// fresh user emails, and tests that shorten a timer setting restore it
// before finishing so later tests are not affected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part4-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = {
  ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }),
  demoLoginEnabled: true,
};
const app = createApp(config);
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function demoLogin(email, role) {
  const res = await request(app).post('/auth/demo').send({ email, role });
  assert.equal(res.status, 200, `demo login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body;
}
let ownerToken = null;
async function owner() {
  if (!ownerToken) ownerToken = (await demoLogin('d-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`)
    .set(auth(await owner())).send({ amount, reason: 'part4 test credit' });
  assert.equal(res.status, 200, `credit failed: ${JSON.stringify(res.body)}`);
}
async function setSetting(key, value) {
  const res = await request(app).put(`/admin/settings/${key}`)
    .set(auth(await owner())).send({ value });
  assert.equal(res.status, 200, `setSetting ${key} failed: ${JSON.stringify(res.body)}`);
}
async function setRank(token, rankTier) {
  const res = await request(app).put('/profile/rank').set(auth(token)).send({ rankTier });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function setGameIds(token, mlbbId, serverId) {
  return request(app).put('/profile/game-ids').set(auth(token)).send({ mlbbId, serverId });
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
  return { creator, accepter, room: ok.body.matchRoom, challenge: ch.body.challenge };
}
async function roomDetail(token, roomId) {
  const res = await request(app).get(`/match-rooms/${roomId}`).set(auth(token));
  return res;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('room detail shows IDs/ranks and blocks non-participants; staff view is read-only', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-detail');
  await setRank(creator.token, 'Epic');
  await setRank(accepter.token, 'Legend');
  assert.equal((await setGameIds(creator.token, '12345678', '1234')).status, 200);
  assert.equal((await setGameIds(accepter.token, '87654321', '4321')).status, 200);
  const detail = await roomDetail(creator.token, room.id);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.status, 'waiting_ready');
  assert.equal(detail.body.participants.length, 2);
  const a = detail.body.participants.find((p) => p.side === 'A');
  const b = detail.body.participants.find((p) => p.side === 'B');
  assert.equal(a.mlbbId, '12345678');
  assert.equal(a.serverId, '1234');
  assert.equal(a.rankTier, 'Epic');
  assert.equal(b.mlbbId, '87654321');
  assert.equal(b.rankTier, 'Legend');
  // Display fields only: no email (or any private field) on participants.
  for (const p of detail.body.participants) {
    assert.equal(p.email, undefined);
    assert.deepEqual(Object.keys(p).sort(), ['avatarUrl', 'displayName', 'joinedAt', 'mlbbId', 'rankTier', 'ready', 'role', 'serverId', 'side', 'userId']);
  }
  const outsider = await demoLogin('d-p-outsider@test.local', 'player');
  assert.equal((await roomDetail(outsider.token, room.id)).status, 403);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/chat`).set(auth(outsider.token)).send({ text: 'hi' })).status, 403);
  const moderator = await demoLogin('d-p-mod@test.local', 'moderator');
  assert.equal((await roomDetail(moderator.token, room.id)).status, 200);
  // Staff may view but may not play: ready and chat are participant-only.
  assert.equal((await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(moderator.token)).send({ ready: true })).status, 403);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/chat`).set(auth(moderator.token)).send({ text: 'staff hi' })).status, 403);
});

test('game-ID validation: too short, non-digits and too long rejected; valid and clear work', async () => {
  const player = await demoLogin('d-p-ids@test.local', 'player');
  assert.equal((await setGameIds(player.token, '1234', '123')).status, 400);
  assert.equal((await setGameIds(player.token, '12ab5678', '123')).status, 400);
  assert.equal((await setGameIds(player.token, '1234567890123', '123')).status, 400);
  assert.equal((await setGameIds(player.token, '12345678', '12')).status, 400);
  assert.equal((await setGameIds(player.token, '12345678', '1234567')).status, 400);
  const ok = await setGameIds(player.token, '12345678', '1234');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.mlbbId, '12345678');
  assert.equal(ok.body.user.serverId, '1234');
  const cleared = await setGameIds(player.token, null, null);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.user.mlbbId, null);
});

test('roster: leaders add to their own side up to the limit, members cannot add, removal refunds', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-roster', { teamSize: '5v5' });
  const membersA = [];
  for (let i = 0; i < 4; i++) {
    const m = await demoLogin(`d-p-roster-a${i}@test.local`, 'player');
    await credit(m.user.id, 10000);
    const res = await request(app).post(`/match-rooms/${room.id}/roster`).set(auth(creator.token)).send({ userId: m.user.id });
    assert.equal(res.status, 200, `add A${i} failed: ${JSON.stringify(res.body)}`);
    membersA.push(m);
  }
  // Side A is now full (leader + 4). A fifth addition fails.
  const extra = await demoLogin('d-p-roster-extra@test.local', 'player');
  await credit(extra.user.id, 10000);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/roster`).set(auth(creator.token)).send({ userId: extra.user.id })).status, 409);
  // Adding the same user again fails; a member cannot add anyone.
  assert.equal((await request(app).post(`/match-rooms/${room.id}/roster`).set(auth(creator.token)).send({ userId: membersA[0].user.id })).status, 409);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/roster`).set(auth(membersA[0].token)).send({ userId: extra.user.id })).status, 403);
  // A leader adds only to their own side: accepter's addition lands on B.
  const bMember = await demoLogin('d-p-roster-b0@test.local', 'player');
  await credit(bMember.user.id, 10000);
  const added = await request(app).post(`/match-rooms/${room.id}/roster`).set(auth(accepter.token)).send({ userId: bMember.user.id });
  assert.equal(added.status, 200);
  assert.equal(added.body.participants.find((p) => p.userId === bMember.user.id).side, 'B');
  // A leader cannot remove a member from the other side, or a leader.
  assert.equal((await request(app).delete(`/match-rooms/${room.id}/roster/${bMember.user.id}`).set(auth(creator.token))).status, 403);
  assert.equal((await request(app).delete(`/match-rooms/${room.id}/roster/${accepter.user.id}`).set(auth(accepter.token))).status, 400);
  // Removing a member refunds that member's locked stake.
  const before = await balance(membersA[0].token);
  assert.equal(before.locked, 100);
  const removed = await request(app).delete(`/match-rooms/${room.id}/roster/${membersA[0].user.id}`).set(auth(creator.token));
  assert.equal(removed.status, 200);
  const after = await balance(membersA[0].token);
  assert.equal(after.locked, 0);
  assert.equal(after.available, before.available + 100);
});

test('chat post/history and reconnect return the same state', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-chat');
  assert.equal((await request(app).post(`/match-rooms/${room.id}/chat`).set(auth(creator.token)).send({ text: 'good luck' })).status, 201);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/chat`).set(auth(accepter.token)).send({ text: 'you too' })).status, 201);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/chat`).set(auth(creator.token)).send({ text: '' })).status, 400);
  const hist = await request(app).get(`/match-rooms/${room.id}/chat`).set(auth(accepter.token));
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.messages.map((m) => m.text), ['good luck', 'you too']);
  const desc = await request(app).get(`/match-rooms/${room.id}/chat?order=desc`).set(auth(accepter.token));
  assert.deepEqual(desc.body.messages.map((m) => m.text), ['you too', 'good luck']);
  const rec = await request(app).get(`/match-rooms/${room.id}/reconnect`).set(auth(creator.token));
  assert.equal(rec.status, 200);
  assert.deepEqual(rec.body.chat.map((m) => m.text), ['good luck', 'you too']);
  assert.equal(rec.body.participants.length, 2);
  assert.ok(rec.body.timer.serverTime);
});

test('voice signalling is participant-only and relayed within the room; audio is not claimed', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-voice');
  const outsider = await demoLogin('d-p-voice-out@test.local', 'player');
  assert.equal((await request(app).post(`/match-rooms/${room.id}/voice/join`).set(auth(outsider.token))).status, 403);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/voice/join`).set(auth(creator.token))).status, 200);
  const sig = await request(app).post(`/match-rooms/${room.id}/voice/signal`).set(auth(creator.token))
    .send({ toUserId: accepter.user.id, kind: 'offer', payload: 'sdp-offer' });
  assert.equal(sig.status, 201, JSON.stringify(sig.body));
  const seen = await request(app).get(`/match-rooms/${room.id}/voice/signals`).set(auth(accepter.token));
  assert.equal(seen.status, 200);
  assert.equal(seen.body.signals.length, 1);
  assert.equal(seen.body.signals[0].kind, 'offer');
  assert.equal(seen.body.signals[0].payload, 'sdp-offer');
  assert.equal((await request(app).post(`/match-rooms/${room.id}/voice/signal`).set(auth(outsider.token))
    .send({ kind: 'offer', payload: 'x' })).status, 403);
  assert.equal((await request(app).post(`/match-rooms/${room.id}/voice/signal`).set(auth(creator.token))
    .send({ toUserId: outsider.user.id, kind: 'offer', payload: 'x' })).status, 400);
  const left = await request(app).post(`/match-rooms/${room.id}/voice/leave`).set(auth(creator.token));
  assert.equal(left.status, 200);
  assert.deepEqual(left.body.members, []);
});

test('ready/un-ready, countdown only when the roster is full and all are ready, server timer is stable', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-ready');
  // One ready alone does not start anything.
  const one = await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: true });
  assert.equal(one.status, 200);
  assert.equal(one.body.status, 'waiting_ready');
  assert.equal(one.body.participants.find((p) => p.userId === creator.user.id).ready, true);
  // Un-ready works before start.
  const un = await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: false });
  assert.equal(un.body.participants.find((p) => p.userId === creator.user.id).ready, false);
  assert.equal(un.body.status, 'waiting_ready');
  // Both ready in a full 1v1 room starts the countdown.
  await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: true });
  const both = await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(accepter.token)).send({ ready: true });
  assert.equal(both.status, 200);
  assert.equal(both.body.status, 'countdown');
  assert.ok(both.body.timer.countdownEndsAt);
  // Shorten the countdown for this room only, wait it out, and check
  // the server-derived start: started_at is the countdown end, and a
  // second fetch does not restart or move it.
  await setSetting('match.countdown_seconds', 1);
  await sleep(1200);
  const started = await roomDetail(creator.token, room.id);
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'started');
  assert.ok(started.body.startedAt);
  assert.equal(new Date(started.body.resultWindowOpensAt) - new Date(started.body.startedAt), 5 * 60 * 1000);
  const again = await roomDetail(creator.token, room.id);
  assert.equal(again.body.startedAt, started.body.startedAt);
  assert.equal(again.body.status, 'started');
  await setSetting('match.countdown_seconds', 10);
  // Ready can no longer change after start.
  assert.equal((await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: false })).status, 409);
  return { creator, accepter, room };
});

test('5v5 with an incomplete roster does not start, and names the missing counts', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-incomplete', { teamSize: '5v5' });
  await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: true });
  const res = await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(accepter.token)).send({ ready: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'waiting_ready');
  assert.equal(res.body.rosterFull, false);
  assert.deepEqual(res.body.missing, { A: 4, B: 4 });
});

test('ready timeout cancels the room and refunds both stakes', async () => {
  await setSetting('match.ready_timeout_seconds', 1);
  const { creator, accepter, room } = await makeRoom('d-p-timeout');
  const beforeC = await balance(creator.token);
  const beforeA = await balance(accepter.token);
  assert.equal(beforeC.locked, 100);
  assert.equal(beforeA.locked, 100);
  await sleep(1200);
  const detail = await roomDetail(creator.token, room.id);
  assert.equal(detail.body.status, 'cancelled');
  assert.equal(detail.body.cancelReason, 'ready_timeout');
  const afterC = await balance(creator.token);
  const afterA = await balance(accepter.token);
  assert.equal(afterC.locked, 0);
  assert.equal(afterA.locked, 0);
  assert.equal(afterC.available, beforeC.available + 100);
  assert.equal(afterA.available, beforeA.available + 100);
  await setSetting('match.ready_timeout_seconds', 300);
});

test('leader leaving cancels with refunds; member leaving only removes that member; cancel after start is rejected', async () => {
  // Member leave.
  const five = await makeRoom('d-p-leave', { teamSize: '5v5' });
  const member = await demoLogin('d-p-leave-m@test.local', 'player');
  await credit(member.user.id, 10000);
  assert.equal((await request(app).post(`/match-rooms/${five.room.id}/roster`).set(auth(five.creator.token)).send({ userId: member.user.id })).status, 200);
  const left = await request(app).post(`/match-rooms/${five.room.id}/leave`).set(auth(member.token));
  assert.equal(left.status, 200);
  assert.equal(left.body.participants.find((p) => p.userId === member.user.id), undefined);
  assert.equal((await balance(member.token)).locked, 0);
  // Leader leave cancels the whole room and refunds both leaders.
  const one = await makeRoom('d-p-leaderleave');
  const leftRoom = await request(app).post(`/match-rooms/${one.room.id}/leave`).set(auth(one.creator.token));
  assert.equal(leftRoom.status, 200);
  assert.equal(leftRoom.body.status, 'cancelled');
  assert.equal(leftRoom.body.cancelReason, 'leader_left');
  assert.equal((await balance(one.creator.token)).locked, 0);
  assert.equal((await balance(one.accepter.token)).locked, 0);
  // Cancel after start is rejected: build a started room, then try leave.
  await setSetting('match.countdown_seconds', 1);
  const started = await makeRoom('d-p-started');
  await request(app).post(`/match-rooms/${started.room.id}/ready`).set(auth(started.creator.token)).send({ ready: true });
  await request(app).post(`/match-rooms/${started.room.id}/ready`).set(auth(started.accepter.token)).send({ ready: true });
  await sleep(1200);
  const s = await roomDetail(started.creator.token, started.room.id);
  assert.equal(s.body.status, 'started');
  assert.equal((await request(app).post(`/match-rooms/${started.room.id}/leave`).set(auth(started.creator.token))).status, 409);
  await setSetting('match.countdown_seconds', 10);
});

test('notification records are created on ready, start and cancel', async () => {
  const { creator, accepter, room } = await makeRoom('d-p-notif');
  await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(creator.token)).send({ ready: true });
  const unreadA = await request(app).get('/notifications/unread').set(auth(accepter.token));
  assert.equal(unreadA.status, 200);
  assert.ok(unreadA.body.notifications.some((n) => n.type === 'player_ready' && n.roomId === room.id));
  await setSetting('match.countdown_seconds', 1);
  await request(app).post(`/match-rooms/${room.id}/ready`).set(auth(accepter.token)).send({ ready: true });
  await sleep(1200);
  await roomDetail(creator.token, room.id);
  const unreadB = await request(app).get('/notifications/unread').set(auth(creator.token));
  assert.ok(unreadB.body.notifications.some((n) => n.type === 'match_started' && n.roomId === room.id));
  await setSetting('match.countdown_seconds', 10);
  // Cancel path: a fresh room whose leader leaves.
  const two = await makeRoom('d-p-notif2');
  await request(app).post(`/match-rooms/${two.room.id}/leave`).set(auth(two.creator.token));
  const unreadC = await request(app).get('/notifications/unread').set(auth(two.accepter.token));
  assert.ok(unreadC.body.notifications.some((n) => n.type === 'room_cancelled' && n.roomId === two.room.id));
});
