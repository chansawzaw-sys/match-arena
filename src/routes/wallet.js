'use strict';
// Coin wallet routes (Part 2). All routes are authenticated. Players may
// only touch their own wallet and purchases; staff powers come from the
// database permission matrix (owner/admin for lookups and purchase
// decisions, owner-only for direct balance adjustments and package
// management is shared with admin, wallet settings are owner-only via
// the settings endpoint). There is deliberately NO public lock/unlock
// endpoint: locking is an internal service for a future match module,
// so a player cannot unlock someone else's coins through the API.
// Ledger entries are immutable: there is no edit or delete endpoint.
const express = require('express');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const usersRepo = require('../db/repos/users');
const auditRepo = require('../db/repos/audit');
const walletRepo = require('../db/repos/wallet');
const walletService = require('../services/wallet');

const { WalletError } = walletService;

function parsePagination(req) {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 50,
    offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
  };
}

function handleWalletError(err, res) {
  if (err instanceof WalletError) return res.status(err.status).json({ error: err.message });
  throw err;
}

function buildWalletRouter(config) {
  const router = express.Router();
  router.use(authenticate(config));

  // --- Own wallet ---
  // These are self-scoped (req.user.id only), so authentication plus the
  // self scope is the access control; any role may hold its own wallet.
  // The wallet.view_own permission in the matrix documents that players
  // hold no staff wallet powers.

  router.get('/me', (req, res) => {
    res.json({ balance: walletService.getBalance(req.user.id) });
  });

  router.get('/me/history', (req, res) => {
    const type = req.query.type;
    if (type && !walletRepo.LEDGER_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown ledger type: ${type}` });
    }
    res.json(walletService.listHistory(req.user.id, { type, ...parsePagination(req) }));
  });

  router.get('/me/purchases', (req, res) => {
    const status = req.query.status;
    if (status && !['pending', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: `Unknown purchase status: ${status}` });
    }
    res.json(walletRepo.listPurchases({ userId: req.user.id, status, ...parsePagination(req) }));
  });

  // --- Packages: any authenticated user lists active ones ---

  router.get('/packages', (req, res) => {
    res.json({ packages: walletRepo.listActivePackages() });
  });

  // --- Purchase requests (own wallet only) ---

  router.post('/purchases',
    validate(z.object({
      packageId: z.number().int().positive().optional(),
      customCoins: z.number().int().optional(),
    })),
    (req, res) => {
      try {
        const purchase = walletService.createPurchase({
          userId: req.user.id,
          packageId: req.validated.packageId ?? null,
          customCoins: req.validated.customCoins ?? null,
        });
        auditRepo.recordAudit({
          actorId: req.user.id, actorEmail: req.user.email, action: 'purchase.requested',
          targetType: 'purchase', targetId: purchase.id,
          details: { coins: purchase.coins, source: purchase.source, packageId: purchase.packageId },
        });
        res.status(201).json({ purchase });
      } catch (err) { handleWalletError(err, res); }
    });

  // --- Staff lookups ---

  const userIdParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));

  router.get('/users/:id', requirePermission('wallet.view_all'), userIdParams, (req, res) => {
    const target = usersRepo.findById(req.validatedParams.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    res.json({ user: usersRepo.publicUser(target), balance: walletService.getBalance(target.id) });
  });

  router.get('/users/:id/history', requirePermission('wallet.view_all'), userIdParams, (req, res) => {
    const target = usersRepo.findById(req.validatedParams.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const type = req.query.type;
    if (type && !walletRepo.LEDGER_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown ledger type: ${type}` });
    }
    res.json(walletService.listHistory(target.id, { type, ...parsePagination(req) }));
  });

  router.get('/purchases', requirePermission('purchases.view_all'), (req, res) => {
    const status = req.query.status;
    if (status && !['pending', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: `Unknown purchase status: ${status}` });
    }
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    res.json(walletRepo.listPurchases({ userId, status, ...parsePagination(req) }));
  });

  // --- Owner-only direct adjustment ---

  router.post('/users/:id/adjust', requirePermission('wallet.adjust'), userIdParams,
    validate(z.object({
      amount: z.number().int(),
      reason: z.string().min(1).max(500),
      idempotencyKey: z.string().min(1).max(200).optional(),
    })),
    (req, res) => {
      const target = usersRepo.findById(req.validatedParams.id);
      if (!target) return res.status(404).json({ error: 'User not found' });
      try {
        const result = walletService.adjustBalance({
          userId: target.id, amount: req.validated.amount, actorId: req.user.id,
          reason: req.validated.reason, idempotencyKey: req.validated.idempotencyKey ?? null,
        });
        if (!result.replayed) {
          auditRepo.recordAudit({
            actorId: req.user.id, actorEmail: req.user.email, action: 'wallet.adjusted',
            targetType: 'user', targetId: target.id,
            details: { amount: req.validated.amount, reason: req.validated.reason, transactionId: result.entry.transactionId },
          });
        }
        res.json({ balance: result.balance, entry: result.entry, replayed: result.replayed });
      } catch (err) { handleWalletError(err, res); }
    });

  // --- Packages (owner/admin manage, player never writes) ---

  const packageSchema = z.object({
    name: z.string().min(1).max(100),
    coins: z.number().int().positive(),
    priceAmount: z.number().int().nonnegative(),
    priceCurrency: z.string().min(1).max(10),
    active: z.boolean().optional(),
  });

  router.post('/packages', requirePermission('wallet.packages_manage'),
    validate(packageSchema.omit({ active: true })),
    (req, res) => {
      const pkg = walletRepo.createPackage({ ...req.validated, createdBy: req.user.id });
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'wallet.package_created',
        targetType: 'package', targetId: pkg.id, details: { name: pkg.name, coins: pkg.coins, priceAmount: pkg.priceAmount },
      });
      res.status(201).json({ package: pkg });
    });

  router.put('/packages/:id', requirePermission('wallet.packages_manage'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    validate(z.object({
      name: z.string().min(1).max(100).optional(),
      coins: z.number().int().positive().optional(),
      priceAmount: z.number().int().nonnegative().optional(),
      priceCurrency: z.string().min(1).max(10).optional(),
      active: z.boolean().optional(),
    })),
    (req, res) => {
      const updated = walletRepo.updatePackage(req.validatedParams.id, req.validated);
      if (!updated) return res.status(404).json({ error: 'Package not found' });
      auditRepo.recordAudit({
        actorId: req.user.id, actorEmail: req.user.email, action: 'wallet.package_updated',
        targetType: 'package', targetId: updated.id, details: req.validated,
      });
      res.json({ package: updated });
    });

  // --- Purchase decisions (owner/admin; player never decides) ---

  router.post('/purchases/:id/decision', requirePermission('purchases.decide'),
    validateParams(z.object({ id: z.coerce.number().int().positive() })),
    validate(z.object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().min(1).max(500).optional(),
    })),
    (req, res) => {
      try {
        const { purchase, entry } = walletService.decidePurchase({
          purchaseId: req.validatedParams.id,
          decision: req.validated.decision,
          reason: req.validated.reason ?? null,
          decidedBy: req.user.id,
        });
        auditRepo.recordAudit({
          actorId: req.user.id, actorEmail: req.user.email, action: `purchase.${req.validated.decision === 'approve' ? 'approved' : 'rejected'}`,
          targetType: 'purchase', targetId: purchase.id,
          details: { coins: purchase.coins, ledgerTransactionId: entry ? entry.transactionId : null, reason: req.validated.reason ?? null },
        });
        res.json({ purchase, entry: entry || null });
      } catch (err) { handleWalletError(err, res); }
    });

  return router;
}

module.exports = { buildWalletRouter };
