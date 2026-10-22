'use strict';
// Part 1 automated tests. One shared app/DB for the main flow, plus a
// separate production-configured app to prove demo login is disabled
// there. The DB is a throwaway file under /tmp, never the real data dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { closeDb } = require('../src/db');
const { totpCode } = require('../src/auth/totp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part1-'));
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

test('health and landing page work', async () => {
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.moneyMovementEnabled, false);
  const home = await request(app).get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Match Arena/);
});

test('demo login works in dev/test, validation rejects bad input', async () => {
  const player = await demoLogin('player1@test.local', 'player');
  assert.equal(player.user.role, 'player');
  assert.equal(player.demo, true);
  const bad = await request(app).post('/auth/demo').send({ email: 'not-an-email', role: 'player' });
  assert.equal(bad.status, 400);
  const badRole = await request(app).post('/auth/demo').send({ email: 'x@test.local', role: 'superuser' });
  assert.equal(badRole.status, 400);
  const bot = await request(app).post('/auth/demo').send({ email: 'bot@test.local', role: 'player', website: 'http://spam.example' });
  assert.equal(bot.status, 400);
});

test('unauthenticated users cannot reach protected routes', async () => {
  assert.equal((await request(app).get('/auth/me')).status, 401);
  assert.equal((await request(app).get('/admin/settings')).status, 401);
  assert.equal((await request(app).get('/admin/audit-log')).status, 401);
});

test('player cannot reach admin routes or change settings', async () => {
  const player = await demoLogin('player2@test.local', 'player');
  const auth = { Authorization: `Bearer ${player.token}` };
  assert.equal((await request(app).get('/admin/settings').set(auth)).status, 403);
  assert.equal((await request(app).get('/admin/audit-log').set(auth)).status, 403);
  assert.equal((await request(app).put('/admin/settings/platform_name').set(auth).send({ value: 'Hacked' })).status, 403);
  assert.equal((await request(app).get('/admin/users').set(auth)).status, 403);
});

test('settings defaults record the user-stated legal status and no money movement', async () => {
  const owner = await demoLogin('owner1@test.local', 'owner');
  const res = await request(app).get('/admin/settings').set({ Authorization: `Bearer ${owner.token}` });
  assert.equal(res.status, 200);
  const byKey = Object.fromEntries(res.body.settings.map((s) => [s.key, s.value]));
  assert.equal(byKey.money_movement_enabled, false);
  assert.equal(byKey.paid_entry_enabled, false);
  assert.equal(byKey.withdrawals_enabled, false);
  assert.equal(byKey.legal_approval.status, 'lawyer_consulted');
  assert.equal(byKey.legal_approval.contract, 'in_progress');
  assert.equal(byKey.legal_approval.permission_given_by_user, true);
  // Nothing invented: no lawyer or contract name/date in the record.
  assert.equal(JSON.stringify(byKey.legal_approval).includes('202'), false);
});

test('owner can change a general setting and it is audit-logged; moderator cannot change fee/wallet/legal settings', async () => {
  const owner = await demoLogin('owner2@test.local', 'owner');
  const mod = await demoLogin('mod1@test.local', 'moderator');
  const ownerAuth = { Authorization: `Bearer ${owner.token}` };
  const modAuth = { Authorization: `Bearer ${mod.token}` };

  const changed = await request(app).put('/admin/settings/platform_tagline').set(ownerAuth).send({ value: 'Part 1 test tagline' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.value, 'Part 1 test tagline');

  // Fee/wallet keys are owner-only: moderator (and, by the matrix, admin) are denied.
  for (const [key, value] of [['money_movement_enabled', false], ['paid_entry_enabled', false], ['withdrawals_enabled', false], ['fee_policy_note', 'test note']]) {
    const res = await request(app).put(`/admin/settings/${key}`).set(modAuth).send({ value });
    assert.equal(res.status, 403, `moderator should be denied ${key}, got ${res.status}`);
  }
  // legal_approval is a recorded statement, never editable through this endpoint (for anyone).
  const legalEdit = await request(app).put('/admin/settings/legal_approval').set(ownerAuth).send({ value: {} });
  assert.equal(legalEdit.status, 400);
  // Owner also cannot switch money movement on in Part 1.
  const moneyOn = await request(app).put('/admin/settings/money_movement_enabled').set(ownerAuth).send({ value: true });
  assert.equal(moneyOn.status, 400);
  const unknown = await request(app).put('/admin/settings/not_a_setting').set(ownerAuth).send({ value: 1 });
  assert.equal(unknown.status, 400);

  const audit = await request(app).get('/admin/audit-log?action=setting.updated').set(ownerAuth);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.some((e) => e.targetId === 'platform_tagline' && e.actorEmail === 'owner2@test.local'));
});

