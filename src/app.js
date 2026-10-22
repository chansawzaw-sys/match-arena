'use strict';
// Express app factory. Tests pass a config with a temporary DB path and a
// production flag, so they never touch the real database or real secrets.
// Production mode is refused a demo login by config, not by a route check
// that could be bypassed.
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./db');
const { buildAuthRouter } = require('./routes/auth');
const { buildAdminRouter } = require('./routes/admin');
const { buildWalletRouter } = require('./routes/wallet');
const { buildChallengeRouter } = require('./routes/challenges');
const { buildProfileRouter } = require('./routes/profile');
const { buildMatchRoomRouter } = require('./routes/matchRooms');
const { buildNotificationRouter } = require('./routes/notifications');
const { buildResultsRouter } = require('./routes/results');
const { buildReferralsRouter } = require('./routes/referrals');
const { buildPart7Router } = require('./routes/part7');
const { buildPart8Router } = require('./routes/part8');
const { buildPart9Router } = require('./routes/part9');
const part8Service = require('./services/part8');
const { notFound, errorHandler } = require('./middleware/validate');

// Part 8 maintenance/emergency guard: player-facing writes are
// blocked while a flag is on, while admin routes, reads, and
// result/dispute flows continue. This runs before the routers (which
// do their own auth), so a blocked write returns 503 with the
// maintenance message instead of reaching a router.
const MAINTENANCE_BLOCKED = [
  /^\/challenges$/,
  /^\/challenges\/\d+\/accept$/,
  /^\/wallet\/purchases$/,
  /^\/tournaments\/\d+\/register$/,
  /^\/referrals\/attach$/,
];
const EMERGENCY_BLOCKED = [
  /^\/challenges$/,
  /^\/challenges\/\d+\/accept$/,
  /^\/wallet\/purchases$/,
  /^\/wallet\/users\/\d+\/adjust$/,
  /^\/referrals\/attach$/,
];
function modeGuard(req, res, next) {
  if (req.method !== 'POST') return next();
  if (part8Service.isMaintenanceEnabled() && MAINTENANCE_BLOCKED.some((re) => re.test(req.path))) {
    const info = part8Service.maintenanceInfo();
    return res.status(503).json({ error: 'Maintenance mode is enabled', maintenance: true, message: info.message || 'The site is under maintenance.' });
  }
  if (part8Service.isEmergencyEnabled() && EMERGENCY_BLOCKED.some((re) => re.test(req.path))) {
    return res.status(503).json({ error: 'Emergency mode is enabled', emergency: true });
  }
  return next();
}

function createApp(config) {
  initDb(config.dbPath);
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => res.json({ ok: true, part: 9, moneyMovementEnabled: false }));
  app.use(modeGuard);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.authRateLimitPer15Min,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts. Try again later.' },
  });
  app.use('/auth', authLimiter, buildAuthRouter(config));
  app.use('/admin', buildAdminRouter(config));
  app.use('/wallet', buildWalletRouter(config));
  app.use('/challenges', buildChallengeRouter(config));
  app.use('/profile', buildProfileRouter(config));
  app.use('/match-rooms', buildMatchRoomRouter(config));
  app.use('/notifications', buildNotificationRouter(config));
  // Part 8 router is mounted before the other / routers because its
  // Telegram webhook must be reachable without a user token: the
  // webhook route is defined before authenticate() inside the
  // router, and routers mounted at / authenticate every request
  // they see, so a later mount would 401 the webhook before it
  // could reach Part 8. Part 8 paths do not overlap earlier routes,
  // and unmatched requests fall through to the routers below.
  app.use('/', buildPart8Router(config));
  // Part 5 router carries full paths (/match-rooms/:id/results,
  // /disputes/..., /reports/..., /reputation/..., /match-history/...,
  // /evidence/...) and is mounted at / after the match-room router,
  // whose routes do not define those paths, so they fall through here.
  app.use('/', buildResultsRouter(config));
  // Part 6 router carries full paths (/referrals/..., /fees/...) and
  // is mounted at / after the results router, whose routes do not
  // define those paths, so they fall through here.
  app.use('/', buildReferralsRouter(config));
  // Part 7 router carries full paths (/profiles/..., /friends/...,
  // /teams/..., /tournaments/..., /leaderboards, /avatars/...) and
  // is mounted at / after the earlier routers, whose routes do not
  // define those paths, so they fall through here.
  app.use('/', buildPart7Router(config));
  app.use('/', buildPart9Router(config));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
