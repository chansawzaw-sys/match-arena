'use strict';
// Session repository: JWTs are only valid while their session row exists
// and is not revoked, so logout actually ends a session (a bare JWT check
// alone would not). Tokens are stored only as SHA-256 hashes.
const { getDb } = require('../index');
const { sha256 } = require('../../utils/crypto');

function createSession({ userId, token, expiresAt, ipAddress, userAgent }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, revoked_at, ip_address, user_agent) VALUES (?, ?, ?, ?, NULL, ?, ?)',
  ).run(userId, sha256(token), now, expiresAt, ipAddress || null, userAgent || null);
  return result.lastInsertRowid;
}

function findSessionByToken(token) {
  return getDb().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
}

function revokeSession(id) {
  getDb().prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

module.exports = { createSession, findSessionByToken, revokeSession };
