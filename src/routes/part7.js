'use strict';
// Part 7 routes: full profiles, friends, teams, tournaments, brackets
// and leaderboards. Image uploads are real multipart uploads (images
// only, max 2 MB), stored under data/avatars/, data/team-logos/ and
// data/tournament-banners/ (gitignored) and served only to
// authenticated users via kind-checked endpoints — never public static
// and never by a client-supplied path.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const usersRepo = require('../db/repos/users');
const repo = require('../db/repos/part7');
const service = require('../services/part7');
const { Part7Error } = service;

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function makeUpload(dir) {
  const dest = path.join(__dirname, '..', '..', 'data', dir);
  const storage = multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(dest, { recursive: true }); cb(null, dest); },
    filename: (req, file, cb) => {
      const safe = String(file.originalname || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${crypto.randomUUID()}-${safe}`);
    },
  });
  return multer({ storage, limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
}
function singleUpload(dir, field) {
  const upload = makeUpload(dir);
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* gone */ } }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      return next();
    });
  };
}
function validateImageFile(file) {
  if (!file) return 'An image file is required';
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIMES.has(file.mimetype) || !ALLOWED_EXTS.has(ext)) return 'Image must be png, jpeg or webp';
  if (file.size > 2 * 1024 * 1024) return 'Image must be at most 2 MB';
  return null;
}
function deleteFile(file) { if (file) { try { fs.unlinkSync(file.path); } catch { /* gone */ } } }

function handleError(err, res) {
  if (err instanceof Part7Error) return res.status(err.status).json({ error: err.message });
  throw err;
}
function audit(req, action, targetType, targetId, details = {}) {
  auditRepo.recordAudit({ actorId: req.user.id, actorEmail: req.user.email, action, targetType, targetId, details });
}
function serveImage(kind, req, res, id) {
  const raw = repo.findImage(id);
  if (!raw || raw.kind !== kind) return res.status(404).json({ error: 'Image not found' });
  const base = path.resolve(path.join(__dirname, '..', '..', 'data'));
  const stored = path.resolve(raw.stored_path);
  if (!stored.startsWith(base)) return res.status(404).json({ error: 'Image not found' });
  return res.sendFile(stored, { headers: { 'Content-Type': raw.mime } });
}

const idParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));
const userIdParams = validateParams(z.object({ userId: z.coerce.number().int().positive() }));

function buildPart7Router(config) {
  const router = express.Router();
  router.use(authenticate(config));

  // --- Images (authenticated, kind-checked) ---
  router.get('/avatars/:id', idParams, (req, res) => serveImage('avatar', req, res, req.validatedParams.id));
  router.get('/team-logos/:id', idParams, (req, res) => serveImage('team_logo', req, res, req.validatedParams.id));
  router.get('/tournaments/:id/banner', idParams, (req, res) => {
    const t = repo.tournaments.findTournament(req.validatedParams.id);
    if (!t || !t.bannerUrl) return res.status(404).json({ error: 'Banner not found' });
    // Banner images are stored with owner_id = tournament id and kind
    // tournament_banner; serve the latest one.
    const { getDb } = require('../db');
    const row = getDb().prepare("SELECT * FROM profile_images WHERE kind = 'tournament_banner' AND owner_id = ? ORDER BY id DESC LIMIT 1").get(req.validatedParams.id);
    if (!row) return res.status(404).json({ error: 'Banner not found' });
    return serveImage('tournament_banner', req, res, row.id);
  });

  // --- Profiles ---
  router.get('/profiles/me', (req, res) => {
    try { res.json({ profile: service.getProfile(req.user.id, req.user) }); }
    catch (err) { handleError(err, res); }
  });
  router.get('/profiles/:userId', userIdParams, (req, res) => {
    try { res.json({ profile: service.getProfile(req.validatedParams.userId, req.user) }); }
    catch (err) { handleError(err, res); }
  });
  router.put('/profiles/me', validate(z.object({ displayName: z.string().min(1).max(50) })), (req, res) => {
    try {
      const profile = service.updateOwnProfile(req.user.id, req.validated.displayName);
      audit(req, 'profile.updated', 'user', req.user.id, {});
      res.json({ profile });
    } catch (err) { handleError(err, res); }
  });
  router.post('/profiles/me/avatar', singleUpload('avatars', 'avatar'), (req, res) => {
    try {
      const bad = validateImageFile(req.file);
      if (bad) { deleteFile(req.file); return res.status(400).json({ error: bad }); }
      const image = repo.addImage({ kind: 'avatar', ownerId: req.user.id, originalName: req.file.originalname, mime: req.file.mimetype, size: req.file.size, storedPath: req.file.path });
      usersRepo.setAvatarUrl(req.user.id, `/avatars/${image.id}`);
      audit(req, 'profile.avatar_updated', 'user', req.user.id, { imageId: image.id });
      res.status(201).json({ avatarUrl: `/avatars/${image.id}`, imageId: image.id });
    } catch (err) { deleteFile(req.file); handleError(err, res); }
  });

  // --- Friends ---
  router.post('/friends/requests', validate(z.object({ userId: z.number().int().positive() })), (req, res) => {
    try {
      const f = service.sendFriendRequest(req.user.id, req.validated.userId);
      audit(req, 'friend.request_sent', 'user', req.validated.userId, {});
      res.status(201).json({ friendship: f });
    } catch (err) { handleError(err, res); }
  });
  router.get('/friends', (req, res) => { res.json({ friends: repo.listFriends(req.user.id) }); });
  router.get('/friends/requests', (req, res) => { res.json(repo.listPending(req.user.id)); });
  router.post('/friends/requests/:id/accept', idParams, (req, res) => {
    try { res.json({ friendship: service.respondFriendRequest(req.validatedParams.id, req.user.id, true) }); }
    catch (err) { handleError(err, res); }
  });
  router.post('/friends/requests/:id/reject', idParams, (req, res) => {
    try { res.json({ friendship: service.respondFriendRequest(req.validatedParams.id, req.user.id, false) }); }
    catch (err) { handleError(err, res); }
  });
  router.delete('/friends/:userId', userIdParams, (req, res) => {
    try { res.json(service.removeFriend(req.user.id, req.validatedParams.userId)); }
    catch (err) { handleError(err, res); }
  });

  // --- Teams ---
  router.post('/teams', validate(z.object({ name: z.string().min(1).max(100) })), (req, res) => {
    try {
      const team = service.createTeam(req.user.id, req.validated.name);
      audit(req, 'team.created', 'team', team.id, {});
      res.status(201).json({ team });
    } catch (err) { handleError(err, res); }
  });
  router.get('/teams/me', (req, res) => { res.json({ teams: repo.teamsForUser(req.user.id) }); });
  router.get('/teams/:id', idParams, (req, res) => {
    const team = repo.findTeam(req.validatedParams.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    return res.json({ team });
  });
  router.post('/teams/:id/logo', idParams, singleUpload('team-logos', 'logo'), (req, res) => {
    try {
      const team = repo.findTeam(req.validatedParams.id);
      if (!team) { deleteFile(req.file); return res.status(404).json({ error: 'Team not found' }); }
      if (team.leaderId !== req.user.id) { deleteFile(req.file); return res.status(403).json({ error: 'Only the team leader can set the logo' }); }
      const bad = validateImageFile(req.file);
      if (bad) { deleteFile(req.file); return res.status(400).json({ error: bad }); }
      const image = repo.addImage({ kind: 'team_logo', ownerId: team.id, originalName: req.file.originalname, mime: req.file.mimetype, size: req.file.size, storedPath: req.file.path });
      const updated = repo.setTeamLogo(team.id, `/team-logos/${image.id}`);
      audit(req, 'team.logo_updated', 'team', team.id, { imageId: image.id });
      res.status(201).json({ team: updated });
    } catch (err) { deleteFile(req.file); handleError(err, res); }
  });
  router.post('/teams/:id/invites', idParams, validate(z.object({ userId: z.number().int().positive() })), (req, res) => {
    try {
      const invite = service.inviteToTeam(req.validatedParams.id, req.user.id, req.validated.userId);
      audit(req, 'team.invite_sent', 'team', req.validatedParams.id, { inviteeId: req.validated.userId });
      res.status(201).json({ invite });
    } catch (err) { handleError(err, res); }
  });
  router.get('/teams/invites/mine', (req, res) => { res.json({ invites: repo.listTeamInvitesForUser(req.user.id) }); });
  router.post('/teams/invites/:id/accept', idParams, (req, res) => {
    try { res.json({ invite: service.respondTeamInvite(req.validatedParams.id, req.user.id, true) }); }
    catch (err) { handleError(err, res); }
  });
  router.post('/teams/invites/:id/reject', idParams, (req, res) => {
    try { res.json({ invite: service.respondTeamInvite(req.validatedParams.id, req.user.id, false) }); }
    catch (err) { handleError(err, res); }
  });
  router.delete('/teams/:id/members/:userId', validateParams(z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() })), (req, res) => {
    try {
      const team = service.removeTeamMember(req.validatedParams.id, req.user.id, req.validatedParams.userId);
      audit(req, 'team.member_removed', 'team', req.validatedParams.id, { removedUserId: req.validatedParams.userId });
      res.json({ team });
    } catch (err) { handleError(err, res); }
  });
  router.post('/teams/:id/leave', idParams, (req, res) => {
    try {
      const result = service.leaveTeam(req.validatedParams.id, req.user.id);
      audit(req, 'team.left', 'team', req.validatedParams.id, {});
      res.json(result);
    } catch (err) { handleError(err, res); }
  });
  // Match-room team add (only match-room change in Part 7).
  router.post('/match-rooms/:id/roster/team/:teamId', validateParams(z.object({ id: z.coerce.number().int().positive(), teamId: z.coerce.number().int().positive() })), (req, res) => {
    try {
      const result = service.addTeamToMatchRoom({ roomId: req.validatedParams.id, teamId: req.validatedParams.teamId, callerId: req.user.id });
      audit(req, 'match_room.team_roster_added', 'match_room', req.validatedParams.id, { teamId: req.validatedParams.teamId });
      res.json(result);
    } catch (err) { handleError(err, res); }
  });

  // --- Tournaments ---
  const tournamentInput = z.object({
    name: z.string().min(1).max(100),
    prizeDescription: z.string().max(2000).optional(),
    prizeCoins: z.number().int().min(0),
    rules: z.string().max(5000).optional(),
    registrationStart: z.string().min(1),
    registrationEnd: z.string().min(1),
    startTime: z.string().min(1),
    mode: z.enum(['solo', 'team']),
    teamSize: z.enum(['1v1', '2v2', '3v3', '4v4', '5v5']),
    maxRegistrants: z.number().int().positive().nullable().optional(),
  });
  router.post('/tournaments', validate(tournamentInput), (req, res) => {
    try {
      if (!['owner', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Only owner/admin can create a tournament' });
      const t = service.tournaments.createTournament(req.validated, req.user.id);
      audit(req, 'tournament.created', 'tournament', t.id, {});
      res.status(201).json({ tournament: t });
    } catch (err) { handleError(err, res); }
  });
  router.get('/tournaments', (req, res) => {
    res.json(repo.tournaments.listTournaments({ status: req.query.status || undefined, limit: Number(req.query.limit || 50), offset: Number(req.query.offset || 0) }));
  });
  router.get('/tournaments/:id', idParams, (req, res) => {
    const t = repo.tournaments.findTournament(req.validatedParams.id);
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    return res.json({ tournament: t });
  });
  router.put('/tournaments/:id', idParams, validate(tournamentInput.partial()), (req, res) => {
    try {
      const t = service.tournaments.editTournament(req.validatedParams.id, req.validated, req.user);
      audit(req, 'tournament.edited', 'tournament', t.id, {});
      res.json({ tournament: t });
    } catch (err) { handleError(err, res); }
  });
  router.post('/tournaments/:id/banner', idParams, singleUpload('tournament-banners', 'banner'), (req, res) => {
    try {
      const t = repo.tournaments.findTournament(req.validatedParams.id);
      if (!t) { deleteFile(req.file); return res.status(404).json({ error: 'Tournament not found' }); }
      if (!['owner', 'admin'].includes(req.user.role)) { deleteFile(req.file); return res.status(403).json({ error: 'Only owner/admin can set a tournament banner' }); }
      const bad = validateImageFile(req.file);
      if (bad) { deleteFile(req.file); return res.status(400).json({ error: bad }); }
      const image = repo.addImage({ kind: 'tournament_banner', ownerId: t.id, originalName: req.file.originalname, mime: req.file.mimetype, size: req.file.size, storedPath: req.file.path });
      const updated = repo.tournaments.setTournamentStatus(t.id, t.status, { bannerUrl: `/tournaments/${t.id}/banner` });
      audit(req, 'tournament.banner_updated', 'tournament', t.id, { imageId: image.id });
      res.status(201).json({ tournament: updated });
    } catch (err) { deleteFile(req.file); handleError(err, res); }
  });
  router.post('/tournaments/:id/open-registration', idParams, (req, res) => {
    try {
      const t = service.tournaments.openRegistration(req.validatedParams.id, req.user);
      audit(req, 'tournament.registration_opened', 'tournament', t.id, {});
      res.json({ tournament: t });
    } catch (err) { handleError(err, res); }
  });
  router.post('/tournaments/:id/cancel', idParams, (req, res) => {
    try {
      const t = service.tournaments.cancelTournament(req.validatedParams.id, req.user);
      audit(req, 'tournament.cancelled', 'tournament', t.id, {});
      res.json({ tournament: t });
    } catch (err) { handleError(err, res); }
  });
  router.post('/tournaments/:id/register', idParams, (req, res) => {
    try {
      const reg = service.tournaments.registerForTournament(req.validatedParams.id, req.user, req.body || {});
      audit(req, 'tournament.registered', 'tournament', req.validatedParams.id, { registrationId: reg.id });
      res.status(201).json({ registration: reg });
    } catch (err) { handleError(err, res); }
  });
  router.get('/tournaments/:id/registrations', idParams, (req, res) => {
    const t = repo.tournaments.findTournament(req.validatedParams.id);
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    return res.json({ registrations: repo.tournaments.listRegistrations(req.validatedParams.id) });
  });
  router.post('/tournaments/:id/registrations/:registrationId/cancel', validateParams(z.object({ id: z.coerce.number().int().positive(), registrationId: z.coerce.number().int().positive() })), (req, res) => {
    try {
      const reg = service.tournaments.cancelRegistration(req.validatedParams.id, req.validatedParams.registrationId, req.user);
      res.json({ registration: reg });
    } catch (err) { handleError(err, res); }
  });
  router.post('/tournaments/:id/start', idParams, (req, res) => {
    try {
      const result = service.tournaments.startTournament(req.validatedParams.id, req.user);
      audit(req, 'tournament.started', 'tournament', req.validatedParams.id, {});
      res.json(result);
    } catch (err) { handleError(err, res); }
  });
  router.get('/tournaments/:id/bracket', idParams, (req, res) => {
    const t = repo.tournaments.findTournament(req.validatedParams.id);
    if (!t) return res.status(404).json({ error: 'Tournament not found' });
    const matches = repo.tournaments.listBracketMatches(req.validatedParams.id);
    const rounds = {};
    for (const m of matches) { if (!rounds[m.round]) rounds[m.round] = []; rounds[m.round].push(m); }
    return res.json({ tournament: t, rounds, matches });
  });
  router.post('/tournaments/:tournamentId/bracket-matches/:matchId/winner', validateParams(z.object({ tournamentId: z.coerce.number().int().positive(), matchId: z.coerce.number().int().positive() })), validate(z.object({
    winnerType: z.enum(['player', 'team']), winnerId: z.number().int().positive(), reason: z.string().min(1).max(2000),
  })), (req, res) => {
    try {
      const result = service.tournaments.recordBracketWinner(req.validatedParams.matchId, req.user, req.validated.winnerType, req.validated.winnerId, req.validated.reason);
      audit(req, 'tournament.bracket_winner_recorded', 'tournament_bracket_match', req.validatedParams.matchId, { winnerId: req.validated.winnerId });
      res.json(result);
    } catch (err) { handleError(err, res); }
  });

  // --- Leaderboards ---
  router.get('/leaderboards', (req, res) => {
    try {
      const result = service.tournaments.leaderboard(
        req.query.category || 'top_player', req.query.period || 'all_time',
        Number(req.query.limit || 50), Number(req.query.offset || 0),
      );
      res.json(result);
    } catch (err) { handleError(err, res); }
  });

  return router;
}

module.exports = { buildPart7Router };
