'use strict';
// Challenge business logic. Validation that is purely about shape lives in
// the routes (zod); everything about rules lives here so the same checks
// apply to direct creation and to creation from a favorite.
//
// Admin hero-restriction conflict rule (documented in the README):
//  - A challenge may NOT ban a hero that an active admin restriction
//    marks 'allowed'.
//  - A challenge may NOT require (requiredHero) a hero that an active
//    admin restriction marks 'banned'.
//  - Banning a globally banned hero is consistent, not a conflict, and
//    requiring a globally allowed hero is consistent, not a conflict.
//  - Player custom-rules text is free text: it is never parsed as a hero
//    requirement and it never overrides an admin restriction. The
//    machine-readable requiredHero field is the only way to require a
//    hero, so that is what the banned-hero check inspects.
// Rank rule: a restricted challenge requires the creator's rank to be set
// at creation (otherwise same-rank/range cannot be evaluated); at accept
// time the accepter's rank must be set, and must equal the creator's
// current rank for same_rank_only, or lie inside the range for range.
// 'none' accepts any rank, including an unset one.
const { getDb } = require('../db');
const repo = require('../db/repos/challenges');
const usersRepo = require('../db/repos/users');
const walletService = require('./wallet');

class ChallengeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanHeroName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function normalizeHeroBans(heroBans) {
  if (!Array.isArray(heroBans)) throw new ChallengeError(400, 'heroBans must be an array');
  if (heroBans.length > 20) throw new ChallengeError(400, 'heroBans may contain at most 20 heroes');
  const cleaned = heroBans.map(cleanHeroName);
  for (const hero of cleaned) {
    if (!hero) throw new ChallengeError(400, 'heroBans entries must be non-empty strings');
    if (hero.length > 100) throw new ChallengeError(400, 'heroBans entries must be at most 100 characters');
  }
  const lowered = cleaned.map((h) => h.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    throw new ChallengeError(400, 'heroBans must not contain duplicate heroes');
  }
  return cleaned;
}

// Shared rule validation for a challenge and for a favorite (favorites
// have no stake). Returns a normalised copy; throws ChallengeError(400).
function validateRuleSet(input) {
  const arena = input.arena;
  const teamSize = input.teamSize;
  if (!repo.ARENAS.includes(arena)) throw new ChallengeError(400, `arena must be one of ${repo.ARENAS.join(', ')}`);
  if (!repo.TEAM_SIZES.includes(teamSize)) throw new ChallengeError(400, `teamSize must be one of ${repo.TEAM_SIZES.join(', ')}`);
  if (arena === '1v1' && teamSize !== '1v1') {
    throw new ChallengeError(400, 'Arena 1v1 requires team size 1v1');
  }
  if (!repo.HERO_RULES.includes(input.heroRule)) {
    throw new ChallengeError(400, `heroRule must be one of ${repo.HERO_RULES.join(', ')}`);
  }
  const heroBans = normalizeHeroBans(input.heroBans || []);
  const requiredHero = input.requiredHero == null ? null : cleanHeroName(input.requiredHero);
  if (input.requiredHero != null && !requiredHero) {
    throw new ChallengeError(400, 'requiredHero must be a non-empty string');
  }
  if (requiredHero && heroBans.some((h) => h.toLowerCase() === requiredHero.toLowerCase())) {
    throw new ChallengeError(400, 'requiredHero cannot also be in heroBans');
  }
  const customRules = input.customRules == null ? '' : input.customRules;
  if (typeof customRules !== 'string' || customRules.length > 2000) {
    throw new ChallengeError(400, 'customRules must be at most 2000 characters');
  }
  const type = input.rankRestriction?.type || 'none';
  const minTier = input.rankRestriction?.minTier ?? null;
  const maxTier = input.rankRestriction?.maxTier ?? null;
  if (!['none', 'same_rank_only', 'range'].includes(type)) {
    throw new ChallengeError(400, 'rankRestriction.type must be none, same_rank_only, or range');
  }
  if (type === 'none' || type === 'same_rank_only') {
    if (minTier != null || maxTier != null) {
      throw new ChallengeError(400, `rankRestriction minTier/maxTier must be empty for ${type}`);
    }
  } else {
    if (minTier == null || maxTier == null) {
      throw new ChallengeError(400, 'rankRestriction range requires both minTier and maxTier');
    }
    if (!repo.RANK_TIERS.includes(minTier) || !repo.RANK_TIERS.includes(maxTier)) {
      throw new ChallengeError(400, `rank tiers must be one of ${repo.RANK_TIERS.join(', ')}`);
    }
    if (repo.rankIndex(minTier) > repo.rankIndex(maxTier)) {
      throw new ChallengeError(400, 'rankRestriction minTier must not be above maxTier');
    }
  }
  if ((type === 'same_rank_only' || type === 'range') && minTier != null && !repo.RANK_TIERS.includes(minTier)) {
    throw new ChallengeError(400, 'Invalid rank tier');
  }
  return {
    arena, teamSize, heroRule: input.heroRule, requiredHero,
    heroBans, customRules,
    rankRestriction: { type, minTier: type === 'range' ? minTier : null, maxTier: type === 'range' ? maxTier : null },
  };
}

