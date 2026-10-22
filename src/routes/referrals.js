'use strict';
// Part 6 routes: referral dashboard/attach, fee preview/history, and
// the staff aggregate endpoint. Commission crediting is system-only:
// there is deliberately no public endpoint that can mint a commission
// — commissions are created only by the settlement/dispute hooks in
// src/services/results.js via src/services/referrals.js.
const express = require('express');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const referralsRepo = require('../db/repos/referrals');
const service = require('../services/referrals');
const { ReferralError } = service;

function handleReferralError(err, res) {
  if (err instanceof ReferralError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function audit(req, action, targetType, targetId, details = {}) {
  auditRepo.recordAudit({
    actorId: req.user.id, actorEmail: req.user.email, action,
    targetType, targetId, details,
  });
}

function buildReferralsRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  const baseUrl = (config.publicBaseUrl || config.corsOrigin || 'http://localhost:3000').replace(/\/$/, '');

  router.get('/referrals/me', (req, res) => {
    try {
      const dashboard = service.dashboardFor(req.user.id, {
        status: req.query.status || undefined,
        limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
      });
      dashboard.referralLink = `${baseUrl}/signup?referral=${dashboard.referralCode}`;
      return res.json(dashboard);
    } catch (err) { return handleReferralError(err, res); }
  });

  router.get('/referrals/me/invitees', (req, res) => {
    try {
      return res.json({ invitees: service.inviteesFor(req.user.id) });
    } catch (err) { return handleReferralError(err, res); }
  });

  router.post('/referrals/attach', validate(z.object({
    referralCode: z.string().min(1).max(50),
  })), (req, res) => {
    try {
      const result = service.attachReferrer({ userId: req.user.id, referralCode: req.validated.referralCode });
      return res.json(result);
    } catch (err) { return handleReferralError(err, res); }
  });

  // Staff aggregate only: counts and totals, never invitee private
  // fields (no email, MLBB ID, server ID, wallet balance, or names).
  router.get('/referrals/admin/aggregate', requirePermission('referrals.view_aggregate'), (req, res) => {
    return res.json(referralsRepo.aggregateStats());
  });

  router.get('/fees/preview', (req, res) => {
    try {
      const arena = String(req.query.arena || '');
      const stake = Number(req.query.stake);
      const participantCount = req.query.participantCount === undefined ? 2 : Number(req.query.participantCount);
      return res.json(service.feePreview({ arena, stake, participantCount }));
    } catch (err) { return handleReferralError(err, res); }
  });

  router.get('/fees/history', requirePermission('wallet.view_all'), (req, res) => {
    return res.json(referralsRepo.listPlatformFees({
      arena: req.query.arena || undefined,
      from: req.query.from || undefined, to: req.query.to || undefined,
      limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0),
    }));
  });

  return router;
}

module.exports = { buildReferralsRouter };
