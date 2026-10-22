'use strict';
// Referral codes: short, uppercase, unambiguous characters only
// (no I, O, 0, 1, so a code read over the phone cannot be confused).
// Uniqueness is enforced by the database UNIQUE index; callers retry
// on a collision (see usersRepo.createUser).
const crypto = require('crypto');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += CHARSET[bytes[i] % CHARSET.length];
  return code;
}

function normalizeReferralCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

module.exports = { generateReferralCode, normalizeReferralCode };