function checkAdminConflicts(rules) {
  for (const banned of rules.heroBans) {
    const restriction = repo.findActiveRestrictionForHero(banned);
    if (restriction && restriction.restriction === 'allowed') {
      throw new ChallengeError(400, `Cannot ban hero ${banned}: an admin restriction marks it allowed`);
    }
  }
  if (rules.requiredHero) {
    const restriction = repo.findActiveRestrictionForHero(rules.requiredHero);
    if (restriction && restriction.restriction === 'banned') {
      throw new ChallengeError(400, `Cannot require hero ${rules.requiredHero}: an admin restriction bans it`);
    }
  }
}

function createChallenge({ creatorId, stake, ...rulesInput }) {
  if (!Number.isInteger(stake) || stake <= 0) {
    throw new ChallengeError(400, 'stake must be a positive integer');
  }
  const rules = validateRuleSet(rulesInput);
  checkAdminConflicts(rules);
  const creator = usersRepo.findById(creatorId);
  if (!creator) throw new ChallengeError(404, 'Creator not found');
  if (rules.rankRestriction.type !== 'none' && !creator.rank_tier) {
    throw new ChallengeError(400, 'A rank-restricted challenge requires the creator to set a rank tier first');
  }
  const created = repo.createChallengeWithCreator({ creatorId, stake, ...rules });
  return repo.findChallenge(created.id);
}

function checkRankForAccept(challenge, creator, accepter) {
  const type = challenge.rankRestriction.type;
  if (type === 'none') return;
  if (!accepter.rank_tier) {
    throw new ChallengeError(400, 'This challenge has a rank restriction and your rank tier is not set');
  }
  if (type === 'same_rank_only') {
    if (!creator.rank_tier) {
      throw new ChallengeError(400, 'This challenge has a rank restriction and the creator rank tier is not set');
    }
    if (accepter.rank_tier !== creator.rank_tier) {
      throw new ChallengeError(400, `This challenge is same-rank only (${creator.rank_tier}); your rank is ${accepter.rank_tier}`);
    }
    return;
  }
  // range
  const idx = repo.rankIndex(accepter.rank_tier);
  const min = repo.rankIndex(challenge.rankRestriction.minTier);
  const max = repo.rankIndex(challenge.rankRestriction.maxTier);
  if (idx < min || idx > max) {
    throw new ChallengeError(400, `This challenge is restricted to ranks ${challenge.rankRestriction.minTier} to ${challenge.rankRestriction.maxTier}; your rank is ${accepter.rank_tier}`);
  }
}

// Atomic accept. The whole flow — status check, rank check, balance
// checks, both locks, status change, participant and match-room rows —
// runs inside one better-sqlite3 transaction (wallet locks nest as
// savepoints inside it, as in Part 2). Any failure rolls everything
// back, so a failed accept locks no coins. A second accept sees the
// status already 'matched' and fails, so it cannot double-lock.
function acceptChallenge({ challengeId, accepterId }) {
  // Part 8 agreement gate: off by default (agreement_required = false),
  // so Parts 1-7 behaviour is unchanged unless an owner turns it on.
  // When on, the accepter must have accepted the current match_rules
  // version before accepting — checked before any coin is locked.
  try {
    const settingsRepo = require('../db/repos/settings');
    const part8Repo = require('../db/repos/part8');
    if (settingsRepo.getSetting('agreement_required') === true) {
      const doc = part8Repo.currentDocument('match_rules');
      if (doc && !part8Repo.hasAccepted(accepterId, doc.id)) {
        throw new ChallengeError(403, 'You must accept the current match rules before accepting a challenge');
      }
    }
  } catch (err) {
    if (err instanceof ChallengeError) throw err;
    // If the Part 8 tables do not exist yet (a database created before
    // migration 008 — not possible in practice, since migrations run
    // before any request), do not block the accept on a schema error.
    if (!String(err.message || '').includes('no such table')) throw err;
  }
  const db = getDb();
  const run = db.transaction(() => {
    const challenge = repo.findChallenge(challengeId);
    if (!challenge) throw new ChallengeError(404, 'Challenge not found');
    if (challenge.creatorId === accepterId) {
      throw new ChallengeError(400, 'You cannot accept your own challenge');
    }
    if (challenge.status !== 'open') {
      throw new ChallengeError(409, `Challenge is ${challenge.status}, not open`);
    }
    const creator = usersRepo.findById(challenge.creatorId);
    const accepter = usersRepo.findById(accepterId);
    if (!creator || !accepter) throw new ChallengeError(404, 'User not found');
    checkRankForAccept(challenge, creator, accepter);
    const creatorBalance = walletService.getBalance(creator.id);
    const accepterBalance = walletService.getBalance(accepter.id);
    if (creatorBalance.available < challenge.stake) {
      throw new ChallengeError(400, 'The creator no longer has enough available coins for this stake');
    }
    if (accepterBalance.available < challenge.stake) {
      throw new ChallengeError(400, 'Insufficient available balance for this stake');
    }
    const reference = `challenge:${challenge.id}`;
    walletService.lockCoins({
      userId: creator.id, amount: challenge.stake, reference,
      reason: `Challenge #${challenge.id} stake lock (creator)`,
      idempotencyKey: `challenge:${challenge.id}:lock:${creator.id}`,
    });
    walletService.lockCoins({
      userId: accepter.id, amount: challenge.stake, reference,
      reason: `Challenge #${challenge.id} stake lock (accepter)`,
      idempotencyKey: `challenge:${challenge.id}:lock:${accepter.id}`,
    });
    repo.updateChallengeStatus(challenge.id, 'matched', accepter.id);
    repo.addParticipant(challenge.id, accepter.id, 'accepter');
    const matchRoom = repo.createMatchRoom({
      challengeId: challenge.id, creatorId: creator.id, accepterId: accepter.id, stake: challenge.stake,
    });
    return { challenge: repo.findChallenge(challenge.id), matchRoom };
  });
  return run();
}

