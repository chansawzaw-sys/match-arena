'use strict';
// Admin routes. Every route here is permission-gated, and every state
// change writes an audit row. Read-only audit viewing is the only audit
// operation: there is no edit or delete endpoint for audit entries.
// Role changes and fee/wallet/legal setting changes are owner-only by
// the permission matrix, so an admin or moderator hitting them gets 403.
const express = require('express');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const usersRepo = require('../db/repos/users');
const auditRepo = require('../db/repos/audit');
const settingsService = require('../services/settings');

const VALID_ROLES = ['owner', 'admin', 'moderator', 'support', 'player'];

function buildAdminRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  router.get('/settings', requirePermission('settings.view'), (req, res) => {
    res.json({ settings: settingsService.listSettings() });
  });

  // The permission required depends on the key itself: general keys need
  // settings.update_general, fee/wallet/legal keys need their owner-only
  // permissions. The key is validated before any permission check so an
  // unknown key is a 400, not a misleading 403.
  router.put('/settings/:key', validateParams(z.object({ key: z.string().min(1).max(100) })),
    (req, res, next) => {
      const { key } = req.validatedParams;
      const valueError = settingsService.validateSettingValue(key, req.body.value);
      if (valueError) return res.status(400).json({ error: valueError });
      return requirePermission(settingsService.requiredPermissionForKey(key))(req, res, next);
    },
    (req, res) => {
      const { key } = req.validatedParams;
      const oldValue = settingsService.getSetting(key);
      const newValue = settingsService.setSetting(key, req.body.value, req.user.id);
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'setting.updated',
        targetType: 'setting', targetId: key, details: { key, oldValue, newValue },
      });
      res.json({ key, value: newValue });
    });

  router.get('/users', requirePermission('users.view'), (req, res) => {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    res.json(usersRepo.listUsers({ limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 }));
  });

  router.get('/users/:id', requirePermission('users.view'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })), (req, res) => {
      const user = usersRepo.findById(req.validatedParams.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ user: usersRepo.publicUser(user) });
    });

  router.put('/users/:id/role', requirePermission('users.change_role'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    validate(z.object({ role: z.enum(VALID_ROLES) })), (req, res) => {
      const target = usersRepo.findById(req.validatedParams.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      const oldRole = target.role;
      const updated = usersRepo.updateRole(target.id, req.validated.role);
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'user.role_changed',
        targetType: 'user', targetId: target.id, details: { oldRole, newRole: req.validated.role },
      });
      res.json({ user: usersRepo.publicUser(updated) });
    });

  router.post('/users/:id/ban', requirePermission('users.ban'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })), (req, res) => {
      const target = usersRepo.findById(req.validatedParams.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot ban yourself' });
      const updated = usersRepo.setStatus(target.id, 'banned');
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'user.banned',
        targetType: 'user', targetId: target.id,
      });
      res.json({ user: usersRepo.publicUser(updated) });
    });

  router.post('/users/:id/unban', requirePermission('users.ban'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })), (req, res) => {
      const target = usersRepo.findById(req.validatedParams.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      const updated = usersRepo.clearBan(target.id);
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'user.unbanned',
        targetType: 'user', targetId: target.id,
      });
      res.json({ user: usersRepo.publicUser(updated) });
    });

  router.get('/audit-log', requirePermission('audit.view'), (req, res) => {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    res.json(auditRepo.listAudit({
      actorId: req.query.actorId ? Number(req.query.actorId) : undefined,
      action: req.query.action || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    }));
  });

  return router;
}

module.exports = { buildAdminRouter };
