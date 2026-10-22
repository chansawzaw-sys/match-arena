'use strict';
// Auth + permission middleware. Permissions are read from the database
// (role_permissions) on every request, so a role change takes effect
// immediately and no permission map is duplicated in route code.
const { verifyToken } = require('./jwt');
const usersRepo = require('../db/repos/users');
const sessionsRepo = require('../db/repos/sessions');

function authenticate(config) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let payload;
    try {
      payload = verifyToken(config, token, 'access');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const session = sessionsRepo.findSessionByToken(token);
    if (!session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Session is no longer valid' });
    }
    const user = usersRepo.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Account is not active' });
    }
    if (user.status === 'banned') {
      // A temporary ban whose expiry is in the past is expired: clear
      // it and let the login through. A permanent ban (no expiry) and
      // an unexpired temp ban still block login.
      if (user.banned_until && new Date(user.banned_until) <= new Date()) {
        usersRepo.clearBan(user.id);
      } else {
        return res.status(401).json({ error: 'Account is not active' });
      }
    }
    req.user = usersRepo.publicUser(user);
    req.sessionId = session.id;
    req.token = token;
    return next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const permissions = usersRepo.rolePermissions(req.user.role);
    if (!permissions.includes(permission)) {
      return res.status(403).json({ error: `Permission denied: ${permission}` });
    }
    return next();
  };
}

module.exports = { authenticate, requirePermission };
