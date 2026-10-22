'use strict';
// JWT handling. Two token kinds exist and are never interchangeable:
//  - access tokens (purpose: 'access', 24h) for API calls, backed by a
//    session row that logout revokes.
//  - 2FA challenge tokens (purpose: 'two_factor', 10 minutes) that can only
//    be exchanged for an access token by a correct TOTP code.
const jwt = require('jsonwebtoken');

function signAccessToken(config, user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, purpose: 'access' },
    config.jwtSecret, { expiresIn: '24h' },
  );
}

function signTwoFactorToken(config, user) {
  return jwt.sign(
    { sub: user.id, email: user.email, purpose: 'two_factor' },
    config.jwtSecret, { expiresIn: '10m' },
  );
}

function verifyToken(config, token, purpose) {
  const payload = jwt.verify(token, config.jwtSecret);
  if (payload.purpose !== purpose) throw new Error('Wrong token purpose');
  return payload;
}

module.exports = { signAccessToken, signTwoFactorToken, verifyToken };
