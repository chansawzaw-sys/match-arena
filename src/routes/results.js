'use strict';
// Part 5 routes: result submission, disputes, reputation, reports,
// match history and evidence files. Evidence is a real multipart
// upload (images only, max 5 MB each, max 3 files per owner), stored
// under data/evidence/ (gitignored) and never served publicly — the
// download endpoint enforces participant/staff or reporter/staff
// access, and files are only ever looked up by database id, never
// by a client-supplied path, so there is no path-traversal surface.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const resultsRepo = require('../db/repos/results');
const matchRoomsRepo = require('../db/repos/matchRooms');
const service = require('../services/results');
const { ResultError } = service;

const EVIDENCE_DIR = path.join(__dirname, '..', '..', 'data', 'evidence');
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    cb(null, EVIDENCE_DIR);
  },
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 3 } });

function uploadEvidence(req, res, next) {
  upload.array('evidence', 3)(req, res, (err) => {
    if (err) {
      // Multer errors (oversize, too many files) are client errors,
      // not 500s, and any files already saved must not be orphaned.
      if (req.files) for (const f of req.files) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
      return res.status(400).json({ error: err.message || 'Evidence upload failed' });
    }
    return next();
  });
}

function deleteFiles(files) {
  for (const f of files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
}

function validateEvidenceFiles(files) {
  for (const f of files || []) {
    const ext = path.extname(f.originalname || '').toLowerCase();
    if (!ALLOWED_MIMES.has(f.mimetype) || !ALLOWED_EXTS.has(ext)) {
      return 'Evidence must be an image file (png, jpeg or webp)';
    }
    if (f.size > 5 * 1024 * 1024) return 'Evidence file must be at most 5 MB';
  }
  return null;
}

function handleResultError(err, res) {
  if (err instanceof ResultError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function audit(req, action, targetType, targetId, details = {}) {
  auditRepo.recordAudit({
    actorId: req.user.id, actorEmail: req.user.email, action,
    targetType, targetId, details,
  });
}

function evidenceResponse(files, ownerType, ownerId, roomId, uploaderId) {
  return files.map((f) => resultsRepo.addEvidence({
    ownerType, ownerId, roomId, uploaderId,
    originalName: f.originalname, mime: f.mimetype, size: f.size, storedPath: f.path,
  }));
}

const idParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));

function buildResultsRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  // --- Result submission ---
  // Multipart bodies arrive as strings, so this route validates its
  // fields by hand (instead of the JSON validate() middleware) and
  // deletes any uploaded files when validation fails, so a rejected
  // submission never orphans evidence on disk.
  router.post('/match-rooms/:id/results', idParams, uploadEvidence,
    (req, res) => {
      try {
        const parsed = z.object({
          outcome: z.enum(['win', 'lose']),
          reason: z.string().max(2000).optional(),
        }).safeParse(req.body || {});
        if (!parsed.success) { deleteFiles(req.files); return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); }
        const validated = parsed.data;
        const bad = validateEvidenceFiles(req.files);
        if (bad) { deleteFiles(req.files); return res.status(400).json({ error: bad }); }
        const result = service.submitResult({
          roomId: req.validatedParams.id, userId: req.user.id,
          outcome: validated.outcome, reason: validated.reason || '',
        });
        // Evidence attaches to the submission that was just created
        // (the caller's own side). If no submission was created (should
        // not happen — submitResult throws first), drop the files.
        const mine = result.submission;
        let evidence = [];
        if (mine && req.files && req.files.length) {
          evidence = evidenceResponse(req.files, 'submission', mine.id, req.validatedParams.id, req.user.id);
        } else if (req.files) {
          deleteFiles(req.files);
        }
        audit(req, 'match_result.submitted', 'match_room', req.validatedParams.id, { outcome: validated.outcome });
        return res.status(201).json({ ...result, evidence });
      } catch (err) {
        deleteFiles(req.files);
        return handleResultError(err, res);
      }
    });

  router.get('/match-rooms/:id/results', idParams, (req, res) => {
    try {
      res.json({
        submissions: service.listSubmissions(req.validatedParams.id, req.user).map((s) => ({
          ...s, evidence: resultsRepo.listEvidence('submission', s.id),
        })),
      });
    } catch (err) { handleResultError(err, res); }
  });

  // --- Disputes ---
  router.get('/disputes', requirePermission('disputes.view'), (req, res) => {
    try {
      res.json(service.listDisputes(req.user, {
        status: req.query.status || undefined,
        limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
      }));
    } catch (err) { handleResultError(err, res); }
  });

  router.get('/disputes/:id', idParams, (req, res) => {
    try { res.json(service.getDispute(req.validatedParams.id, req.user)); }
    catch (err) { handleResultError(err, res); }
  });

  router.get('/match-rooms/:id/dispute', idParams, (req, res) => {
    try {
      const dispute = resultsRepo.findDisputeByRoom(req.validatedParams.id);
      if (!dispute) return res.status(404).json({ error: 'No dispute for this match room' });
      res.json(service.getDispute(dispute.id, req.user));
    } catch (err) { handleResultError(err, res); }
  });

  router.post('/disputes/:id/notes', idParams, requirePermission('disputes.investigate'),
    validate(z.object({ note: z.string().min(1).max(2000) })),
    (req, res) => {
      try {
        const note = service.addDisputeNote({
          disputeId: req.validatedParams.id, viewer: req.user, note: req.validated.note,
        });
        audit(req, 'dispute.note_added', 'dispute', req.validatedParams.id, {});
        res.status(201).json({ note });
      } catch (err) { handleResultError(err, res); }
    });

  router.post('/disputes/:id/evidence', idParams, uploadEvidence, (req, res) => {
    try {
      const dispute = resultsRepo.findDispute(req.validatedParams.id);
      if (!dispute) { deleteFiles(req.files); return res.status(404).json({ error: 'Dispute not found' }); }
      const isStaff = ['owner', 'admin', 'moderator'].includes(req.user.role);
      const isParticipant = !!matchRoomsRepo.findParticipant(dispute.roomId, req.user.id);
      if (!isStaff && !isParticipant) { deleteFiles(req.files); return res.status(403).json({ error: 'You cannot add evidence to this dispute' }); }
      const bad = validateEvidenceFiles(req.files);
      if (bad) { deleteFiles(req.files); return res.status(400).json({ error: bad }); }
      const existing = resultsRepo.countEvidence('dispute', dispute.id);
      if (existing + (req.files || []).length > 3) {
        deleteFiles(req.files);
        return res.status(400).json({ error: 'At most 3 evidence files per dispute' });
      }
      const evidence = evidenceResponse(req.files, 'dispute', dispute.id, dispute.roomId, req.user.id);
      audit(req, 'dispute.evidence_added', 'dispute', dispute.id, { files: evidence.length });
      res.status(201).json({ evidence });
    } catch (err) { deleteFiles(req.files); handleResultError(err, res); }
  });

  router.post('/disputes/:id/decision', idParams, requirePermission('disputes.decide'),
    validate(z.object({
      decision: z.enum(['winner', 'cancel']),
      winnerSide: z.enum(['A', 'B']).nullable().optional(),
      reason: z.string().min(1).max(2000),
    })),
    (req, res) => {
      try {
        const result = service.decideDispute({
          disputeId: req.validatedParams.id, viewer: req.user,
          decision: req.validated.decision, winnerSide: req.validated.winnerSide ?? null,
          reason: req.validated.reason,
        });
        audit(req, 'dispute.decided', 'dispute', req.validatedParams.id, {
          decision: req.validated.decision, winnerSide: req.validated.winnerSide ?? null,
        });
        res.json(result);
      } catch (err) { handleResultError(err, res); }
    });

  // --- Evidence download (never public) ---
  router.get('/evidence/:id', idParams, (req, res) => {
    try {
      const raw = resultsRepo.findEvidenceRaw(req.validatedParams.id);
      if (!raw) return res.status(404).json({ error: 'Evidence not found' });
      const isStaff = ['owner', 'admin', 'moderator'].includes(req.user.role);
      let allowed = false;
      if (raw.owner_type === 'report') {
        const report = resultsRepo.findReport(raw.owner_id);
        allowed = isStaff || (report && report.reporterId === req.user.id);
      } else {
        allowed = isStaff || (raw.room_id !== null && !!matchRoomsRepo.findParticipant(raw.room_id, req.user.id));
      }
      if (!allowed) return res.status(403).json({ error: 'You cannot view this evidence' });
      const stored = path.resolve(raw.stored_path);
      if (!stored.startsWith(path.resolve(EVIDENCE_DIR))) return res.status(404).json({ error: 'Evidence not found' });
      return res.sendFile(stored, { headers: { 'Content-Type': raw.mime } });
    } catch (err) { handleResultError(err, res); }
  });

  // --- Reputation ---
  router.get('/reputation/me', (req, res) => {
    res.json({ reputation: resultsRepo.getReputation(req.user.id) });
  });

  router.get('/reputation/:userId', validateParams(z.object({ userId: z.coerce.number().int().positive() })),
    (req, res) => {
      try { res.json({ reputation: service.getReputationFor(req.validatedParams.userId, req.user) }); }
      catch (err) { handleResultError(err, res); }
    });

  router.get('/reputation/:userId/events', validateParams(z.object({ userId: z.coerce.number().int().positive() })),
    (req, res) => {
      try {
        res.json(service.listReputationEvents(req.validatedParams.userId, req.user, {
          limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
        }));
      } catch (err) { handleResultError(err, res); }
    });

  router.post('/reputation/:userId/penalty', validateParams(z.object({ userId: z.coerce.number().int().positive() })),
    requirePermission('reputation.penalty'),
    validate(z.object({
      points: z.number().int().min(1).max(100),
      reason: z.string().min(1).max(2000),
    })),
    (req, res) => {
      try {
        const result = service.applyManualPenalty({
          userId: req.validatedParams.userId, points: req.validated.points,
          reason: req.validated.reason, actorId: req.user.id,
        });
        audit(req, 'reputation.penalty', 'user', req.validatedParams.userId, { points: req.validated.points });
        res.json(result);
      } catch (err) { handleResultError(err, res); }
    });

  // --- Reports ---
  // Multipart fields arrive as strings, so validate by hand here and
  // delete uploaded files on any failure (see result submission above).
  router.post('/reports', uploadEvidence,
    (req, res) => {
      try {
        const parsed = z.object({
          reportedUserId: z.coerce.number().int().positive(),
          category: z.enum(resultsRepo.REPORT_CATEGORIES),
          reason: z.string().min(1).max(2000),
          roomId: z.coerce.number().int().positive().nullable().optional(),
        }).safeParse(req.body || {});
        if (!parsed.success) { deleteFiles(req.files); return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); }
        const validated = parsed.data;
        const bad = validateEvidenceFiles(req.files);
        if (bad) { deleteFiles(req.files); return res.status(400).json({ error: bad }); }
        const report = service.createReport({
          reporterId: req.user.id, reportedUserId: validated.reportedUserId,
          category: validated.category, reason: validated.reason,
          roomId: validated.roomId ?? null,
        });
        let evidence = [];
        if (req.files && req.files.length) {
          evidence = evidenceResponse(req.files, 'report', report.id, report.roomId, req.user.id);
        }
        audit(req, 'report.created', 'report', report.id, { category: report.category });
        return res.status(201).json({ report, evidence });
      } catch (err) { deleteFiles(req.files); return handleResultError(err, res); }
    });

  router.get('/reports', (req, res) => {
    try {
      res.json(service.listReportsFor(req.user, {
        status: req.query.status || undefined,
        limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
      }));
    } catch (err) { handleResultError(err, res); }
  });

  router.get('/reports/:id', idParams, (req, res) => {
    try { res.json(service.getReport(req.validatedParams.id, req.user)); }
    catch (err) { handleResultError(err, res); }
  });

  router.post('/reports/:id/investigate', idParams, requirePermission('reports.investigate'),
    validate(z.object({ note: z.string().min(1).max(2000).optional() })),
    (req, res) => {
      try {
        const report = service.investigateReport({
          reportId: req.validatedParams.id, viewer: req.user, note: req.validated.note || null,
        });
        audit(req, 'report.investigating', 'report', req.validatedParams.id, {});
        res.json({ report });
      } catch (err) { handleResultError(err, res); }
    });

  router.post('/reports/:id/resolve', idParams, requirePermission('reports.resolve'),
    validate(z.object({
      resolution: z.string().min(1).max(2000),
      action: z.enum(['none', 'warning', 'temp_ban', 'permanent_ban']),
      tempBanUntil: z.string().nullable().optional(),
    })),
    (req, res) => {
      try {
        const report = service.resolveReport({
          reportId: req.validatedParams.id, viewer: req.user,
          resolution: req.validated.resolution, action: req.validated.action,
          tempBanUntil: req.validated.tempBanUntil ?? null,
        });
        audit(req, 'report.resolved', 'report', req.validatedParams.id, { action: req.validated.action });
        res.json({ report });
      } catch (err) { handleResultError(err, res); }
    });

  // --- Match history ---
  router.get('/match-history/mine', (req, res) => {
    res.json(service.listOwnHistory(req.user.id, {
      result: req.query.result || undefined, status: req.query.status || undefined,
      limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
    }));
  });

  router.get('/match-history/:id', idParams, (req, res) => {
    try { res.json({ history: service.historyByMatch(req.validatedParams.id, req.user) }); }
    catch (err) { handleResultError(err, res); }
  });

  return router;
}

module.exports = { buildResultsRouter, EVIDENCE_DIR };
