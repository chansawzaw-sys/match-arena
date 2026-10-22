'use strict';
// Authentication routes. Google is the only real login: no password is
// ever collected or stored. Demo login exists ONLY when the app is not in
// production (see config.demoLoginEnabled) and is labelled as such in
// every response and in the README. Staff with 2FA enabled must complete
// a second step; a 2FA challenge token cannot be used as an access token.
const express = require('express');
const crypto = require('crypto');
const { z, validate, botGuard } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const { signAccessToken, signTwoFactorToken, verifyToken } = require('../auth/jwt');
const { googleAuthUrl, exchangeCodeForProfile } = require('../auth/google');
const { generateSecret, verifyTotp, otpauthUrl } = require('../auth/totp');
const usersRepo = require('../db/repos/users');
const sessionsRepo = require('../db/repos/sessions');
const auditRepo = require('../db/repos/audit');

const STAFF_ROLES = new Set(['owner', 'admin', 'moderator', 'support']);
const VALID_ROLES = ['owner', 'admin', 'moderator', 'support', 'player'];

function issueAccess(config, req, user) {
  const token = signAccessToken(config, usersRepo.publicUser(user));
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  sessionsRepo.createSession({
    userId: user.id, token, expiresAt,
    ipAddress: req.ip, userAgent: req.headers['user-agent'],
  });
  return { token, user: usersRepo.publicUser(user) };
}

function startLogin(config, req, user) {
  if (user.status === 'banned') {
    // Expired temporary ban: clear it and let the login through.
    if (user.banned_until && new Date(user.banned_until) <= new Date()) {
      user = usersRepo.clearBan(user.id);
    } else {
      return { error: 'Account is banned', status: 403 };
    }
  }
  if (user.status !== 'active') return { error: 'Account is not active', status: 403 };
  if (STAFF_ROLES.has(user.role) && user.totp_enabled === 1) {
    return { twoFactorRequired: true, tempToken: signTwoFactorToken(config, usersRepo.publicUser(user)) };
  }
  return issueAccess(config, req, user);
}