function cancelChallenge({ challengeId, userId }) {
  const challenge = repo.findChallenge(challengeId);
  if (!challenge) throw new ChallengeError(404, 'Challenge not found');
  if (challenge.creatorId !== userId) {
    throw new ChallengeError(403, 'Only the creator can cancel this challenge');
  }
  if (challenge.status !== 'open') {
    throw new ChallengeError(409, `Cannot cancel a ${challenge.status} challenge in Part 3`);
  }
  repo.updateChallengeStatus(challengeId, 'cancelled');
  return repo.findChallenge(challengeId);
}

function createFavorite({ userId, name, ...rulesInput }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new ChallengeError(400, 'Favorite name must be a non-empty string of at most 100 characters');
  }
  const rules = validateRuleSet(rulesInput);
  checkAdminConflicts(rules);
  return repo.createFavorite({ userId, name: name.trim(), ...rules });
}

function createChallengeFromFavorite({ userId, favoriteId, stake, overrides = {} }) {
  const favorite = repo.findFavorite(favoriteId);
  if (!favorite) throw new ChallengeError(404, 'Favorite not found');
  if (favorite.userId !== userId) throw new ChallengeError(403, 'This favorite belongs to another player');
  const merged = {
    arena: overrides.arena !== undefined ? overrides.arena : favorite.arena,
    teamSize: overrides.teamSize !== undefined ? overrides.teamSize : favorite.teamSize,
    heroRule: overrides.heroRule !== undefined ? overrides.heroRule : favorite.heroRule,
    requiredHero: overrides.requiredHero !== undefined ? overrides.requiredHero : favorite.requiredHero,
    heroBans: overrides.heroBans !== undefined ? overrides.heroBans : favorite.heroBans,
    customRules: overrides.customRules !== undefined ? overrides.customRules : favorite.customRules,
    rankRestriction: overrides.rankRestriction !== undefined ? overrides.rankRestriction : favorite.rankRestriction,
  };
  return createChallenge({ creatorId: userId, stake, ...merged });
}

function createHeroRestriction({ heroName, restriction, reason, createdBy }) {
  const hero = cleanHeroName(heroName);
  if (!hero || hero.length > 100) throw new ChallengeError(400, 'heroName must be a non-empty string of at most 100 characters');
  if (!['allowed', 'banned'].includes(restriction)) {
    throw new ChallengeError(400, "restriction must be 'allowed' or 'banned'");
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
    throw new ChallengeError(400, 'reason must be a non-empty string of at most 500 characters');
  }
  const existing = repo.findActiveRestrictionForHero(hero);
  if (existing) {
    throw new ChallengeError(409, `An active hero restriction already exists for ${existing.heroName}`);
  }
  return repo.createRestriction({ heroName: hero, restriction, reason: reason.trim(), createdBy });
}

module.exports = {
  ChallengeError, RANK_TIERS: repo.RANK_TIERS,
  validateRuleSet, checkAdminConflicts,
  createChallenge, acceptChallenge, cancelChallenge,
  createFavorite, createChallengeFromFavorite, createHeroRestriction,
};
