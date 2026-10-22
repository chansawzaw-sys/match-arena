'use strict';
// Challenge repository: the only place that reads/writes challenge,
// participant, match-room, favorite and hero-restriction tables.
// Routes never touch SQL; the service in src/services/challenges.js
// owns validation, rank checks, admin conflicts and the accept flow.
const { getDb } = require('../index');
const usersRepo = require('./users');

const RANK_TIERS = [
  'Warrior', 'Elite', 'Master', 'Grandmaster',
  'Epic', 'Legend', 'Mythic', 'Mythical Glory',
];
const ARENAS = ['1v1', 'Classic', 'Brawl'];
const TEAM_SIZES = ['1v1', '2v2', '3v3', '4v4', '5v5'];
const HERO_RULES = [
  'any', 'fighter_only', 'mage_only', 'assassin_only', 'marksman_only',
  'tank_only', 'support_only', 'same_hero_only', 'random_hero_only',
  'no_duplicate_hero',
];

function rankIndex(tier) {
  return tier == null ? null : RANK_TIERS.indexOf(tier);
}

function publicChallenge(row) {
  if (!row) return null;
  return {
    id: row.id,
    creatorId: row.creator_id,
    accepterId: row.accepter_id,
    arena: row.arena,
    teamSize: row.team_size,
    stake: row.stake,
    heroRule: row.hero_rule,
    requiredHero: row.required_hero,
    heroBans: (() => { try { return JSON.parse(row.hero_bans || '[]'); } catch { return []; } })(),
    customRules: row.custom_rules || '',
    rankRestriction: {
      type: row.rank_restriction_type,
      minTier: row.rank_min_tier,
      maxTier: row.rank_max_tier,
    },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    matchedAt: row.matched_at,
  };
}

function publicMatchRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    challengeId: row.challenge_id,
    arena: row.arena,
    teamSize: row.team_size,
    creatorId: row.creator_id,
    accepterId: row.accepter_id,
    stake: row.stake,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyDeadline: row.ready_deadline,
    countdownStartedAt: row.countdown_started_at,
    startedAt: row.started_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    resultWindowOpensAt: row.result_window_opens_at,
  };
}

function publicFavorite(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    arena: row.arena,
    teamSize: row.team_size,
    heroRule: row.hero_rule,
    requiredHero: row.required_hero,
    heroBans: (() => { try { return JSON.parse(row.hero_bans || '[]'); } catch { return []; } })(),
    customRules: row.custom_rules || '',
    rankRestriction: {
      type: row.rank_restriction_type,
      minTier: row.rank_min_tier,
      maxTier: row.rank_max_tier,
    },
    createdAt: row.created_at,
  };
}

