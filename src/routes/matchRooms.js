'use strict';
// Private match-room routes (Part 4). Room creation is automatic from
// Part 3 accept — there is deliberately no public room-creation
// endpoint. Roster add/remove, ready, chat and voice are participant
// only; staff (owner/admin/moderator) may view a room read-only for
// later dispute work, but may not ready, chat or join voice as a
// player. Timeout/cancel and roster changes are audit-logged.
const express = require('express');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const repo = require('../db/repos/matchRooms');
const service = require('../services/matchRooms');
const { RoomError } = service;

const idParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));

function handleRoomError(err, res) {
  if (err instanceof RoomError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function audit(req, action, roomId, details = {}) {
  auditRepo.recordAudit({
    actorId: req.user.id, actorEmail: req.user.email, action,
    targetType: 'match_room', targetId: roomId, details,
  });
}

function buildMatchRoomRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  router.get('/:id', idParams, (req, res) => {
    try { res.json(service.getRoom(req.validatedParams.id, req.user)); }
    catch (err) { handleRoomError(err, res); }
  });

  router.get('/:id/reconnect', idParams, (req, res) => {
    try { res.json(service.getReconnect(req.validatedParams.id, req.user)); }
    catch (err) { handleRoomError(err, res); }
  });

  // --- Roster (per-room only; persistent teams are Part 7) ---
  router.post('/:id/roster', idParams,
    validate(z.object({ userId: z.number().int().positive() })),
    (req, res) => {
      try {
        const room = service.addRosterMember({
          roomId: req.validatedParams.id, leaderId: req.user.id, userId: req.validated.userId,
        });
        audit(req, 'match_room.roster_added', room.id, { addedUserId: req.validated.userId });
        res.json(room);
      } catch (err) { handleRoomError(err, res); }
    });

  router.delete('/:id/roster/:userId', idParams,
    validateParams(z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() })),
    (req, res) => {
      try {
        const room = service.removeRosterMember({
          roomId: req.validatedParams.id, leaderId: req.user.id, userId: req.validatedParams.userId,
        });
        audit(req, 'match_room.roster_removed', room.id, { removedUserId: req.validatedParams.userId });
        res.json(room);
      } catch (err) { handleRoomError(err, res); }
    });

  router.post('/:id/leave', idParams, (req, res) => {
    try {
      const room = service.leaveRoom({ roomId: req.validatedParams.id, userId: req.user.id });
      audit(req, 'match_room.left', room.id, { status: room.status });
      res.json(room);
    } catch (err) { handleRoomError(err, res); }
  });

  // --- Ready ---
  router.post('/:id/ready', idParams,
    validate(z.object({ ready: z.boolean() })),
    (req, res) => {
      try {
        const room = service.setReady({
          roomId: req.validatedParams.id, userId: req.user.id, ready: req.validated.ready,
        });
        res.json(room);
      } catch (err) { handleRoomError(err, res); }
    });

  // --- Mini chat ---
  router.post('/:id/chat', idParams,
    validate(z.object({ text: z.string().min(1).max(1000) })),
    (req, res) => {
      try {
        const message = service.postChat({
          roomId: req.validatedParams.id, userId: req.user.id, text: req.validated.text,
        });
        res.status(201).json({ message });
      } catch (err) { handleRoomError(err, res); }
    });

  router.get('/:id/chat', idParams, (req, res) => {
    try {
      const limit = Number(req.query.limit || 50);
      const offset = Number(req.query.offset || 0);
      const order = req.query.order === 'desc' ? 'desc' : 'asc';
      res.json({
        messages: service.listChat(req.validatedParams.id, req.user, {
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0, order,
        }),
      });
    } catch (err) { handleRoomError(err, res); }
  });

  // --- Voice signalling only (no audio; see README) ---
  router.post('/:id/voice/join', idParams, (req, res) => {
    try { res.json({ members: service.voiceJoin(req.validatedParams.id, req.user.id) }); }
    catch (err) { handleRoomError(err, res); }
  });

  router.post('/:id/voice/leave', idParams, (req, res) => {
    try { res.json({ members: service.voiceLeave(req.validatedParams.id, req.user.id) }); }
    catch (err) { handleRoomError(err, res); }
  });

  router.get('/:id/voice', idParams, (req, res) => {
    try {
      const raw = repo.findRoomRaw(req.validatedParams.id);
      service.getRoom(req.validatedParams.id, req.user); // access check
      res.json({ members: repo.voiceMembers(raw.id) });
    } catch (err) { handleRoomError(err, res); }
  });

  router.post('/:id/voice/signal', idParams,
    validate(z.object({
      toUserId: z.number().int().positive().nullable().optional(),
      kind: z.enum(['offer', 'answer', 'ice-candidate']),
      payload: z.string().min(1).max(5000),
    })),
    (req, res) => {
      try {
        const signal = service.voiceSignal({
          roomId: req.validatedParams.id, fromUserId: req.user.id,
          toUserId: req.validated.toUserId ?? null,
          kind: req.validated.kind, payload: req.validated.payload,
        });
        res.status(201).json({ signal });
      } catch (err) { handleRoomError(err, res); }
    });

  router.get('/:id/voice/signals', idParams, (req, res) => {
    try {
      const afterId = Number(req.query.afterId || 0);
      res.json({
        signals: service.voiceSignals(req.validatedParams.id, req.user, Number.isFinite(afterId) ? afterId : 0),
      });
    } catch (err) { handleRoomError(err, res); }
  });

  return router;
}

module.exports = { buildMatchRoomRouter };
