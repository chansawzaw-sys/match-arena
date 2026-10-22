'use strict';
// Part 2 automated tests: coin wallet ledger, packages, purchase flow,
// lock lifecycle, permissions and the Part 1 money guard. One throwaway
// SQLite file under /tmp, never the real data directory. The lock
// functions are internal (no public lock endpoint exists by design), so
// they are exercised by importing the wallet service directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const walletService = require('../src/services/wallet');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part2-'));
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

test('a new wallet starts at zero and has empty history', async () => {
  const player = await demoLogin('w-player1@test.local', 'player');
  const res = await request(app).get('/wallet/me').set(auth(player.token));
  assert.equal(res.status, 200);
  assert.deepEqual(
    { available: res.body.balance.available, locked: res.body.balance.locked, total: res.body.balance.total },
    { available: 0, locked: 0, total: 0 },
  );
  const history = await request(app).get('/wallet/me/history').set(auth(player.token));
  assert.equal(history.body.total, 0);
  assert.deepEqual(history.body.entries, []);
});

test('balances never go negative and owner adjustments are audit-logged', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const player = await demoLogin('w-player1@test.local', 'player');
  const denied = await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: -100, reason: 'debit an empty wallet' });
  assert.equal(denied.status, 400);
  const credited = await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 500, reason: 'test credit' });
  assert.equal(credited.status, 200);
  assert.equal(credited.body.balance.available, 500);
  assert.equal(credited.body.entry.type, 'admin_adjustment');
  assert.equal(credited.body.entry.balanceAvailableAfter, 500);
  assert.ok(credited.body.entry.transactionId);
  const audit = await request(app).get('/admin/audit-log?action=wallet.adjusted').set(auth(owner.token));
  assert.ok(audit.body.entries.some((e) => e.targetId === String(player.user.id)));
});

test('an idempotent adjustment is not applied twice', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const player = await demoLogin('w-player1@test.local', 'player');
  const first = await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 200, reason: 'idempotency test', idempotencyKey: 'adj-test-1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.balance.available, 700);
  const replay = await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 200, reason: 'idempotency test', idempotencyKey: 'adj-test-1' });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.entry.transactionId, first.body.entry.transactionId);
  assert.equal(replay.body.balance.available, 700);
  // And a zero / missing-reason adjustment is rejected, not recorded.
  assert.equal((await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 0, reason: 'zero' })).status, 400);
  assert.equal((await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 10, reason: '' })).status, 400);
});

test('package purchase: approve credits once, re-approve is rejected', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const admin = await demoLogin('w-admin1@test.local', 'admin');
  const player = await demoLogin('w-player1@test.local', 'player');
  const created = await request(app).post('/wallet/packages')
    .set(auth(owner.token)).send({ name: 'Starter', coins: 1000, priceAmount: 5000, priceCurrency: 'MMK' });
  assert.equal(created.status, 201);
  const pkg = created.body.package;
  const listed = await request(app).get('/wallet/packages').set(auth(player.token));
  assert.ok(listed.body.packages.some((p) => p.id === pkg.id && p.active));
  const reqRes = await request(app).post('/wallet/purchases')
    .set(auth(player.token)).send({ packageId: pkg.id });
  assert.equal(reqRes.status, 201);
  assert.equal(reqRes.body.purchase.status, 'pending');
  assert.equal(reqRes.body.purchase.coins, 1000);
  assert.equal(reqRes.body.purchase.priceAmount, 5000);
  const approved = await request(app).post(`/wallet/purchases/${reqRes.body.purchase.id}/decision`)
    .set(auth(admin.token)).send({ decision: 'approve' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.purchase.status, 'completed');
  assert.equal(approved.body.entry.type, 'purchase_credit');
  const balance = await request(app).get('/wallet/me').set(auth(player.token));
  assert.equal(balance.body.balance.available, 1700); // 700 before + 1000
  const again = await request(app).post(`/wallet/purchases/${reqRes.body.purchase.id}/decision`)
    .set(auth(admin.token)).send({ decision: 'approve' });
  assert.equal(again.status, 409);
  const after = await request(app).get('/wallet/me').set(auth(player.token));
  assert.equal(after.body.balance.available, 1700);
  // Moderators may not decide purchases.
  const mod = await demoLogin('w-mod1@test.local', 'moderator');
  const req2 = await request(app).post('/wallet/purchases').set(auth(player.token)).send({ packageId: pkg.id });
  assert.equal((await request(app).post(`/wallet/purchases/${req2.body.purchase.id}/decision`)
    .set(auth(mod.token)).send({ decision: 'approve' })).status, 403);
  return { pkgId: pkg.id, playerToken: player.token, ownerToken: owner.token };
});