function publicRestriction(row) {
  if (!row) return null;
  return {
    id: row.id,
    heroName: row.hero_name,
    restriction: row.restriction,
    reason: row.reason,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createChallengeWithCreator(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO challenges (creator_id, arena, team_size, stake, hero_rule,
         required_hero, hero_bans, custom_rules, rank_restriction_type,
         rank_min_tier, rank_max_tier, rank_min_index, rank_max_index,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      input.creatorId, input.arena, input.teamSize, input.stake, input.heroRule,
      input.requiredHero ?? null, JSON.stringify(input.heroBans || []),
      input.customRules || '', input.rankRestriction.type,
      input.rankRestriction.minTier ?? null, input.rankRestriction.maxTier ?? null,
      rankIndex(input.rankRestriction.minTier), rankIndex(input.rankRestriction.maxTier),
      now, now,
    );
    const id = result.lastInsertRowid;
    db.prepare(
      'INSERT INTO challenge_participants (challenge_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    ).run(id, input.creatorId, 'creator', now);
    return findChallengeRaw(id);
  });
  return publicChallenge(run());
}

function findChallengeRaw(id) {
  return getDb().prepare('SELECT * FROM challenges WHERE id = ?').get(id);
}

function findChallenge(id) {
  const row = findChallengeRaw(id);
  if (!row) return null;
  return detailForRow(row);
}

function participantsFor(challengeId) {
  // Two steps, not a JOIN with SELECT *: the users table and the
  // participants table both have a 'role' column (user role vs.
  // creator/accepter), and a joined row would let one overwrite the
  // other. Fetching the participant rows first and then the user rows
  // keeps both roles distinct.
  const rows = getDb().prepare(
    'SELECT * FROM challenge_participants WHERE challenge_id = ? ORDER BY joined_at ASC, user_id ASC',
  ).all(challengeId);
  return rows.map((r) => {
    const user = usersRepo.findById(r.user_id);
    return {
      userId: r.user_id,
      role: r.role,
      joinedAt: r.joined_at,
      user: user ? usersRepo.publicUser(user) : null,
    };
  });
}

function detailForRow(row) {
  const challenge = publicChallenge(row);
  const creator = usersRepo.findById(row.creator_id);
  const accepter = row.accepter_id ? usersRepo.findById(row.accepter_id) : null;
  return {
    ...challenge,
    creator: creator ? usersRepo.publicUser(creator) : null,
    accepter: accepter ? usersRepo.publicUser(accepter) : null,
    participants: participantsFor(row.id),
  };
}

function listChallenges({ arena, teamSize, heroRule, coin, coinMin, coinMax, rankTier, since, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (arena) { conditions.push('c.arena = ?'); params.push(arena); }
  if (teamSize) { conditions.push('c.team_size = ?'); params.push(teamSize); }
  if (heroRule) { conditions.push('c.hero_rule = ?'); params.push(heroRule); }
  if (coin !== undefined) { conditions.push('c.stake = ?'); params.push(coin); }
  if (coinMin !== undefined) { conditions.push('c.stake >= ?'); params.push(coinMin); }
  if (coinMax !== undefined) { conditions.push('c.stake <= ?'); params.push(coinMax); }
  if (since) { conditions.push('c.updated_at >= ?'); params.push(since); }
  if (rankTier !== undefined) {
    // Rank-tier filter means "open to a player of this tier": unrestricted
    // challenges, same-rank challenges created by a player of this tier,
    // and range challenges whose range contains this tier.
    const idx = rankIndex(rankTier);
    conditions.push(`(
      c.rank_restriction_type = 'none'
      OR (c.rank_restriction_type = 'same_rank_only' AND u.rank_tier = ?)
      OR (c.rank_restriction_type = 'range' AND c.rank_min_index <= ? AND c.rank_max_index >= ?)
    )`);
    params.push(rankTier, idx, idx);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT c.*, u.rank_tier AS creator_rank_tier FROM challenges c
     JOIN users u ON u.id = c.creator_id
     ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(
    `SELECT COUNT(*) AS n FROM challenges c JOIN users u ON u.id = c.creator_id ${where}`,
  ).get(...params).n;
  return {
    challenges: rows.map((row) => {
      const challenge = publicChallenge(row);
      const creator = usersRepo.findById(row.creator_id);
      return {
        ...challenge,
        creator: creator ? usersRepo.publicUser(creator) : null,
        participantCount: getDb().prepare(
          'SELECT COUNT(*) AS n FROM challenge_participants WHERE challenge_id = ?',
        ).get(row.id).n,
      };
    }),
    total,
  };
}

function updateChallengeStatus(id, status, accepterId = null) {
  const now = new Date().toISOString();
  if (status === 'matched') {
    getDb().prepare(
      'UPDATE challenges SET status = ?, accepter_id = ?, updated_at = ?, matched_at = ? WHERE id = ?',
    ).run(status, accepterId, now, now, id);
  } else {
    getDb().prepare(
      'UPDATE challenges SET status = ?, updated_at = ? WHERE id = ?',
    ).run(status, now, id);
  }
  return findChallengeRaw(id);
}

function addParticipant(challengeId, userId, role) {
  getDb().prepare(
    'INSERT INTO challenge_participants (challenge_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
  ).run(challengeId, userId, role, new Date().toISOString());
}

// Part 4: a room is created in 'waiting_ready' with a server-side
// ready deadline (5 minutes by default, from the match settings) and
// both leaders as roster participants. Part 3's 'created' status is
// superseded; the Part 3 test assertion was updated accordingly.
function createMatchRoom({ challengeId, creatorId, accepterId, stake }) {
  const db = getDb();
  const run = db.transaction(() => {
    const challenge = db.prepare('SELECT arena, team_size FROM challenges WHERE id = ?').get(challengeId);
    const now = new Date().toISOString();
    const settings = require('./settings');
    const timeout = settings.getSetting('match.ready_timeout_seconds');
    const timeoutSeconds = Number.isInteger(timeout) ? timeout : 300;
    const deadline = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
    const result = db.prepare(
      `INSERT INTO match_rooms (challenge_id, arena, team_size, creator_id, accepter_id, stake, status, created_at, updated_at, ready_deadline)
       VALUES (?, ?, ?, ?, ?, ?, 'waiting_ready', ?, ?, ?)`,
    ).run(challengeId, challenge.arena, challenge.team_size, creatorId, accepterId, stake, now, now, deadline);
    const roomId = result.lastInsertRowid;
    db.prepare('INSERT INTO match_room_participants (room_id, user_id, side, role, ready, joined_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(roomId, creatorId, 'A', 'leader', now);
    db.prepare('INSERT INTO match_room_participants (room_id, user_id, side, role, ready, joined_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(roomId, accepterId, 'B', 'leader', now);
    return publicMatchRoom(db.prepare('SELECT * FROM match_rooms WHERE id = ?').get(roomId));
  });
  return run();
}

function findMatchRoomByChallenge(challengeId) {
  return publicMatchRoom(
    getDb().prepare('SELECT * FROM match_rooms WHERE challenge_id = ?').get(challengeId),
  );
}

// --- Favorites ---

function createFavorite(input) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `INSERT INTO favorite_rules (user_id, name, arena, team_size, hero_rule,
       required_hero, hero_bans, custom_rules, rank_restriction_type,
       rank_min_tier, rank_max_tier, rank_min_index, rank_max_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.userId, input.name, input.arena, input.teamSize, input.heroRule,
    input.requiredHero ?? null, JSON.stringify(input.heroBans || []),
    input.customRules || '', input.rankRestriction.type,
    input.rankRestriction.minTier ?? null, input.rankRestriction.maxTier ?? null,
    rankIndex(input.rankRestriction.minTier), rankIndex(input.rankRestriction.maxTier),
    now,
  );
  return publicFavorite(getDb().prepare('SELECT * FROM favorite_rules WHERE id = ?').get(result.lastInsertRowid));
}

function findFavorite(id) {
  return publicFavorite(getDb().prepare('SELECT * FROM favorite_rules WHERE id = ?').get(id));
}

function listFavorites(userId) {
  return getDb().prepare('SELECT * FROM favorite_rules WHERE user_id = ? ORDER BY id DESC')
    .all(userId).map(publicFavorite);
}

function deleteFavorite(id, userId) {
  const row = getDb().prepare('SELECT * FROM favorite_rules WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  getDb().prepare('DELETE FROM favorite_rules WHERE id = ?').run(id);
  return true;
}

// --- Admin hero restrictions ---

function listActiveRestrictions() {
  return getDb().prepare('SELECT * FROM global_hero_restrictions WHERE active = 1 ORDER BY hero_name ASC')
    .all().map(publicRestriction);
}

function listAllRestrictions() {
  return getDb().prepare('SELECT * FROM global_hero_restrictions ORDER BY id ASC')
    .all().map(publicRestriction);
}

function findActiveRestrictionForHero(heroName) {
  return publicRestriction(getDb().prepare(
    'SELECT * FROM global_hero_restrictions WHERE active = 1 AND lower(hero_name) = lower(?)',
  ).get(heroName));
}

function createRestriction({ heroName, restriction, reason, createdBy }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `INSERT INTO global_hero_restrictions (hero_name, restriction, reason, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).run(heroName, restriction, reason, createdBy ?? null, now, now);
  return publicRestriction(getDb().prepare('SELECT * FROM global_hero_restrictions WHERE id = ?').get(result.lastInsertRowid));
}

function updateRestriction(id, changes) {
  const current = getDb().prepare('SELECT * FROM global_hero_restrictions WHERE id = ?').get(id);
  if (!current) return null;
  const next = {
    restriction: changes.restriction !== undefined ? changes.restriction : current.restriction,
    reason: changes.reason !== undefined ? changes.reason : current.reason,
    active: changes.active !== undefined ? (changes.active ? 1 : 0) : current.active,
  };
  getDb().prepare(
    'UPDATE global_hero_restrictions SET restriction = ?, reason = ?, active = ?, updated_at = ? WHERE id = ?',
  ).run(next.restriction, next.reason, next.active, new Date().toISOString(), id);
  return publicRestriction(getDb().prepare('SELECT * FROM global_hero_restrictions WHERE id = ?').get(id));
}

module.exports = {
  RANK_TIERS, ARENAS, TEAM_SIZES, HERO_RULES, rankIndex,
  createChallengeWithCreator, findChallenge, findChallengeRaw, listChallenges,
  updateChallengeStatus, addParticipant, createMatchRoom, findMatchRoomByChallenge,
  createFavorite, findFavorite, listFavorites, deleteFavorite,
  listActiveRestrictions, listAllRestrictions, findActiveRestrictionForHero,
  createRestriction, updateRestriction,
};
