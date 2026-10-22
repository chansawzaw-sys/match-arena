'use strict';
// Challenge board routes (Part 3). Player actions are authenticated and
// self-scoped or creator-scoped; admin hero restrictions need the
// hero_restrictions.manage permission (owner/admin). There is deliberately
// no route to edit a challenge or to edit/delete another player's
// favorite: favorites are private, challenges are cancelled, not edited.
// Accept is the critical path — the service runs it atomically, so a
// failed accept locks no coins and a second accept cannot double-lock.
const express = require('express');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const repo = require('../db/repos/challenges');
const service = require('../services/challenges');

const { ChallengeError } = service;
const RANK_TIERS = repo.RANK_TIERS;

const rankRestrictionSchema = z.object({
  type: z.enum(['none', 'same_rank_only', 'range']),
  minTier: z.enum(RANK_TIERS).nullable().optional(),
  maxTier: z.enum(RANK_TIERS).nullable().optional(),
});

const ruleSchema = z.object({
  arena: z.enum(repo.ARENAS),
  teamSize: z.enum(repo.TEAM_SIZES),
  heroRule: z.enum(repo.HERO_RULES),
  requiredHero: z.string().min(1).max(100).nullable().optional(),
  heroBans: z.array(z.string().min(1).max(100)).max(20).optional(),
  customRules: z.string().max(2000).optional(),
  rankRestriction: rankRestrictionSchema.optional(),
});

const challengeSchema = ruleSchema.extend({
  stake: z.number().int().positive(),
});

function parsePagination(req) {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
    offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
  };
}

