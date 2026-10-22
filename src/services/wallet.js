'use strict';
// Wallet business logic. Every balance change goes through applyEntry(),
// which runs inside one better-sqlite3 transaction: the balance row and
// its append-only ledger row commit together or not at all, so a server
// error can never leave a half-applied transaction. Balances can never
// go negative: the service checks first, and the table CHECKs back it up.
//
// Idempotency: any credit/debit operation may carry an idempotency key.
// A replay of the same key for the same user returns the original ledger
// entry with replayed:true and applies nothing twice. Purchase approvals
// are idempotent a second way: the purchase row leaves 'pending' inside
// the same transaction as the credit, so a re-approve is a 409 conflict,
// never a second credit.
//
// Locking is wallet-level only. There is no public endpoint that lets a
// player lock or unlock anyone else's coins: these functions are the
// internal API a future match module will call, with a generic caller
// reference (for example a match reference). Tests exercise them directly.
const crypto = require('crypto');
const { getDb } = require('../db');
const walletRepo = require('../db/repos/wallet');
const settingsRepo = require('../db/repos/settings');

class WalletError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WalletError(400, `${field} must be a positive integer`);
  }
}

function requireReference(reference) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new WalletError(400, 'reference is required');
  }
  return reference.trim();
}

// Core atomic entry. deltas are signed: e.g. a purchase credit is
// (+amount, 0), a lock is (-amount, +amount), a refund is (+amount, -amount),
// a consume is (0, -amount). `amount` is the absolute size of the move,
// except for admin adjustments, where it is the signed change.
function applyEntry({ userId, type, amount, deltaAvailable, deltaLocked, actorId = null, reference, reason = '', idempotencyKey = null }) {
  const db = getDb();
  const run = db.transaction(() => {
    if (idempotencyKey) {
      const existing = walletRepo.findLedgerByIdempotency(userId, idempotencyKey);
      if (existing) return { entry: existing, balance: walletRepo.getBalance(userId), replayed: true };
    }
    const before = walletRepo.ensureBalance(userId);
    const available = before.available + deltaAvailable;
    const locked = before.locked + deltaLocked;
    if (available < 0) throw new WalletError(400, 'Insufficient available balance');
    if (locked < 0) throw new WalletError(400, 'Insufficient locked balance');
    const balance = walletRepo.updateBalance(userId, available, locked);
    const entry = walletRepo.insertLedgerEntry({
      transactionId: crypto.randomUUID(),
      userId, type, amount, deltaAvailable, deltaLocked,
      balanceAvailableAfter: balance.available, balanceLockedAfter: balance.locked,
      actorId, reference, reason, idempotencyKey,
    });
    return { entry, balance, replayed: false };
  });
  return run();
}

function getBalance(userId) {
  return walletRepo.getBalance(userId);
}

function listHistory(userId, opts) {
  return walletRepo.listLedger(userId, opts);
}

function creditCoins({ userId, amount, type = 'purchase_credit', actorId = null, reference, reason = '', idempotencyKey = null }) {
  requirePositiveInt(amount, 'amount');
  requireReference(reference);
  return applyEntry({ userId, type, amount, deltaAvailable: amount, deltaLocked: 0, actorId, reference, reason, idempotencyKey });
}

// Owner-only manual adjustment. amount is a signed change to available
// coins (positive = credit, negative = debit) and may never take the
// available balance below zero. Locked coins are never adjusted directly.
function adjustBalance({ userId, amount, actorId, reason, idempotencyKey = null }) {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new WalletError(400, 'amount must be a non-zero integer');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new WalletError(400, 'reason is required for a manual adjustment');
  }
  return applyEntry({
    userId, type: 'admin_adjustment', amount, deltaAvailable: amount, deltaLocked: 0,
    actorId, reference: 'admin_adjustment', reason: reason.trim(), idempotencyKey,
  });
}

function lockCoins({ userId, amount, reference, reason = '', actorId = null, idempotencyKey = null }) {
  requirePositiveInt(amount, 'amount');
  requireReference(reference);
  return applyEntry({ userId, type: 'lock', amount, deltaAvailable: -amount, deltaLocked: amount, actorId, reference, reason, idempotencyKey });
}

function unlockCoins({ userId, amount, reference, reason = '', actorId = null, idempotencyKey = null }) {
  requirePositiveInt(amount, 'amount');
  requireReference(reference);
  return applyEntry({ userId, type: 'unlock', amount, deltaAvailable: amount, deltaLocked: -amount, actorId, reference, reason, idempotencyKey });
}

// Refund of locked coins on cancellation: locked -> available. It is a
// distinct ledger type from a plain unlock so a cancelled match can be
// told apart from an ordinary release in history, but the arithmetic and
// the idempotency protection are identical.
function refundLockedCoins({ userId, amount, reference, reason = '', actorId = null, idempotencyKey = null }) {
  requirePositiveInt(amount, 'amount');
  requireReference(reference);
  return applyEntry({ userId, type: 'refund', amount, deltaAvailable: amount, deltaLocked: -amount, actorId, reference, reason, idempotencyKey });
}

