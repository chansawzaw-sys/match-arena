'use strict';
// Settings policy: which permission a key needs, and which keys can never
// be switched on in Part 1. Money movement is explicitly NOT enabled by
// Part 1, even by the owner — the owner may read the flags, but setting
// any of them to true is rejected here, not merely hidden in the UI.
const settingsRepo = require('../db/repos/settings');

const ALLOWED_KEYS = new Set([
  'platform_name', 'platform_tagline', 'maintenance_mode',
  'money_movement_enabled', 'paid_entry_enabled', 'withdrawals_enabled',
  'fee_policy_note', 'legal_approval',
  // Part 2 wallet settings. All are fee/wallet keys, hence owner-only
  // (see requiredPermissionForKey / isFeeOrWalletKey).
  'wallet.custom_min_coins', 'wallet.custom_max_coins', 'wallet.custom_price_per_coin',
  'match.countdown_seconds', 'match.ready_timeout_seconds', 'match.result_window_seconds',
  // Part 5 per-arena platform fees (owner-only via the fee. prefix).
  // Each value is { type: 'percent' | 'fixed', value: integer >= 0 }.
  // Default is percent 0: no fee. Part 6 adds fee preview/history on
  // top of this same service; it does not replace it.
  'fee.1v1', 'fee.Classic', 'fee.Brawl',
  // Part 6 referral commission rate (percent of the platform fee).
  // Owner-only via the referral. prefix; decimals allowed (0.5, 1, 2).
  // Snapshotted at room start, so a change affects only rooms
  // started after the change.
  'referral.commission_percent',
  // Part 8 agreement gate (owner-only, see requiredPermissionForKey).
  'agreement_required',
]);

const OWNER_ONLY_KEYS = new Set([
  'money_movement_enabled', 'paid_entry_enabled', 'withdrawals_enabled',
  'legal_approval',
]);

function isFeeOrWalletKey(key) {
  return key.startsWith('fee.') || key.startsWith('wallet.') || key.startsWith('referral.') || OWNER_ONLY_KEYS.has(key);
}

function requiredPermissionForKey(key) {
  if (key === 'legal_approval') return 'settings.update_legal';
  if (key === 'agreement_required') return 'settings.update_fee_wallet';
  if (isFeeOrWalletKey(key)) return 'settings.update_fee_wallet';
  return 'settings.update_general';
}

function validateSettingValue(key, value) {
  if (!ALLOWED_KEYS.has(key)) return `Unknown setting: ${key}`;
  if (key === 'referral.commission_percent') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      return 'referral.commission_percent must be a number between 0 and 100';
    }
    return null;
  }
  if (key === 'match.countdown_seconds') {
    if (!Number.isInteger(value) || value < 1 || value > 3600) return 'match.countdown_seconds must be an integer between 1 and 3600';
    return null;
  }
  if (key === 'match.ready_timeout_seconds') {
    if (!Number.isInteger(value) || value < 1 || value > 86400) return 'match.ready_timeout_seconds must be an integer between 1 and 86400';
    return null;
  }
  if (key === 'match.result_window_seconds') {
    // Default 300 (5 minutes). Tests may shorten it; production
    // should keep 300. 0 would open the window immediately, so it is
    // rejected — a window must exist.
    if (!Number.isInteger(value) || value < 1 || value > 86400) return 'match.result_window_seconds must be an integer between 1 and 86400';
    return null;
  }
  if (key.startsWith('fee.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${key} must be an object { type, value }`;
    if (value.type !== 'percent' && value.type !== 'fixed') return `${key}.type must be 'percent' or 'fixed'`;
    if (!Number.isInteger(value.value) || value.value < 0) return `${key}.value must be a non-negative integer`;
    if (value.type === 'percent' && value.value > 100) return `${key}.value for a percent fee cannot exceed 100`;
    return null;
  }
  if (['wallet.custom_min_coins', 'wallet.custom_max_coins', 'wallet.custom_price_per_coin'].includes(key)) {
    if (!Number.isInteger(value) || value < 0) return `${key} must be a non-negative integer`;
    if (key !== 'wallet.custom_price_per_coin' && value <= 0) return `${key} must be a positive integer`;
    // Cross-check the other bound so min can never exceed max.
    const otherKey = key === 'wallet.custom_min_coins' ? 'wallet.custom_max_coins'
      : key === 'wallet.custom_max_coins' ? 'wallet.custom_min_coins' : null;
    if (otherKey) {
      const other = settingsRepo.getSetting(otherKey);
      if (Number.isInteger(other)) {
        if (key === 'wallet.custom_min_coins' && value > other) return 'wallet.custom_min_coins cannot exceed wallet.custom_max_coins';
        if (key === 'wallet.custom_max_coins' && value < other) return 'wallet.custom_max_coins cannot be below wallet.custom_min_coins';
      }
    }
    return null;
  }
  if (['platform_name', 'platform_tagline', 'fee_policy_note'].includes(key) && typeof value !== 'string') {
    return `${key} must be a string`;
  }
  if (['maintenance_mode', 'money_movement_enabled', 'paid_entry_enabled', 'withdrawals_enabled', 'agreement_required'].includes(key) && typeof value !== 'boolean') {
    return `${key} must be a boolean`;
  }
  if (key === 'legal_approval') {
    return 'legal_approval is a recorded statement and cannot be edited through this endpoint';
  }
  // Part 1 money guard: these flags may only ever be false here.
  if (['money_movement_enabled', 'paid_entry_enabled', 'withdrawals_enabled'].includes(key) && value === true) {
    return `${key} cannot be enabled in Part 1 (no money movement in Part 1)`;
  }
  return null;
}

module.exports = { ALLOWED_KEYS, OWNER_ONLY_KEYS, isFeeOrWalletKey, requiredPermissionForKey, validateSettingValue, ...settingsRepo };
