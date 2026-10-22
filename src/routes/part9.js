'use strict';
// Part 9 routes: homepage stats and search, both authenticated and
// display-fields only. No staff statistics, no email, no wallet
// balances, and no private IDs beyond the MLBB ID that is already a
// room-display field (Part 4) are returned here.
const express = require('express');
const { getDb } = require('../db');
const { authenticate } = require('../auth/middleware');
const part7Service = require('../services/part7');
const part7Repo = require('../db/repos/part7');
const usersRepo = require('../db/repos/users');

function displayPlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? null,
    mlbbId: row.mlbb_id ?? null,
    serverId: row.server_id ?? null,
    rankTier: row.rank_tier ?? null,
  };
}

function buildPart9Router(config) {
  const router = express.Router();
  router.use(authenticate(config));

  router.get('/home', (req, res) => {
    const db = getDb();
    const count = (sql, ...params) => db.prepare(sql).get(...params).n;
    const openChallenges = count("SELECT COUNT(*) AS n FROM challenges WHERE status = 'open'");
    const activeMatchRooms = count(
      "SELECT COUNT(*) AS n FROM match_rooms WHERE status IN ('waiting_ready', 'countdown', 'started', 'result_pending', 'disputed')",
    );
    const completedMatches = count("SELECT COUNT(*) AS n FROM match_rooms WHERE status = 'finished'");
    const nextRow = db.prepare(
      "SELECT id, name, start_time, prize_coins, mode, team_size, status FROM tournaments WHERE status NOT IN ('completed', 'cancelled') AND start_time > ? ORDER BY start_time ASC LIMIT 1",
    ).get(new Date().toISOString());
    const nextTournament = nextRow ? {
      id: nextRow.id, name: nextRow.name, startTime: nextRow.start_time,
      prizeCoins: nextRow.prize_coins, mode: nextRow.mode, teamSize: nextRow.team_size,
      status: nextRow.status,
    } : null;
    let topPlayers = [];
    try {
      const lb = part7Service.tournaments.leaderboard('top_player', 'all_time', 5, 0);
      topPlayers = (lb.entries || []).map((e) => ({
        player: e.player ? { id: e.player.id, displayName: e.player.displayName, avatarUrl: e.player.avatarUrl ?? null, rankTier: e.player.rankTier ?? null } : null,
        wins: e.wins ?? null, losses: e.losses ?? null, winRate: e.winRate ?? null,
      }));
    } catch {
      topPlayers = [];
    }
    return res.json({
      openChallenges, activeMatchRooms, completedMatches, nextTournament, topPlayers,
    });
  });

  router.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 100) return res.status(400).json({ error: 'Search query must be 1-100 characters' });
    const db = getDb();
    const like = `%${q}%`;
    const players = db.prepare(
      'SELECT * FROM users WHERE display_name LIKE ? OR mlbb_id LIKE ? ORDER BY id ASC LIMIT 10',
    ).all(like, like).map(displayPlayer);
    const challenges = [];
    if (/^\d+$/.test(q)) {
      const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(Number(q));
      if (row) challenges.push({ id: row.id, arena: row.arena, teamSize: row.team_size, stake: row.stake, heroRule: row.hero_rule, status: row.status });
    } else {
      const rows = db.prepare('SELECT * FROM challenges WHERE arena LIKE ? ORDER BY id DESC LIMIT 10').all(like);
      for (const row of rows) challenges.push({ id: row.id, arena: row.arena, teamSize: row.team_size, stake: row.stake, heroRule: row.hero_rule, status: row.status });
    }
    const tournaments = db.prepare(
      'SELECT * FROM tournaments WHERE name LIKE ? ORDER BY id DESC LIMIT 10',
    ).all(like).map((row) => ({
      id: row.id, name: row.name, startTime: row.start_time, prizeCoins: row.prize_coins,
      mode: row.mode, teamSize: row.team_size, status: row.status,
    }));
    return res.json({ query: q, players, challenges, tournaments });
  });

  return router;
}

module.exports = { buildPart9Router, displayPlayer };