function buildAuthRouter(config) {
  const router = express.Router();

  router.get('/google', (req, res) => {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleCallbackUrl) {
      return res.status(503).json({
        error: 'Google login is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL.',
      });
    }
    const state = crypto.randomBytes(16).toString('hex');
    return res.redirect(googleAuthUrl(config, state));
  });

  router.get('/google/callback', async (req, res) => {
    try {
      if (!config.googleClientId || !config.googleClientSecret || !config.googleCallbackUrl) {
        return res.status(503).json({ error: 'Google login is not configured.' });
      }
      const { code } = req.query;
      if (!code) return res.status(400).json({ error: 'Missing authorization code' });
      const profile = await exchangeCodeForProfile(config, String(code));
      let user = usersRepo.findByGoogleId(profile.googleId) || usersRepo.findByEmail(profile.email);
      if (!user) {
        user = usersRepo.createUser({ googleId: profile.googleId, email: profile.email, displayName: profile.displayName });
      }
      // Part 6: optional referral attach at signup. The code may be
      // supplied as ?referralCode=... on the callback URL; a failed
      // attach (unknown code, self-referral, already attached) fails
      // the signup rather than silently dropping the referral.
      const referralCode = req.query.referralCode || req.query.referral;
      if (referralCode) {
        try {
          const referralsService = require('../services/referrals');
          referralsService.attachReferrer({ userId: user.id, referralCode: String(referralCode) });
        } catch (err) {
          return res.status(err.status || 400).json({ error: err.message });
        }
      }
      const result = startLogin(config, req, user);
      if (result.error) return res.status(result.status).json({ error: result.error });
      return res.json(result);
    } catch {
      return res.status(502).json({ error: 'Google login failed' });
    }
  });

  router.post('/demo', botGuard, validate(z.object({
    email: z.string().email().max(200),
    displayName: z.string().min(1).max(100).optional(),
    role: z.enum(VALID_ROLES).optional(),
    referralCode: z.string().min(1).max(50).optional(),
  })), (req, res) => {
    if (!config.demoLoginEnabled) {
      return res.status(403).json({ error: 'Demo login is disabled (production mode)' });
    }
    const { email, displayName, role = 'player', referralCode } = req.validated;
    let user = usersRepo.findByEmail(email);
    if (!user) {
      user = usersRepo.createUser({ email, displayName: displayName || email.split('@')[0], role });
    } else if (user.role !== role) {
      // Demo mode only: allow the tester to re-enter as a different role
      // without a second account. Production has no demo login at all.
      user = usersRepo.updateRole(user.id, role);
    }
    // Part 6: optional referral attach at demo signup. Attach-once
    // rules apply exactly as on /referrals/attach; a failed attach
    // fails this login attempt rather than silently dropping it.
    if (referralCode) {
      try {
        const referralsService = require('../services/referrals');
        referralsService.attachReferrer({ userId: user.id, referralCode });
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
      user = usersRepo.findById(user.id);
    }
    const result = startLogin(config, req, user);
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ ...result, demo: true, demoNote: 'Local demo login only. Disabled when NODE_ENV=production.' });
  });

  router.post('/2fa/verify', validate(z.object({
    tempToken: z.string().min(10),
    code: z.string().regex(/^\d{6}$/),
  })), (req, res) => {
    let payload;
    try {
      payload = verifyToken(config, req.validated.tempToken, 'two_factor');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired 2FA challenge' });
    }
    const user = usersRepo.findById(payload.sub);
    if (!user || user.totp_enabled !== 1) return res.status(401).json({ error: '2FA is not enabled for this account' });
    const secret = usersRepo.getTotpSecret(user, config.encryptionKey);
    if (!secret || !verifyTotp(secret, req.validated.code)) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
    return res.json(issueAccess(config, req, user));
  });

  router.get('/me', authenticate(config), (req, res) => res.json({ user: req.user }));

  router.post('/logout', authenticate(config), (req, res) => {
    sessionsRepo.revokeSession(req.sessionId);
    return res.json({ ok: true });
  });

  // --- Staff 2FA management (self only) ---
  router.post('/2fa/setup', authenticate(config), requirePermission('two_factor.manage_self'), (req, res) => {
    const user = usersRepo.findById(req.user.id);
    const secret = generateSecret();
    usersRepo.setTotpSecret(user.id, secret, config.encryptionKey);
    // Enabling is a separate, code-verified step, so a setup alone never
    // locks an account out and never changes the audit-visible state yet.
    return res.json({
      secret,
      otpauthUrl: otpauthUrl({ issuer: 'Match Arena', account: user.email, secret }),
      note: 'Enter this secret in an authenticator app, then confirm it with /auth/2fa/enable.',
    });
  });

  router.post('/2fa/enable', authenticate(config), requirePermission('two_factor.manage_self'),
    validate(z.object({ code: z.string().regex(/^\d{6}$/) })), (req, res) => {
      const user = usersRepo.findById(req.user.id);
      const secret = usersRepo.getTotpSecret(user, config.encryptionKey);
      if (!secret || !verifyTotp(secret, req.validated.code)) {
        return res.status(400).json({ error: 'Invalid 2FA code' });
      }
      usersRepo.setTotpEnabled(user.id, true);
      auditRepo.recordAudit({ actorId: user.id, actorEmail: user.email, action: 'two_factor.enabled', targetType: 'user', targetId: user.id });
      return res.json({ ok: true, totpEnabled: true });
    });

  router.post('/2fa/disable', authenticate(config), requirePermission('two_factor.manage_self'),
    validate(z.object({ code: z.string().regex(/^\d{6}$/) })), (req, res) => {
      const user = usersRepo.findById(req.user.id);
      const secret = usersRepo.getTotpSecret(user, config.encryptionKey);
      if (!secret || !verifyTotp(secret, req.validated.code)) {
        return res.status(400).json({ error: 'Invalid 2FA code' });
      }
      usersRepo.setTotpEnabled(user.id, false);
      usersRepo.setTotpSecret(user.id, null, config.encryptionKey);
      auditRepo.recordAudit({ actorId: user.id, actorEmail: user.email, action: 'two_factor.disabled', targetType: 'user', targetId: user.id });
      return res.json({ ok: true, totpEnabled: false });
    });

  return router;
}

module.exports = { buildAuthRouter, STAFF_ROLES };
