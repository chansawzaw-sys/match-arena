'use strict';
// Configuration comes only from the environment. No secret is hard-coded.
// In production a JWT secret is mandatory; in development an ephemeral
// secret is generated at boot so tokens never survive a restart and no
// default secret ships in the codebase.
const crypto = require('crypto');

function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}

function loadConfig(env = process.env) {
  const production = isProduction(env);
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (production) {
      throw new Error('JWT_SECRET must be set when NODE_ENV=production');
    }
    jwtSecret = crypto.randomBytes(32).toString('hex');
  }
  return {
    nodeEnv: env.NODE_ENV || 'development',
    production,
    port: Number(env.PORT || 3000),
    jwtSecret,
    // Encryption key for TOTP secrets at rest. Falls back to a key derived
    // from the JWT secret (never a hard-coded value); set APP_ENCRYPTION_KEY
    // explicitly in a real deployment.
    encryptionKey: env.APP_ENCRYPTION_KEY
      ? crypto.createHash('sha256').update(env.APP_ENCRYPTION_KEY).digest()
      : crypto.createHash('sha256').update(`totp:${jwtSecret}`).digest(),
    dbPath: env.DB_PATH || './data/app.sqlite',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    googleCallbackUrl: env.GOOGLE_CALLBACK_URL || '',
    demoLoginEnabled: !production && env.DEMO_LOGIN_ENABLED !== 'false',
    corsOrigin: env.CORS_ORIGIN || 'http://localhost:3000',
    // Base URL used only to render the referral link template
    // (/signup?referral=CODE). Part 6 does not host a live signup
    // URL; the frontend replaces this base when it is deployed.
    publicBaseUrl: env.PUBLIC_BASE_URL || env.CORS_ORIGIN || 'http://localhost:3000',
    authRateLimitPer15Min: Number(env.AUTH_RATE_LIMIT_PER_15_MIN || 100),
  };
}

module.exports = { loadConfig, isProduction };
