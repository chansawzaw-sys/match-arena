'use strict';
// Wallet repository: the only place that reads/writes wallet tables.
// Routes never touch SQL; services call these functions inside a single
// better-sqlite3 transaction (see src/services/wallet.js), so a balance
// row and its ledger row always commit together or not at all.
const { getDb } = require('../index');

function publicBalance(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    available: row.available,
    locked: row.locked,
    total: row.available + row.locked,
    updatedAt: row.updated_at,
  };
}

function ensureBalance(userId) {
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT OR IGNORE INTO wallet_balances (user_id, available, locked, updated_at) VALUES (?, 0, 0, ?)',
  ).run(userId, now);
  return getDb().prepare('SELECT * FROM wallet_balances WHERE user_id = ?').get(userId);
}

function getBalance(userId) {
  return publicBalance(ensureBalance(userId));
}

function updateBalance(userId, available, locked) {
  getDb().prepare(
    'UPDATE wallet_balances SET available = ?, locked = ?, updated_at = ? WHERE user_id = ?',
  ).run(available, locked, new Date().toISOString(), userId);
  return getBalance(userId);
}

function publicLedgerEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    transactionId: row.transaction_id,
    userId: row.user_id,
    type: row.type,
    amount: row.amount,
    deltaAvailable: row.delta_available,
    deltaLocked: row.delta_locked,
    balanceAvailableAfter: row.balance_available_after,
    balanceLockedAfter: row.balance_locked_after,
    actorId: row.actor_id,
    reference: row.reference,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function insertLedgerEntry(entry) {
  const result = getDb().prepare(
    `INSERT INTO wallet_ledger (transaction_id, user_id, type, amount, delta_available,
       delta_locked, balance_available_after, balance_locked_after, actor_id,
       reference, reason, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.transactionId, entry.userId, entry.type, entry.amount,
    entry.deltaAvailable, entry.deltaLocked, entry.balanceAvailableAfter,
    entry.balanceLockedAfter, entry.actorId ?? null, entry.reference,
    entry.reason || '', entry.idempotencyKey ?? null, new Date().toISOString(),
  );
  return publicLedgerEntry(
    getDb().prepare('SELECT * FROM wallet_ledger WHERE id = ?').get(result.lastInsertRowid),
  );
}

function findLedgerByIdempotency(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const row = getDb().prepare(
    'SELECT * FROM wallet_ledger WHERE user_id = ? AND idempotency_key = ?',
  ).get(userId, idempotencyKey);
  return publicLedgerEntry(row);
}

function findLedgerByTransactionId(transactionId) {
  const row = getDb().prepare('SELECT * FROM wallet_ledger WHERE transaction_id = ?').get(transactionId);
  return publicLedgerEntry(row);
}

const LEDGER_TYPES = ['purchase_credit', 'admin_adjustment', 'lock', 'unlock', 'consume', 'refund'];

function listLedger(userId, { type, limit = 50, offset = 0 } = {}) {
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (type) { conditions.push('type = ?'); params.push(type); }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = getDb().prepare(
    `SELECT * FROM wallet_ledger ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM wallet_ledger ${where}`).get(...params).n;
  return { entries: rows.map(publicLedgerEntry), total };
}

// --- Coin packages ---

function publicPackage(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, coins: row.coins,
    priceAmount: row.price_amount, priceCurrency: row.price_currency,
    active: row.active === 1, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createPackage({ name, coins, priceAmount, priceCurrency, createdBy }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `INSERT INTO coin_packages (name, coins, price_amount, price_currency, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(name, coins, priceAmount, priceCurrency, createdBy ?? null, now, now);
  return publicPackage(getDb().prepare('SELECT * FROM coin_packages WHERE id = ?').get(result.lastInsertRowid));
}

function findPackage(id) {
  return publicPackage(getDb().prepare('SELECT * FROM coin_packages WHERE id = ?').get(id));
}

function updatePackage(id, changes) {
  const current = getDb().prepare('SELECT * FROM coin_packages WHERE id = ?').get(id);
  if (!current) return null;
  const next = {
    name: changes.name !== undefined ? changes.name : current.name,
    coins: changes.coins !== undefined ? changes.coins : current.coins,
    price_amount: changes.priceAmount !== undefined ? changes.priceAmount : current.price_amount,
    price_currency: changes.priceCurrency !== undefined ? changes.priceCurrency : current.price_currency,
    active: changes.active !== undefined ? (changes.active ? 1 : 0) : current.active,
  };
  getDb().prepare(
    'UPDATE coin_packages SET name = ?, coins = ?, price_amount = ?, price_currency = ?, active = ?, updated_at = ? WHERE id = ?',
  ).run(next.name, next.coins, next.price_amount, next.price_currency, next.active, new Date().toISOString(), id);
  return findPackage(id);
}

function listActivePackages() {
  return getDb().prepare('SELECT * FROM coin_packages WHERE active = 1 ORDER BY coins ASC').all().map(publicPackage);
}

function listAllPackages() {
  return getDb().prepare('SELECT * FROM coin_packages ORDER BY id ASC').all().map(publicPackage);
}

// --- Coin purchases ---

function publicPurchase(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, packageId: row.package_id, source: row.source,
    packageName: row.package_name, coins: row.coins,
    priceAmount: row.price_amount, priceCurrency: row.price_currency,
    status: row.status, decisionReason: row.decision_reason, decidedBy: row.decided_by,
    ledgerTransactionId: row.ledger_transaction_id,
    createdAt: row.created_at, decidedAt: row.decided_at,
  };
}

function createPurchase({ userId, packageId = null, source, packageName = null, coins, priceAmount = null, priceCurrency = 'MMK' }) {
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `INSERT INTO coin_purchases (user_id, package_id, source, package_name, coins,
       price_amount, price_currency, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(userId, packageId, source, packageName, coins, priceAmount, priceCurrency, now);
  return publicPurchase(getDb().prepare('SELECT * FROM coin_purchases WHERE id = ?').get(result.lastInsertRowid));
}

function findPurchase(id) {
  return publicPurchase(getDb().prepare('SELECT * FROM coin_purchases WHERE id = ?').get(id));
}

function decidePurchase(id, { status, decisionReason = null, decidedBy, ledgerTransactionId = null }) {
  // Only a pending purchase may be decided. The caller runs this inside
  // the same transaction as the credit, so a second approve cannot slip
  // in between the status check and the credit.
  const current = getDb().prepare('SELECT * FROM coin_purchases WHERE id = ?').get(id);
  if (!current) return null;
  if (current.status !== 'pending') return { conflict: true, purchase: publicPurchase(current) };
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE coin_purchases SET status = ?, decision_reason = ?, decided_by = ?,
       ledger_transaction_id = ?, decided_at = ? WHERE id = ?`,
  ).run(status, decisionReason, decidedBy ?? null, ledgerTransactionId, now, id);
  return { purchase: findPurchase(id) };
}

function listPurchases({ userId, status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM coin_purchases ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM coin_purchases ${where}`).get(...params).n;
  return { purchases: rows.map(publicPurchase), total };
}

module.exports = {
  LEDGER_TYPES, getBalance, ensureBalance, updateBalance, insertLedgerEntry,
  findLedgerByIdempotency, findLedgerByTransactionId, listLedger,
  createPackage, findPackage, updatePackage, listActivePackages, listAllPackages,
  createPurchase, findPurchase, decidePurchase, listPurchases,
};
