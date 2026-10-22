'use strict';
// Minimal notification records (Part 4). The full notification centre
// (types, history browsing, preferences) is Part 8; Part 4 provides
// only the unread list used by the match room, a full own list, and
// mark-as-read. Notifications are created by the match-room service
// on ready, countdown, start and cancel.
const express = require('express');
const { validateParams } = require('../middleware/validate');
const { z } = require('../middleware/validate');
const { authenticate } = require('../auth/middleware');
const repo = require('../db/repos/matchRooms');

function buildNotificationRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  router.get('/unread', (req, res) => {
    res.json({ notifications: repo.listUnread(req.user.id) });
  });

  // Part 8 centre: filtered list (category, read/unread), unread
  // count and mark-all. Each notification carries a tap-through
  // target ({type, id} or null) via publicNotification in the repo.
  router.get('/', (req, res) => {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const read = req.query.read === undefined ? undefined : req.query.read === 'true';
    res.json(repo.listNotificationsFiltered(req.user.id, {
      category: req.query.category || undefined,
      read,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    }));
  });

  router.get('/unread-count', (req, res) => {
    res.json({ unreadCount: repo.unreadNotificationCount(req.user.id) });
  });

  router.post('/read-all', (req, res) => {
    res.json({ marked: repo.markAllNotificationsRead(req.user.id) });
  });

  router.post('/:id/read',
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    (req, res) => {
      const ok = repo.markNotificationRead(req.validatedParams.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Notification not found' });
      res.json({ ok: true });
    });

  return router;
}

module.exports = { buildNotificationRouter };