// Settlement of locked coins when a match is completed: the locked coins
// leave the wallet entirely (the winner is credited separately, by the
// future match module, with its own idempotent entry). This is not a
// player endpoint.
function consumeLockedCoins({ userId, amount, reference, reason = '', actorId = null, idempotencyKey = null }) {
  requirePositiveInt(amount, 'amount');
  requireReference(reference);
  return applyEntry({ userId, type: 'consume', amount, deltaAvailable: 0, deltaLocked: -amount, actorId, reference, reason, idempotencyKey });
}

// --- Purchases ---

function customAmountBounds() {
  const min = settingsRepo.getSetting('wallet.custom_min_coins');
  const max = settingsRepo.getSetting('wallet.custom_max_coins');
  return {
    min: Number.isInteger(min) ? min : 100,
    max: Number.isInteger(max) ? max : 100000,
  };
}

function createPurchase({ userId, packageId, customCoins }) {
  if (packageId !== undefined && packageId !== null && customCoins !== undefined && customCoins !== null) {
    throw new WalletError(400, 'Choose either a package or a custom amount, not both');
  }
  if (packageId !== undefined && packageId !== null) {
    const pkg = walletRepo.findPackage(packageId);
    if (!pkg) throw new WalletError(404, 'Package not found');
    if (!pkg.active) throw new WalletError(400, 'Package is not active');
    return walletRepo.createPurchase({
      userId, packageId: pkg.id, source: 'package', packageName: pkg.name,
      coins: pkg.coins, priceAmount: pkg.priceAmount, priceCurrency: pkg.priceCurrency,
    });
  }
  if (customCoins === undefined || customCoins === null) {
    throw new WalletError(400, 'Choose either a package or a custom amount');
  }
  if (!Number.isInteger(customCoins) || customCoins <= 0) {
    throw new WalletError(400, 'Custom coin amount must be a positive integer');
  }
  const { min, max } = customAmountBounds();
  if (customCoins < min || customCoins > max) {
    throw new WalletError(400, `Custom coin amount must be between ${min} and ${max} coins`);
  }
  // No payment gateway in Part 2: the price of a custom request is
  // recorded only if the owner has set a per-coin price; otherwise it
  // stays null ("price to be confirmed by the owner") and approval still
  // credits exactly the requested coins. Package prices are snapshots.
  const pricePerCoin = settingsRepo.getSetting('wallet.custom_price_per_coin');
  const priceAmount = Number.isInteger(pricePerCoin) && pricePerCoin > 0 ? customCoins * pricePerCoin : null;
  return walletRepo.createPurchase({
    userId, packageId: null, source: 'custom', packageName: null,
    coins: customCoins, priceAmount, priceCurrency: 'MMK',
  });
}

// Decide a purchase. Approval credits the exact snapshot coins atomically
// with the status change; rejection touches no balance. Deciding an
// already-decided purchase is a 409, never a second credit.
function decidePurchase({ purchaseId, decision, reason = null, decidedBy }) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WalletError(400, "decision must be 'approve' or 'reject'");
  }
  if (decision === 'reject' && (typeof reason !== 'string' || reason.trim() === '')) {
    throw new WalletError(400, 'A reason is required to reject a purchase');
  }
  const db = getDb();
  const run = db.transaction(() => {
    const purchase = walletRepo.findPurchase(purchaseId);
    if (!purchase) throw new WalletError(404, 'Purchase not found');
    if (purchase.status !== 'pending') {
      throw new WalletError(409, `Purchase has already been ${purchase.status}`);
    }
    if (decision === 'reject') {
      const decided = walletRepo.decidePurchase(purchaseId, { status: 'rejected', decisionReason: reason.trim(), decidedBy });
      return { purchase: decided.purchase, entry: null };
    }
    // Credit inside the same transaction as the status change.
    const credited = creditCoins({
      userId: purchase.userId, amount: purchase.coins, type: 'purchase_credit',
      actorId: decidedBy, reference: `purchase:${purchaseId}`,
      reason: `Purchase #${purchaseId} approved`, idempotencyKey: `purchase:${purchaseId}`,
    });
    if (credited.replayed) {
      // A credit row for this purchase already exists: do not decide it
      // twice. This path should be unreachable because the status check
      // above runs in the same transaction, but it guards the invariant.
      throw new WalletError(409, `Purchase has already been ${purchase.status}`);
    }
    const decided = walletRepo.decidePurchase(purchaseId, {
      status: 'completed', decisionReason: reason ? reason.trim() : null,
      decidedBy, ledgerTransactionId: credited.entry.transactionId,
    });
    return { purchase: decided.purchase, entry: credited.entry };
  });
  return run();
}

module.exports = {
  WalletError, getBalance, listHistory, creditCoins, adjustBalance,
  lockCoins, unlockCoins, refundLockedCoins, consumeLockedCoins,
  customAmountBounds, createPurchase, decidePurchase,
};
