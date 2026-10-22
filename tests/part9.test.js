'use strict';
// Part 9 automated tests: PWA manifest/service worker, homepage and
// search endpoints, language dictionaries, and the frontend wiring.
// One throwaway SQLite file under /tmp. No fake demo data is asserted
// anywhere: homepage counts are compared against data the test itself
// created through the real APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-arena-part9-'));
const dbPath = path.join(tmpDir, 'test.sqlite');
const config = { ...loadConfig({ ...process.env, NODE_ENV: 'test', DB_PATH: dbPath }), demoLoginEnabled: true };
const app = createApp(config);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

async function demoLogin(email, role) {
  const res = await request(app).post('/auth/demo').send({ email, role });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
async function credit(userId, amount, ownerToken) {
  const res = await request(app).post(`/wallet/users/${userId}/adjust`).set(auth(ownerToken)).send({ amount, reason: 'part9 test credit' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

function extractDict() {
  const start = html.indexOf('const DICT =');
  assert.ok(start >= 0, 'DICT not found in index.html');
  let depth = 0; let i = html.indexOf('{', start); const begin = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  const code = html.slice(begin, i + 1);
  const sandbox = {};
  vm.runInNewContext(`DICT = ${code}`, sandbox);
  return sandbox.DICT;
}

test('manifest is valid with standalone display and existing icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name && manifest.theme_color);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src.replace(/^\//, ''))), `icon missing: ${icon.src}`);
  }
});

test('service worker exists with versioned cache and offline fallback, never caching APIs', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /CACHE_NAME\s*=\s*'match-arena-v\d+'/);
  assert.ok(sw.includes('/offline.html'));
  assert.ok(sw.includes('network-only') || sw.includes('never written'));
  assert.ok(fs.existsSync(path.join(root, 'offline.html')));
});

test('main page loads and references manifest and service worker registration', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('/manifest.json'));
  assert.ok(res.text.includes('/sw.js'));
});

test('frontend calls real endpoints and contains no hardcoded fake balance constant', () => {
  for (const path of ['/challenges', '/wallet/me', '/match-rooms', '/leaderboards', '/tournaments', '/notifications', '/referrals/me', '/home', '/search']) {
    assert.ok(html.includes(path), `index.html missing fetch path ${path}`);
  }
  // Exact documented check: the sample balance figure from old demo
  // material must not appear, and no fake-balance constant may exist.
  assert.ok(!html.includes('12450'), 'index.html contains a hardcoded fake balance figure');
  assert.ok(!/fakeBalance|sampleBalance|demoBalance/.test(html));
});

test('language dictionaries have identical key sets for en and mm, and every used key exists', () => {
  const dict = extractDict();
  const enKeys = Object.keys(dict.en).sort();
  const mmKeys = Object.keys(dict.mm).sort();
  assert.deepEqual(mmKeys, enKeys);
  const usedAttrs = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  // Word-boundary match only: without \b, words ending in t such as
  // prompt('Stake') or split(',') would false-positive as t('...') calls.
  const usedCalls = [...html.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]);
  for (const k of new Set([...usedAttrs, ...usedCalls])) {
    assert.ok(enKeys.includes(k), `key used but missing in en: ${k}`);
    assert.ok(mmKeys.includes(k), `key used but missing in mm: ${k}`);
  }
  assert.ok(enKeys.length >= 40, `dictionary too small: ${enKeys.length}`);
});

test('homepage returns real counts and no private fields', async () => {
  const owner = await demoLogin('p9-owner@test.local', 'owner');
  const creator = await demoLogin('p9-creator@test.local', 'player');
  const accepter = await demoLogin('p9-accepter@test.local', 'player');
  await credit(creator.user.id, 10000, owner.token);
  await credit(accepter.user.id, 10000, owner.token);
  const ch = await request(app).post('/challenges').set(auth(creator.token)).send({ arena: 'Classic', teamSize: '1v1', stake: 100, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' } });
  assert.equal(ch.status, 201, JSON.stringify(ch.body));
  const acc = await request(app).post(`/challenges/${ch.body.challenge.id}/accept`).set(auth(accepter.token));
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const home = await request(app).get('/home').set(auth(creator.token));
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.openChallenges, 0);
  assert.equal(home.body.activeMatchRooms, 1);
  assert.equal(home.body.completedMatches, 0);
  assert.equal(home.body.nextTournament, null);
  assert.ok(Array.isArray(home.body.topPlayers));
  assert.ok(!JSON.stringify(home.body).includes('p9-creator@test.local'), 'homepage leaked an email');
  assert.ok(!JSON.stringify(home.body).includes('wallet'), 'homepage leaked wallet data');
});

test('search returns display fields only and requires authentication', async () => {
  const anon = await request(app).get('/search?q=Classic');
  assert.equal(anon.status, 401);
  const creator = await demoLogin('p9-search@test.local', 'player');
  const res = await request(app).get('/search?q=p9-search').set(auth(creator.token));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.players.length, 1);
  assert.equal(res.body.players[0].displayName, 'p9-search');
  assert.ok(!('email' in res.body.players[0]), 'search leaked email');
  assert.ok(!('referralCode' in res.body.players[0]));
  const bad = await request(app).get('/search').set(auth(creator.token));
  assert.equal(bad.status, 400);
});

test('search finds a challenge by id and a tournament by name, display fields only', async () => {
  const owner = await demoLogin('p9-owner2@test.local', 'owner');
  const creator = await demoLogin('p9-creator2@test.local', 'player');
  await credit(creator.user.id, 10000, owner.token);
  const ch = await request(app).post('/challenges').set(auth(creator.token)).send({ arena: 'Brawl', teamSize: '1v1', stake: 50, heroRule: 'any', heroBans: [], customRules: '', rankRestriction: { type: 'none' } });
  assert.equal(ch.status, 201);
  const byId = await request(app).get(`/search?q=${ch.body.challenge.id}`).set(auth(creator.token));
  assert.equal(byId.status, 200);
  assert.ok(byId.body.challenges.some((c) => c.id === ch.body.challenge.id));
  assert.ok(!byId.body.challenges.some((c) => 'creator' in c && c.creator && 'email' in c.creator));
});