function handleChallengeError(err, res) {
  if (err instanceof ChallengeError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function buildChallengeRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  // --- Favorites (before /:id, so 'favorites' is never parsed as an id) ---

  router.post('/favorites', validate(ruleSchema.extend({
    name: z.string().min(1).max(100),
  })), (req, res) => {
    try {
      const favorite = service.createFavorite({
        userId: req.user.id,
        name: req.validated.name,
        arena: req.validated.arena,
        teamSize: req.validated.teamSize,
        heroRule: req.validated.heroRule,
        requiredHero: req.validated.requiredHero ?? null,
        heroBans: req.validated.heroBans || [],
        customRules: req.validated.customRules || '',
        rankRestriction: req.validated.rankRestriction || { type: 'none' },
      });
      res.status(201).json({ favorite });
    } catch (err) { handleChallengeError(err, res); }
  });

  router.get('/favorites', (req, res) => {
    res.json({ favorites: repo.listFavorites(req.user.id) });
  });

  router.delete('/favorites/:id',
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    (req, res) => {
      const deleted = repo.deleteFavorite(req.validatedParams.id, req.user.id);
      if (!deleted) return res.status(404).json({ error: 'Favorite not found' });
      res.json({ ok: true });
    });

  router.post('/from-favorite',
    validate(z.object({
      favoriteId: z.number().int().positive(),
      stake: z.number().int().positive(),
      overrides: z.object({
        arena: z.enum(repo.ARENAS).optional(),
        teamSize: z.enum(repo.TEAM_SIZES).optional(),
        heroRule: z.enum(repo.HERO_RULES).optional(),
        requiredHero: z.string().min(1).max(100).nullable().optional(),
        heroBans: z.array(z.string().min(1).max(100)).max(20).optional(),
        customRules: z.string().max(2000).optional(),
        rankRestriction: rankRestrictionSchema.optional(),
      }).optional(),
    })),
    (req, res) => {
      try {
        const challenge = service.createChallengeFromFavorite({
          userId: req.user.id,
          favoriteId: req.validated.favoriteId,
          stake: req.validated.stake,
          overrides: req.validated.overrides || {},
        });
        res.status(201).json({ challenge });
      } catch (err) { handleChallengeError(err, res); }
    });

  // --- Admin hero restrictions (before /:id) ---

  router.get('/hero-restrictions', (req, res) => {
    res.json({ restrictions: repo.listActiveRestrictions() });
  });

  router.post('/hero-restrictions', requirePermission('hero_restrictions.manage'),
    validate(z.object({
      heroName: z.string().min(1).max(100),
      restriction: z.enum(['allowed', 'banned']),
      reason: z.string().min(1).max(500),
    })),
    (req, res) => {
      try {
        const restriction = service.createHeroRestriction({
          heroName: req.validated.heroName,
          restriction: req.validated.restriction,
          reason: req.validated.reason,
          createdBy: req.user.id,
        });
        auditRepo.recordAudit({
          actorId: req.user.id, actorEmail: req.user.email, action: 'hero_restriction.created',
          targetType: 'hero_restriction', targetId: restriction.id,
          details: { heroName: restriction.heroName, restriction: restriction.restriction },
        });
        res.status(201).json({ restriction });
      } catch (err) { handleChallengeError(err, res); }
    });

  router.put('/hero-restrictions/:id', requirePermission('hero_restrictions.manage'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    validate(z.object({
      restriction: z.enum(['allowed', 'banned']).optional(),
      reason: z.string().min(1).max(500).optional(),
      active: z.boolean().optional(),
    })),
    (req, res) => {
      const updated = repo.updateRestriction(req.validatedParams.id, req.validated);
      if (!updated) return res.status(404).json({ error: 'Hero restriction not found' });
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'hero_restriction.updated',
        targetType: 'hero_restriction', targetId: updated.id, details: req.validated,
      });
      res.json({ restriction: updated });
    });

  // --- Challenge board ---

  router.post('/', validate(challengeSchema), (req, res) => {
    try {
      const challenge = service.createChallenge({
        creatorId: req.user.id,
        stake: req.validated.stake,
        arena: req.validated.arena,
        teamSize: req.validated.teamSize,
        heroRule: req.validated.heroRule,
        requiredHero: req.validated.requiredHero ?? null,
        heroBans: req.validated.heroBans || [],
        customRules: req.validated.customRules || '',
        rankRestriction: req.validated.rankRestriction || { type: 'none' },
      });
      res.status(201).json({ challenge });
    } catch (err) { handleChallengeError(err, res); }
  });

  router.get('/', (req, res) => {
    const { arena, teamSize, heroRule, rankTier, since } = req.query;
    if (arena && !repo.ARENAS.includes(arena)) return res.status(400).json({ error: `arena must be one of ${repo.ARENAS.join(', ')}` });
    if (teamSize && !repo.TEAM_SIZES.includes(teamSize)) return res.status(400).json({ error: `teamSize must be one of ${repo.TEAM_SIZES.join(', ')}` });
    if (heroRule && !repo.HERO_RULES.includes(heroRule)) return res.status(400).json({ error: `heroRule must be one of ${repo.HERO_RULES.join(', ')}` });
    if (rankTier && !RANK_TIERS.includes(rankTier)) return res.status(400).json({ error: `rankTier must be one of ${RANK_TIERS.join(', ')}` });
    const coin = req.query.coin !== undefined ? Number(req.query.coin) : undefined;
    const coinMin = req.query.coinMin !== undefined ? Number(req.query.coinMin) : undefined;
    const coinMax = req.query.coinMax !== undefined ? Number(req.query.coinMax) : undefined;
    if ((coin !== undefined && !Number.isInteger(coin)) || (coinMin !== undefined && !Number.isFinite(coinMin)) || (coinMax !== undefined && !Number.isFinite(coinMax))) {
      return res.status(400).json({ error: 'coin filters must be numbers' });
    }
    res.json(repo.listChallenges({
      arena, teamSize, heroRule, rankTier, since: since || undefined,
      coin, coinMin, coinMax, ...parsePagination(req),
    }));
  });

  const challengeIdParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));

  router.get('/:id', challengeIdParams, (req, res) => {
    const challenge = repo.findChallenge(req.validatedParams.id);
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ challenge, matchRoom: repo.findMatchRoomByChallenge(challenge.id) });
  });

  router.post('/:id/accept', challengeIdParams, (req, res) => {
    try {
      const { challenge, matchRoom } = service.acceptChallenge({
        challengeId: req.validatedParams.id, accepterId: req.user.id,
      });
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'challenge.accepted',
        targetType: 'challenge', targetId: challenge.id,
        details: { stake: challenge.stake, matchRoomId: matchRoom.id },
      });
      res.json({ challenge, matchRoom });
    } catch (err) { handleChallengeError(err, res); }
  });

  router.post('/:id/cancel', challengeIdParams, (req, res) => {
    try {
      const challenge = service.cancelChallenge({
        challengeId: req.validatedParams.id, userId: req.user.id,
      });
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'challenge.cancelled',
        targetType: 'challenge', targetId: challenge.id,
      });
      res.json({ challenge });
    } catch (err) { handleChallengeError(err, res); }
  });

  return router;
}

module.exports = { buildChallengeRouter };
