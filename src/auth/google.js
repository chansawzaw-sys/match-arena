'use strict';
// Google OAuth 2.0 (authorization-code flow) using plain fetch — no extra
// dependency and no password ever stored for a Google user. If the three
// GOOGLE_* variables are not set, the routes fail closed with a clear
// 503 instead of pretending login works.
function googleAuthUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleCallbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForProfile(config, code) {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleCallbackUrl,
    grant_type: 'authorization_code',
  });
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!tokenRes.ok) throw new Error('Google token exchange failed');
  const tokens = await tokenRes.json();
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) throw new Error('Google userinfo fetch failed');
  const profile = await infoRes.json();
  if (!profile.sub || !profile.email) throw new Error('Google profile is missing id/email');
  return { googleId: profile.sub, email: profile.email, displayName: profile.name || profile.email, avatarUrl: profile.picture || null };
}

module.exports = { googleAuthUrl, exchangeCodeForProfile };
