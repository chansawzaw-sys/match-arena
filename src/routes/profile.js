'use strict';
// Minimal profile endpoint for Part 3 only: a user sets their own rank
// tier. Full profiles, teams, achievements and avatars are Part 7 and
// are deliberately not built here.
const express = require('express');
const { z, validate } = require('../middleware/validate');
const { authenticate } = require('../auth/middleware');
const usersRepo = require('../db/repos/users');
const repo = require('../db/repos/challenges');

function buildProfileRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  router.put('/rank', validate(z.object({
    rankTier: z.enum(repo.RANK_TIERS).nullable(),
  })), (req, res) => {
    const updated = usersRepo.setRankTier(req.user.id, req.validated.rankTier);
    res.json({ user: usersRepo.publicUser(updated) });
  });

  // Part 4: game IDs shown in a match room for one-tap copy. Digits
  // only: MLBB ID 5-12 digits, server ID 3-6 digits. Either field may
  // be null to clear it; both are set together by this endpoint.
  router.put('/game-ids', validate(z.object({
    mlbbId: z.string().regex(/^\d{5,12}$/).nullable(),
    serverId: z.string().regex(/^\d{3,6}$/).nullable(),
  })), (req, res) => {
    const updated = usersRepo.setGameIds(req.user.id, req.validated.mlbbId, req.validated.serverId);
    res.json({ user: usersRepo.publicUser(updated) });
  });

  return router;
}

module.exports = { buildProfileRouter };