test('rejected purchases leave the balance untouched and record the reason', async () => {
  const admin = await demoLogin('w-admin1@test.local', 'admin');
  const player = await demoLogin('w-player2@test.local', 'player');
  const reqRes = await request(app).post('/wallet/purchases')
    .set(auth(player.token)).send({ customCoins: 500 });
  assert.equal(reqRes.status, 201);
  const rejected = await request(app).post(`/wallet/purchases/${reqRes.body.purchase.id}/decision`)
    .set(auth(admin.token)).send({ decision: 'reject', reason: 'payment not received' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.purchase.status, 'rejected');
  assert.equal(rejected.body.purchase.decisionReason, 'payment not received');
  assert.equal(rejected.body.entry, null);
  const balance = await request(app).get('/wallet/me').set(auth(player.token));
  assert.equal(balance.body.balance.available, 0);
  // Rejection without a reason is rejected, and a decided purchase cannot be decided again.
  const req2 = await request(app).post('/wallet/purchases').set(auth(player.token)).send({ customCoins: 500 });
  assert.equal((await request(app).post(`/wallet/purchases/${req2.body.purchase.id}/decision`)
    .set(auth(admin.token)).send({ decision: 'reject' })).status, 400);
  assert.equal((await request(app).post(`/wallet/purchases/${reqRes.body.purchase.id}/decision`)
    .set(auth(admin.token)).send({ decision: 'approve' })).status, 409);
});

test('custom amount validation: zero, negative, over max, both, neither', async () => {
  const player = await demoLogin('w-player3@test.local', 'player');
  const h = auth(player.token);
  for (const body of [{ customCoins: 0 }, { customCoins: -50 }, { customCoins: 100001 }]) {
    assert.equal((await request(app).post('/wallet/purchases').set(h).send(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request(app).post('/wallet/purchases').set(h).send({})).status, 400);
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const pkg = await request(app).post('/wallet/packages')
    .set(auth(owner.token)).send({ name: 'Both', coins: 100, priceAmount: 100, priceCurrency: 'MMK' });
  assert.equal((await request(app).post('/wallet/purchases').set(h)
    .send({ packageId: pkg.body.package.id, customCoins: 200 })).status, 400);
  // Unknown package and inactive package are rejected.
  assert.equal((await request(app).post('/wallet/purchases').set(h).send({ packageId: 999999 })).status, 404);
  await request(app).put(`/wallet/packages/${pkg.body.package.id}`).set(auth(owner.token)).send({ active: false });
  assert.equal((await request(app).post('/wallet/purchases').set(h).send({ packageId: pkg.body.package.id })).status, 400);
  const listed = await request(app).get('/wallet/packages').set(h);
  assert.ok(!listed.body.packages.some((p) => p.id === pkg.body.package.id));
});

test('editing a package does not change a completed purchase snapshot', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const player = await demoLogin('w-player1@test.local', 'player');
  const created = await request(app).post('/wallet/packages')
    .set(auth(owner.token)).send({ name: 'Snapshot', coins: 1000, priceAmount: 5000, priceCurrency: 'MMK' });
  const reqRes = await request(app).post('/wallet/purchases').set(auth(player.token)).send({ packageId: created.body.package.id });
  await request(app).post(`/wallet/purchases/${reqRes.body.purchase.id}/decision`)
    .set(auth(owner.token)).send({ decision: 'approve' });
  const edited = await request(app).put(`/wallet/packages/${created.body.package.id}`)
    .set(auth(owner.token)).send({ coins: 9999, priceAmount: 9999 });
  assert.equal(edited.body.package.coins, 9999);
  const mine = await request(app).get('/wallet/me/purchases').set(auth(player.token));
  const completed = mine.body.purchases.find((p) => p.id === reqRes.body.purchase.id);
  assert.equal(completed.coins, 1000);
  assert.equal(completed.priceAmount, 5000);
  assert.equal(completed.status, 'completed');
  // A new request after the edit snapshots the new values.
  const fresh = await request(app).post('/wallet/purchases').set(auth(player.token)).send({ packageId: created.body.package.id });
  assert.equal(fresh.body.purchase.coins, 9999);
  assert.equal(fresh.body.purchase.priceAmount, 9999);
});

test('lock lifecycle through the internal service: lock, unlock, refund, consume', async () => {
  const player = await demoLogin('w-player1@test.local', 'player');
  const id = player.user.id;
  // Balance after the earlier tests: 1700 + 1000 (snapshot approve) = 2700 available, 0 locked.
  // (The pending 'fresh' request from the previous test is not yet approved.)
  let balance = walletService.getBalance(id);
  assert.equal(balance.available, 2700);
  assert.equal(balance.locked, 0);
  let r = walletService.lockCoins({ userId: id, amount: 400, reference: 'match:test-1', reason: 'match stake' });
  assert.equal(r.balance.available, 2300);
  assert.equal(r.balance.locked, 400);
  assert.equal(r.entry.type, 'lock');
  assert.throws(() => walletService.lockCoins({ userId: id, amount: 5000, reference: 'match:test-1', reason: 'too much' }), /Insufficient available/);
  r = walletService.unlockCoins({ userId: id, amount: 150, reference: 'match:test-1', reason: 'partial release' });
  assert.deepEqual([r.balance.available, r.balance.locked], [2450, 250]);
  r = walletService.refundLockedCoins({ userId: id, amount: 250, reference: 'match:test-1', reason: 'match cancelled' });
  assert.deepEqual([r.balance.available, r.balance.locked], [2700, 0]);
  assert.equal(r.entry.type, 'refund');
  walletService.lockCoins({ userId: id, amount: 300, reference: 'match:test-2', reason: 'match stake' });
  r = walletService.consumeLockedCoins({ userId: id, amount: 300, reference: 'match:test-2', reason: 'match settled' });
  assert.deepEqual([r.balance.available, r.balance.locked, r.balance.total], [2400, 0, 2400]);
  // Idempotent lock replay applies nothing twice.
  const first = walletService.lockCoins({ userId: id, amount: 100, reference: 'match:test-3', reason: 'stake', idempotencyKey: 'lock-k1' });
  const replay = walletService.lockCoins({ userId: id, amount: 100, reference: 'match:test-3', reason: 'stake', idempotencyKey: 'lock-k1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.transactionId, first.entry.transactionId);
  assert.deepEqual([walletService.getBalance(id).available, walletService.getBalance(id).locked], [2300, 100]);
  // History is filterable by type and has no edit/delete route.
  const history = await request(app).get('/wallet/me/history?type=lock').set(auth(player.token));
  assert.ok(history.body.entries.every((e) => e.type === 'lock'));
  assert.ok(history.body.total >= 3);
  assert.equal((await request(app).delete('/wallet/me/history').set(auth(player.token))).status, 404);
});

test('only the owner adjusts balances directly; admin cannot', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const admin = await demoLogin('w-admin1@test.local', 'admin');
  const mod = await demoLogin('w-mod1@test.local', 'moderator');
  const player = await demoLogin('w-player4@test.local', 'player');
  for (const token of [admin.token, mod.token, player.token]) {
    assert.equal((await request(app).post(`/wallet/users/${player.user.id}/adjust`)
      .set(auth(token)).send({ amount: 10, reason: 'not owner' })).status, 403);
  }
  assert.equal((await request(app).post(`/wallet/users/${player.user.id}/adjust`)
    .set(auth(owner.token)).send({ amount: 10, reason: 'owner ok' })).status, 200);
  // Players may not create packages; admins may.
  assert.equal((await request(app).post('/wallet/packages').set(auth(player.token))
    .send({ name: 'Nope', coins: 10, priceAmount: 10, priceCurrency: 'MMK' })).status, 403);
  assert.equal((await request(app).post('/wallet/packages').set(auth(admin.token))
    .send({ name: 'AdminPkg', coins: 10, priceAmount: 10, priceCurrency: 'MMK' })).status, 201);
});

test('a player cannot view another player wallet or history; admin can', async () => {
  const admin = await demoLogin('w-admin1@test.local', 'admin');
  const playerA = await demoLogin('w-player1@test.local', 'player');
  const playerB = await demoLogin('w-player2@test.local', 'player');
  assert.equal((await request(app).get(`/wallet/users/${playerA.user.id}`).set(auth(playerB.token))).status, 403);
  assert.equal((await request(app).get(`/wallet/users/${playerA.user.id}/history`).set(auth(playerB.token))).status, 403);
  assert.equal((await request(app).get(`/wallet/users/${playerA.user.id}`).set(auth(admin.token))).status, 200);
  assert.equal((await request(app).get(`/wallet/users/${playerA.user.id}/history`).set(auth(admin.token))).status, 200);
  assert.equal((await request(app).get('/wallet/users/999999').set(auth(admin.token))).status, 404);
});

test('wallet settings are owner-only and bound custom amounts', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  const mod = await demoLogin('w-mod1@test.local', 'moderator');
  const player = await demoLogin('w-player5@test.local', 'player');
  assert.equal((await request(app).put('/admin/settings/wallet.custom_max_coins')
    .set(auth(mod.token)).send({ value: 2000 })).status, 403);
  assert.equal((await request(app).put('/admin/settings/wallet.custom_min_coins')
    .set(auth(owner.token)).send({ value: 200000 })).status, 400); // above current max
  const changed = await request(app).put('/admin/settings/wallet.custom_max_coins')
    .set(auth(owner.token)).send({ value: 2000 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.value, 2000);
  assert.equal((await request(app).post('/wallet/purchases').set(auth(player.token)).send({ customCoins: 5000 })).status, 400);
  assert.equal((await request(app).post('/wallet/purchases').set(auth(player.token)).send({ customCoins: 1500 })).status, 201);
  // Restore the default bound for any later run in this file.
  assert.equal((await request(app).put('/admin/settings/wallet.custom_max_coins')
    .set(auth(owner.token)).send({ value: 100000 })).status, 200);
});

test('Part 1 money guard still holds in Part 2: no live cash movement', async () => {
  const owner = await demoLogin('w-owner1@test.local', 'owner');
  for (const key of ['money_movement_enabled', 'paid_entry_enabled', 'withdrawals_enabled']) {
    assert.equal((await request(app).put(`/admin/settings/${key}`).set(auth(owner.token)).send({ value: true })).status, 400);
  }
  const health = await request(app).get('/health');
  assert.equal(health.body.moneyMovementEnabled, false);
  const settings = await request(app).get('/admin/settings').set(auth(owner.token));
  const byKey = Object.fromEntries(settings.body.settings.map((s) => [s.key, s.value]));
  assert.equal(byKey.money_movement_enabled, false);
  assert.equal(byKey.paid_entry_enabled, false);
  assert.equal(byKey.withdrawals_enabled, false);
});