test('role changes are owner-only and audit-logged; admin cannot promote', async () => {
  const owner = await demoLogin('owner3@test.local', 'owner');
  const admin = await demoLogin('admin1@test.local', 'admin');
  const target = await demoLogin('target1@test.local', 'player');
  const adminAuth = { Authorization: `Bearer ${admin.token}` };
  const ownerAuth = { Authorization: `Bearer ${owner.token}` };

  const denied = await request(app).put(`/admin/users/${target.user.id}/role`).set(adminAuth).send({ role: 'support' });
  assert.equal(denied.status, 403);

  const changed = await request(app).put(`/admin/users/${target.user.id}/role`).set(ownerAuth).send({ role: 'support' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.role, 'support');

  const selfChange = await request(app).put(`/admin/users/${owner.user.id}/role`).set(ownerAuth).send({ role: 'player' });
  assert.equal(selfChange.status, 400);

  const audit = await request(app).get('/admin/audit-log?action=user.role_changed').set(ownerAuth);
  assert.ok(audit.body.entries.some((e) => e.targetId === String(target.user.id)));
});

test('moderator can ban/unban, banned users cannot log in, player cannot ban', async () => {
  const mod = await demoLogin('mod2@test.local', 'moderator');
  const victim = await demoLogin('victim1@test.local', 'player');
  const player = await demoLogin('player3@test.local', 'player');
  const modAuth = { Authorization: `Bearer ${mod.token}` };

  const denied = await request(app).post(`/admin/users/${victim.user.id}/ban`).set({ Authorization: `Bearer ${player.token}` });
  assert.equal(denied.status, 403);

  const banned = await request(app).post(`/admin/users/${victim.user.id}/ban`).set(modAuth);
  assert.equal(banned.status, 200);
  assert.equal(banned.body.user.status, 'banned');

  const relogin = await request(app).post('/auth/demo').send({ email: 'victim1@test.local', role: 'player' });
  assert.equal(relogin.status, 403);

  const unbanned = await request(app).post(`/admin/users/${victim.user.id}/unban`).set(modAuth);
  assert.equal(unbanned.status, 200);
  assert.equal(unbanned.body.user.status, 'active');
});

test('admin 2FA: setup, enable with a real code, login challenge, wrong code rejected, disable', async () => {
  const admin = await demoLogin('admin2@test.local', 'admin');
  const auth = { Authorization: `Bearer ${admin.token}` };

  const setup = await request(app).post('/auth/2fa/setup').set(auth);
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUrl, /otpauth:\/\/totp/);
  assert.equal(typeof setup.body.secret, 'string');

  // Player cannot set up 2FA (staff permission only).
  const player = await demoLogin('player4@test.local', 'player');
  assert.equal((await request(app).post('/auth/2fa/setup').set({ Authorization: `Bearer ${player.token}` })).status, 403);

  const enableWrong = await request(app).post('/auth/2fa/enable').set(auth).send({ code: '000000' });
  assert.equal(enableWrong.status, 400);

  const enable = await request(app).post('/auth/2fa/enable').set(auth).send({ code: totpCode(setup.body.secret) });
  assert.equal(enable.status, 200);

  // Next login must present a 2FA challenge, not an access token.
  const challenged = await request(app).post('/auth/demo').send({ email: 'admin2@test.local', role: 'admin' });
  assert.equal(challenged.status, 200);
  assert.equal(challenged.body.twoFactorRequired, true);
  assert.ok(challenged.body.tempToken);

  const wrong = await request(app).post('/auth/2fa/verify').send({ tempToken: challenged.body.tempToken, code: '000000' });
  assert.equal(wrong.status, 401);

  const verified = await request(app).post('/auth/2fa/verify').send({ tempToken: challenged.body.tempToken, code: totpCode(setup.body.secret) });
  assert.equal(verified.status, 200);
  assert.ok(verified.body.token);

  // A challenge token cannot be used as an access token.
  assert.equal((await request(app).get('/auth/me').set({ Authorization: `Bearer ${challenged.body.tempToken}` })).status, 401);

  const disable = await request(app).post('/auth/2fa/disable').set({ Authorization: `Bearer ${verified.body.token}` }).send({ code: totpCode(setup.body.secret) });
  assert.equal(disable.status, 200);
});

test('logout revokes the session; audit log is read-only for players and staff can view it', async () => {
  const player = await demoLogin('player5@test.local', 'player');
  const auth = { Authorization: `Bearer ${player.token}` };
  assert.equal((await request(app).get('/auth/me').set(auth)).status, 200);
  assert.equal((await request(app).post('/auth/logout').set(auth)).status, 200);
  assert.equal((await request(app).get('/auth/me').set(auth)).status, 401);

  const owner = await demoLogin('owner4@test.local', 'owner');
  const audit = await request(app).get('/admin/audit-log').set({ Authorization: `Bearer ${owner.token}` });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.total > 0);
  assert.ok(audit.body.entries.every((e) => e.action && e.createdAt));
});

test('demo login is disabled in production mode', async () => {
  closeDb();
  const prodDb = path.join(tmpDir, 'prod.sqlite');
  const prodConfig = {
    ...loadConfig({ ...process.env, NODE_ENV: 'production', JWT_SECRET: 'test-production-secret-do-not-use', DB_PATH: prodDb }),
    demoLoginEnabled: false,
  };
  const prodApp = createApp(prodConfig);
  const res = await request(prodApp).post('/auth/demo').send({ email: 'prod@test.local', role: 'player' });
  assert.equal(res.status, 403);
  const googleUnconfigured = await request(prodApp).get('/auth/google');
  assert.equal(googleUnconfigured.status, 503);
  closeDb();
});
