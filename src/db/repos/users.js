'use strict';
// User repository: the only place that reads/writes the users table.
const { getDb } = require('../index');
const { encryptText, decryptText } = require('../../utils/crypto');

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
    rankTier: row.rank_tier ?? null,
    mlbbId: row.mlbb_id ?? null,
    serverId: row.server_id ?? null,
    bannedUntil: row.banned_until ?? null,
    totpEnabled: row.totp_enabled === 1,
    referralCode: row.referral_code ?? null,
    referrerId: row.referrer_id ?? null,
    referralAttachedAt: row.referral_attached_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
}

function findByGoogleId(googleId) {
  return getDb().prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
}

function createUser({ googleId = null, email, displayName, role = 'player' }) {
  // Part 6: every user gets a unique referral code at creation. The
  // code column is nullable for pre-Part 6 rows (backfilled on boot
  // and lazily), but new rows always get one; a UNIQUE collision
  // (vanishingly rare for 8 chars) simply retries with a new code.
  const { generateReferralCode } = require('../../utils/referralCode');
  const now = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    try {
      const result = getDb().prepare(
        'INSERT INTO users (google_id, email, display_name, role, status, referral_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(googleId, email.toLowerCase(), displayName, role, 'active', generateReferralCode(), now, now);
      return findById(result.lastInsertRowid);
    } catch (err) {
      if (!String(err.message || '').includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Could not create a user with a unique referral code');
}

function updateRole(id, role) {
  getDb().prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .run(role, new Date().toISOString(), id);
  return findById(id);
}

function setGameIds(id, mlbbId, serverId) {
  getDb().prepare('UPDATE users SET mlbb_id = ?, server_id = ?, updated_at = ? WHERE id = ?')
    .run(mlbbId, serverId, new Date().toISOString(), id);
  return findById(id);
}

function setDisplayName(id, displayName) {
  getDb().prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
    .run(displayName, new Date().toISOString(), id);
  return findById(id);
}

function setAvatarUrl(id, avatarUrl) {
  getDb().prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
    .run(avatarUrl, new Date().toISOString(), id);
  return findById(id);
}

function setRankTier(id, rankTier) {
  getDb().prepare('UPDATE users SET rank_tier = ?, updated_at = ? WHERE id = ?')
    .run(rankTier, new Date().toISOString(), id);
  return findById(id);
}

function setStatus(id, status) {
  getDb().prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return findById(id);
}

// Temporary ban: status stays 'banned' with an expiry. The auth
// middleware treats a ban whose banned_until is in the past as
// expired and clears it, so a temp ban blocks login only until
// expiry and then allows login again without manual unban.
function setTempBan(id, bannedUntil) {
  getDb().prepare('UPDATE users SET status = ?, banned_until = ?, updated_at = ? WHERE id = ?')
    .run('banned', bannedUntil, new Date().toISOString(), id);
  return findById(id);
}

function clearBan(id) {
  getDb().prepare('UPDATE users SET status = ?, banned_until = NULL, updated_at = ? WHERE id = ?')
    .run('active', new Date().toISOString(), id);
  return findById(id);
}

function setTotpSecret(id, secret, encryptionKey) {
  getDb().prepare('UPDATE users SET totp_secret_encrypted = ?, updated_at = ? WHERE id = ?')
    .run(secret ? encryptText(secret, encryptionKey) : null, new Date().toISOString(), id);
}

function setTotpEnabled(id, enabled) {
  getDb().prepare('UPDATE users SET totp_enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return findById(id);
}

function getTotpSecret(row, encryptionKey) {
  if (!row || !row.totp_secret_encrypted) return null;
  return decryptText(row.totp_secret_encrypted, encryptionKey);
}

function listUsers({ limit = 50, offset = 0 } = {}) {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?')
    .all(Math.min(limit, 200), offset);
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return { users: rows.map(publicUser), total };
}

function rolePermissions(role) {
  return getDb().prepare('SELECT permission FROM role_permissions WHERE role = ?')
    .all(role).map((r) => r.permission);
}

module.exports = {
  publicUser, findById, findByEmail, findByGoogleId, createUser, updateRole, setGameIds,
  setDisplayName, setAvatarUrl,
  setRankTier, setStatus, setTempBan, clearBan, setTotpSecret, setTotpEnabled, getTotpSecret, listUsers, rolePermissions,
};
