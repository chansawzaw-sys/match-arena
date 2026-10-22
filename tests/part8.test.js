'use strict';
// Part 8 automated tests: no-code site control, versioned terms,
// statistics, notification centre, Telegram link, maintenance /
// emergency modes, backups, health, sweeper, help centre, tickets,
// suspicious-account review. One throwaway SQLite file under /tmp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part8-'));
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
  if (!ownerToken) ownerToken = (await demoLogin('h-owner@test.local', 'owner')).token;
  return ownerToken;
}
async function credit(userId, amount) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`).set(auth(await owner())).send({ amount, reason: 'part8 test credit' });
  assert.equal(res.status, 200, `credit failed: ${JSON.stringify(res.body)}`);
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
async function playMatch(prefix, winnerSide, overrides = {}) {
  const made = await makeStartedRoom(prefix, overrides);
  assert.equal((await submit(made.room.id, made.creator.token, winnerSide === 'A' ? 'win' : 'lose')).status, 201);
  const confirmed = await submit(made.room.id, made.accepter.token, winnerSide === 'A' ? 'lose' : 'win');
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  return made;
}

test('site config read/change permissions and banner random order', async () => {
  const player = await demoLogin('p8-config-player@test.local', 'player');
  const read = await request(app).get('/site-config').set(auth(player.token));
  assert.equal(read.status, 200);
  assert.ok(read.body.siteConfig.buttonColor);
  const denied = await request(app).put('/site-config').set(auth(player.token)).send({ buttonColor: '#ff0000' });
  assert.equal(denied.status, 403);
  const changed = await request(app).put('/site-config').set(auth(await owner())).send({ buttonColor: '#123456', backgroundColor: '#000000', homepageText: 'Part 8 home' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.siteConfig.buttonColor, '#123456');
  const bad = await request(app).put('/site-config').set(auth(await owner())).send({ buttonColor: 'red' });
  assert.equal(bad.status, 400);
  // Banners: two active, one inactive. Active endpoint returns only active.
  const mk = async (title, sortOrder) => {
    const res = await request(app).post('/site-banners').set(auth(await owner()))
      .field('title', title).field('sortOrder', String(sortOrder)).attach('banner', PNG, 'banner.png');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.banner;
  };
  const b1 = await mk('Banner One', 1);
  const b2 = await mk('Banner Two', 2);
  const b3 = await mk('Banner Three', 3);
  const deact = await request(app).put(`/site-banners/${b3.id}`).set(auth(await owner())).send({ active: false });
  assert.equal(deact.status, 200);
  const active = await request(app).get('/site-banners/active').set(auth(player.token));
  assert.equal(active.status, 200);
  assert.deepEqual(active.body.banners.map((b) => b.id).sort(), [b1.id, b2.id].sort());
  const img = await request(app).get(`/site-banners/${b1.id}/image`).set(auth(player.token));
  assert.equal(img.status, 200);
  const playerBanner = await request(app).post('/site-banners').set(auth(player.token))
    .field('title', 'Nope').attach('banner', PNG, 'banner.png');
  assert.equal(playerBanner.status, 403);
});

test('announcement active-window filtering', async () => {
  const player = await demoLogin('p8-ann-player@test.local', 'player');
  const now = new Date();
  const past = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const pastEnd = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const futureEnd = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const expired = await request(app).post('/site-announcements').set(auth(await owner())).send({ text: 'Expired note', language: 'en', active: true, startsAt: past, endsAt: pastEnd });
  assert.equal(expired.status, 201);
  const live = await request(app).post('/site-announcements').set(auth(await owner())).send({ text: 'Live note', language: 'en', active: true, startsAt: past, endsAt: futureEnd });
  assert.equal(live.status, 201);
  const active = await request(app).get('/site-announcements/active').set(auth(player.token));
  assert.equal(active.status, 200);
  assert.ok(active.body.announcements.some((a) => a.id === live.body.announcement.id));
  assert.ok(!active.body.announcements.some((a) => a.id === expired.body.announcement.id));
  const denied = await request(app).post('/site-announcements').set(auth(player.token)).send({ text: 'Nope', language: 'en' });
  assert.equal(denied.status, 403);
});

test('terms versioning, agreement recording, and agreement gate', async () => {
  const v1 = await request(app).post('/documents').set(auth(await owner())).send({ type: 'match_rules', title: 'Rules v1', body: 'First version' });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.document.version, 1);
  const v2 = await request(app).post('/documents').set(auth(await owner())).send({ type: 'match_rules', title: 'Rules v2', body: 'Second version' });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.document.version, 2);
  const list = await request(app).get('/documents/match_rules').set(auth(await owner()));
  assert.equal(list.status, 200);
  assert.equal(list.body.documents.find((d) => d.version === 1).body, 'First version');
  const current = await request(app).get('/documents/current/match_rules').set(auth(await owner()));
  assert.equal(current.body.document.version, 2);
  // Gate off by default: accept works without agreement.
  await setSetting('agreement_required', false);
  const made = await makeRoom('p8-gateoff');
  assert.ok(made.room.id);
  // Gate on: accepter without agreement is blocked, then unblocked.
  await setSetting('agreement_required', true);
  const creator = await demoLogin('p8-gate-creator@test.local', 'player');
  const accepter = await demoLogin('p8-gate-accepter@test.local', 'player');
  await credit(creator.user.id, 10000);
  await credit(accepter.user.id, 10000);
  const ch = await request(app).post('/challenges').set(auth(creator.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201);
  const blocked = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(accepter.token));
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  const acceptDoc = await request(app).post('/agreements/accept').set(auth(accepter.token)).send({ documentId: v2.body.document.id });
  assert.equal(acceptDoc.status, 201);
  const acceptDoc2 = await request(app).post('/agreements/accept').set(auth(accepter.token)).send({ documentId: v2.body.document.id });
  assert.equal(acceptDoc2.status, 201);
  const mine = await request(app).get('/agreements/me').set(auth(accepter.token));
  assert.equal(mine.body.agreements.filter((a) => a.documentId === v2.body.document.id).length, 1);
  const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(accepter.token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await setSetting('agreement_required', false);
});

test('statistics match real counts', async () => {
  const before = await request(app).get('/admin/stats').set(auth(await owner()));
  assert.equal(before.status, 200);
  const player = await demoLogin('p8-stats-player@test.local', 'player');
  const denied = await request(app).get('/admin/stats').set(auth(player.token));
  assert.equal(denied.status, 403);
  await credit(player.user.id, 1000);
  const ch = await request(app).post('/challenges').set(auth(player.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201);
  const after = await request(app).get('/admin/stats').set(auth(await owner()));
  assert.equal(after.body.stats.openChallenges, before.body.stats.openChallenges + 1);
  assert.ok(after.body.stats.totalUsers >= before.body.stats.totalUsers);
  assert.ok(after.body.stats.generatedAt);
});

test('notification centre filters, read, mark-all and tap-through', async () => {
  const made = await makeRoom('p8-notif');
  // Ready one side: the other side gets a player_ready notification.
  const ready = await request(app).post(`/match-rooms/${made.room.id}/ready`).set(auth(made.creator.token)).send({ ready: true });
  assert.equal(ready.status, 200);
  const list = await request(app).get('/notifications?category=match').set(auth(made.accepter.token));
  assert.equal(list.status, 200);
  assert.ok(list.body.notifications.length >= 1);
  const notif = list.body.notifications.find((n) => n.type === 'player_ready');
  assert.ok(notif, JSON.stringify(list.body.notifications));
  assert.equal(notif.target.type, 'match_room');
  assert.equal(notif.target.id, made.room.id);
  const unread = await request(app).get('/notifications/unread-count').set(auth(made.accepter.token));
  assert.ok(unread.body.unreadCount >= 1);
  const markOne = await request(app).post(`/notifications/${notif.id}/read`).set(auth(made.accepter.token));
  assert.equal(markOne.status, 200);
  const unreadList = await request(app).get('/notifications?read=false').set(auth(made.accepter.token));
  assert.ok(!unreadList.body.notifications.some((n) => n.id === notif.id));
  const markAll = await request(app).post('/notifications/read-all').set(auth(made.accepter.token));
  assert.equal(markAll.status, 200);
  const after = await request(app).get('/notifications/unread-count').set(auth(made.accepter.token));
  assert.equal(after.body.unreadCount, 0);
  // Another user's notifications are not visible: a fresh user has none of these.
  const other = await demoLogin('p8-notif-other@test.local', 'player');
  const otherList = await request(app).get('/notifications').set(auth(other.token));
  assert.ok(!otherList.body.notifications.some((n) => n.id === notif.id));
});

test('tournament start and dispute resolved notifications carry targets', async () => {
  // Tournament start.
  const p1 = await demoLogin('p8-tn-p1@test.local', 'player');
  const p2 = await demoLogin('p8-tn-p2@test.local', 'player');
  const now = new Date();
  const tourney = await request(app).post('/tournaments').set(auth(await owner())).send({
    name: 'Part 8 Cup', prizeDescription: 'Test', prizeCoins: 0, rules: 'Rules',
    registrationStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    registrationEnd: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    startTime: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    mode: 'solo', teamSize: '1v1', maxRegistrants: null,
  });
  assert.equal(tourney.status, 201, JSON.stringify(tourney.body));
  const tid = tourney.body.tournament.id;
  assert.equal((await request(app).post(`/tournaments/${tid}/open-registration`).set(auth(await owner()))).status, 200);
  assert.equal((await request(app).post(`/tournaments/${tid}/register`).set(auth(p1.token))).status, 201);
  assert.equal((await request(app).post(`/tournaments/${tid}/register`).set(auth(p2.token))).status, 201);
  assert.equal((await request(app).post(`/tournaments/${tid}/start`).set(auth(await owner()))).status, 200);
  const tn = await request(app).get('/notifications?category=tournament').set(auth(p1.token));
  const started = tn.body.notifications.find((n) => n.type === 'tournament_started');
  assert.ok(started, JSON.stringify(tn.body.notifications));
  assert.equal(started.target.type, 'tournament');
  assert.equal(started.target.id, tid);
  // Dispute resolved.
  const made = await makeStartedRoom('p8-dispute');
  assert.equal((await submit(made.room.id, made.creator.token, 'win')).status, 201);
  assert.equal((await submit(made.room.id, made.accepter.token, 'win')).status, 201);
  const disputeRes = await request(app).get(`/match-rooms/${made.room.id}/dispute`).set(auth(made.creator.token));
  assert.equal(disputeRes.status, 200);
  const disputeId = disputeRes.body.id;
  const decision = await request(app).post(`/disputes/${disputeId}/decision`).set(auth(await owner())).send({ decision: 'winner', winnerSide: 'A', reason: 'Evidence reviewed' });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  const dn = await request(app).get('/notifications?category=dispute').set(auth(made.accepter.token));
  const decided = dn.body.notifications.find((n) => n.type === 'dispute_decided');
  assert.ok(decided, JSON.stringify(dn.body.notifications));
  assert.equal(decided.target.type, 'dispute');
  assert.equal(decided.target.id, disputeId);
});

test('referral commission notification on a win with fee', async () => {
  await setSetting('fee.Classic', { type: 'percent', value: 10 });
  const referrer = await demoLogin('p8-ref-referrer@test.local', 'player');
  const invitee = await demoLogin('p8-ref-invitee@test.local', 'player', referrer.user.referralCode);
  const opponent = await demoLogin('p8-ref-opponent@test.local', 'player');
  await credit(invitee.user.id, 20000);
  await credit(opponent.user.id, 20000);
  const ch = await request(app).post('/challenges').set(auth(invitee.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 5000, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201);
  const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(opponent.token));
  assert.equal(ok.status, 200);
  const roomId = ok.body.matchRoom.id;
  const tokensById = { [invitee.user.id]: invitee.token, [opponent.user.id]: opponent.token };
  await setSetting('match.result_window_seconds', 1);
  await startRoom(ok.body.matchRoom, tokensById);
  await setSetting('match.result_window_seconds', 300);
  await sleep(1200);
  assert.equal((await submit(roomId, invitee.token, 'win')).status, 201);
  assert.equal((await submit(roomId, opponent.token, 'lose')).status, 201);
  // Fee: pot 10000 at 10% = 1000, commission 1% of fee = 10.
  const rn = await request(app).get('/notifications?category=referral').set(auth(referrer.token));
  const comm = rn.body.notifications.find((n) => n.type === 'referral_commission_received');
  assert.ok(comm, JSON.stringify(rn.body.notifications));
  assert.equal(comm.target.type, 'match_room');
  const dash = await request(app).get('/referrals/me').set(auth(referrer.token));
  assert.ok(dash.body.totalEarnings >= 10, JSON.stringify(dash.body));
  await setSetting('fee.Classic', { type: 'percent', value: 0 });
});

test('telegram test without token, two-step announce, and webhook admin-only', async () => {
  const denied = await request(app).post('/admin/telegram/test').set(auth(await owner()));
  assert.equal(denied.status, 503, JSON.stringify(denied.body));
  const pending = await request(app).post('/admin/telegram/announce').set(auth(await owner())).send({ text: 'Telegram test announcement', language: 'en' });
  assert.equal(pending.status, 201);
  const pid = pending.body.announcement.id;
  const code = pending.body.announcement.confirmationCode;
  assert.ok(code);
  const wrong = await request(app).post(`/admin/telegram/announce/${pid}/confirm`).set(auth(await owner())).send({ confirmationCode: '000000' });
  assert.equal(wrong.status, 400);
  const stillPending = await request(app).get('/site-announcements/active').set(auth(await owner()));
  assert.ok(!stillPending.body.announcements.some((a) => a.text === 'Telegram test announcement'));
  const confirmed = await request(app).post(`/admin/telegram/announce/${pid}/confirm`).set(auth(await owner())).send({ confirmationCode: code });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.telegramStatus, 'not_configured');
  const published = await request(app).get('/site-announcements/active').set(auth(await owner()));
  assert.ok(published.body.announcements.some((a) => a.text === 'Telegram test announcement'));
  // Webhook: configure admin chat + secret, no token.
  const cfg = await request(app).post('/admin/telegram/config').set(auth(await owner())).send({ adminChatId: '123', webhookSecret: 'secret123' });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.telegram.configured, false);
  const noSecret = await request(app).post('/telegram/webhook').send({ message: { chat: { id: 123 }, text: '/stats' } });
  assert.equal(noSecret.status, 403);
  const wrongChat = await request(app).post('/telegram/webhook').set('x-telegram-bot-api-secret-token', 'secret123').send({ message: { chat: { id: 999 }, text: '/stats' } });
  assert.equal(wrongChat.status, 200);
  assert.ok(wrongChat.body.reply.includes('only serves'));
  const adminChat = await request(app).post('/telegram/webhook').set('x-telegram-bot-api-secret-token', 'secret123').send({ message: { chat: { id: 123 }, text: '/stats' } });
  assert.equal(adminChat.status, 200);
  assert.ok(adminChat.body.reply.includes('Users:'));
  assert.equal(adminChat.body.delivery, 'not_configured');
});

test('maintenance blocks player writes but not admin routes or started rooms', async () => {
  const started = await makeStartedRoom('p8-maint');
  const player = await demoLogin('p8-maint-player@test.local', 'player');
  await credit(player.user.id, 1000);
  const first = await request(app).post('/admin/maintenance').set(auth(await owner())).send({ enabled: true, message: 'Site under maintenance', reason: 'Part 8 test' });
  let enabled = first;
  if (first.status === 409) {
    assert.equal(first.body.requiresConfirm, true);
    enabled = await request(app).post('/admin/maintenance').set(auth(await owner())).send({ enabled: true, message: 'Site under maintenance', reason: 'Part 8 test', confirm: true });
  }
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const blocked = await request(app).post('/challenges').set(auth(player.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(blocked.status, 503);
  assert.ok(blocked.body.message.includes('maintenance'));
  const adminOk = await request(app).get('/admin/settings').set(auth(await owner()));
  assert.equal(adminOk.status, 200);
  const roomOk = await request(app).get(`/match-rooms/${started.room.id}`).set(auth(started.creator.token));
  assert.equal(roomOk.status, 200);
  assert.equal(roomOk.body.status, 'started');
  const off = await request(app).post('/admin/maintenance').set(auth(await owner())).send({ enabled: false, reason: 'Part 8 test done' });
  assert.equal(off.status, 200);
  const after = await request(app).post('/challenges').set(auth(player.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(after.status, 201, JSON.stringify(after.body));
});

test('emergency blocks writes, pauses referral crediting, but not result flows', async () => {
  await setSetting('fee.Classic', { type: 'percent', value: 10 });
  const referrer = await demoLogin('p8-emg-referrer@test.local', 'player');
  const invitee = await demoLogin('p8-emg-invitee@test.local', 'player', referrer.user.referralCode);
  const opponent = await demoLogin('p8-emg-opponent@test.local', 'player');
  await credit(invitee.user.id, 20000);
  await credit(opponent.user.id, 20000);
  const ch = await request(app).post('/challenges').set(auth(invitee.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 5000, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  });
  assert.equal(ch.status, 201);
  const ok = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(opponent.token));
  assert.equal(ok.status, 200);
  const roomId = ok.body.matchRoom.id;
  const tokensById = { [invitee.user.id]: invitee.token, [opponent.user.id]: opponent.token };
  await setSetting('match.result_window_seconds', 1);
  await startRoom(ok.body.matchRoom, tokensById);
  await setSetting('match.result_window_seconds', 300);
  await sleep(1200);
  const noConfirm = await request(app).post('/admin/emergency').set(auth(await owner())).send({ enabled: true, reason: 'Part 8 test' });
  assert.equal(noConfirm.status, 409);
  const on = await request(app).post('/admin/emergency').set(auth(await owner())).send({ enabled: true, reason: 'Part 8 test', confirm: true });
  assert.equal(on.status, 200);
  const player = await demoLogin('p8-emg-player@test.local', 'player');
  assert.equal((await request(app).post('/challenges').set(auth(player.token)).send({
    arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' },
  })).status, 503);
  assert.equal((await request(app).post('/wallet/purchases').set(auth(player.token)).send({ customCoins: 100 })).status, 503);
  assert.equal((await request(app).post('/referrals/attach').set(auth(player.token)).send({ referralCode: referrer.user.referralCode })).status, 503);
  // Result flow is not blocked by the guard: submitting to the started
  // room succeeds (settlement runs, but referral crediting pauses).
  assert.equal((await submit(roomId, invitee.token, 'win')).status, 201);
  assert.equal((await submit(roomId, opponent.token, 'lose')).status, 201);
  const dash = await request(app).get('/referrals/me').set(auth(referrer.token));
  const pending = dash.body.commissions.find((c) => c.roomId === roomId);
  assert.ok(pending, JSON.stringify(dash.body.commissions));
  assert.equal(pending.status, 'pending');
  const off = await request(app).post('/admin/emergency').set(auth(await owner())).send({ enabled: false, reason: 'Part 8 test done' });
  assert.equal(off.status, 200);
  await setSetting('fee.Classic', { type: 'percent', value: 0 });
});

test('backups, health, and sweeper', async () => {
  const backup = await request(app).post('/admin/backups').set(auth(await owner()));
  assert.equal(backup.status, 201, JSON.stringify(backup.body));
  assert.ok(backup.body.backup.note.includes('NOT inside'));
  const list = await request(app).get('/admin/backups').set(auth(await owner()));
  assert.ok(list.body.backups.some((b) => b.id === backup.body.backup.id));
  const download = await request(app).get(`/admin/backups/${backup.body.backup.id}/download`).set(auth(await owner()));
  assert.equal(download.status, 200);
  const player = await demoLogin('p8-backup-player@test.local', 'player');
  assert.equal((await request(app).get('/admin/backups').set(auth(player.token))).status, 403);
  // No API restore by design.
  assert.equal((await request(app).post(`/admin/backups/${backup.body.backup.id}/restore`).set(auth(await owner()))).status, 404);
  const health = await request(app).get('/admin/health').set(auth(await owner()));
  assert.equal(health.status, 200);
  assert.equal(health.body.health.status, 'ok');
  assert.ok(health.body.health.lastBackupAt);
  assert.equal(health.body.health.maintenance.enabled, false);
  assert.equal(health.body.health.emergency.enabled, false);
  // Sweeper: a waiting room with a 1-second ready timeout.
  await setSetting('match.ready_timeout_seconds', 1);
  const waiting = await makeRoom('p8-sweep');
  await sleep(1200);
  const sweep = await request(app).post('/admin/sweep').set(auth(await owner()));
  assert.equal(sweep.status, 200);
  assert.ok(sweep.body.sweep.roomsCancelledByTimeout >= 1, JSON.stringify(sweep.body.sweep));
  const roomAfter = await request(app).get(`/match-rooms/${waiting.room.id}`).set(auth(waiting.creator.token));
  assert.equal(roomAfter.body.status, 'cancelled');
  await setSetting('match.ready_timeout_seconds', 300);
});

test('help articles and support ticket thread and status rules', async () => {
  const player = await demoLogin('p8-help-player@test.local', 'player');
  const support = await demoLogin('p8-help-support@test.local', 'support');
  const article = await request(app).post('/help-articles').set(auth(await owner())).send({ category: 'account', title: 'How to login', body: 'Use Google login.', published: false });
  assert.equal(article.status, 201);
  const playerList = await request(app).get('/help-articles').set(auth(player.token));
  assert.ok(!playerList.body.articles.some((a) => a.id === article.body.article.id));
  const staffList = await request(app).get('/help-articles').set(auth(await owner()));
  assert.ok(staffList.body.articles.some((a) => a.id === article.body.article.id));
  const pub = await request(app).put(`/help-articles/${article.body.article.id}`).set(auth(await owner())).send({ published: true });
  assert.equal(pub.status, 200);
  const playerList2 = await request(app).get('/help-articles').set(auth(player.token));
  assert.ok(playerList2.body.articles.some((a) => a.id === article.body.article.id));
  const ticket = await request(app).post('/tickets').set(auth(player.token)).send({ subject: 'Match issue', category: 'technical', message: 'My match froze.' });
  assert.equal(ticket.status, 201);
  const tid = ticket.body.ticket.id;
  assert.equal((await request(app).post(`/tickets/${tid}/messages`).set(auth(support.token)).send({ message: 'We are looking into it.' })).status, 200);
  assert.equal((await request(app).post(`/tickets/${tid}/messages`).set(auth(player.token)).send({ message: 'Thank you.' })).status, 200);
  const other = await demoLogin('p8-help-other@test.local', 'player');
  assert.equal((await request(app).get(`/tickets/${tid}`).set(auth(other.token))).status, 403);
  const resolved = await request(app).post(`/tickets/${tid}/status`).set(auth(support.token)).send({ status: 'resolved' });
  assert.equal(resolved.status, 200);
  // Player cannot reopen even with a reason; staff can reopen with a reason.
  assert.equal((await request(app).post(`/tickets/${tid}/status`).set(auth(player.token)).send({ status: 'open', reason: 'Please reopen' })).status, 403);
  const reopenNoReason = await request(app).post(`/tickets/${tid}/status`).set(auth(support.token)).send({ status: 'open' });
  assert.equal(reopenNoReason.status, 400);
  const reopened = await request(app).post(`/tickets/${tid}/status`).set(auth(support.token)).send({ status: 'open', reason: 'Needs more info' });
  assert.equal(reopened.status, 200);
  const closed = await request(app).post(`/tickets/${tid}/status`).set(auth(player.token)).send({ status: 'closed' });
  assert.equal(closed.status, 200);
});

test('suspicious groups list shared MLBB IDs without auto-banning', async () => {
  const u1 = await demoLogin('p8-susp-1@test.local', 'player');
  const u2 = await demoLogin('p8-susp-2@test.local', 'player');
  assert.equal((await request(app).put('/profile/game-ids').set(auth(u1.token)).send({ mlbbId: '1234567', serverId: '1234' })).status, 200);
  assert.equal((await request(app).put('/profile/game-ids').set(auth(u2.token)).send({ mlbbId: '1234567', serverId: '1234' })).status, 200);
  const groups = await request(app).get('/admin/suspicious').set(auth(await owner()));
  assert.equal(groups.status, 200);
  const shared = groups.body.groups.find((g) => g.reason === 'shared_mlbb_id' && g.users.some((u) => u.id === u1.user.id) && g.users.some((u) => u.id === u2.user.id));
  assert.ok(shared, JSON.stringify(groups.body.groups));
  const player = await demoLogin('p8-susp-player@test.local', 'player');
  assert.equal((await request(app).get('/admin/suspicious').set(auth(player.token))).status, 403);
  // Neither user was auto-banned by the listing.
  const check1 = await request(app).get(`/admin/users/${u1.user.id}`).set(auth(await owner()));
  assert.equal(check1.body.user.status, 'active');
  const check2 = await request(app).get(`/admin/users/${u2.user.id}`).set(auth(await owner()));
  assert.equal(check2.body.user.status, 'active');
});
