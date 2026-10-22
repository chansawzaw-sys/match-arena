'use strict';
// Part 8 routes: no-code site control, versioned terms/agreements,
// statistics, health, Telegram link, maintenance/emergency, sweeper,
// backups, help centre, support tickets, suspicious-account review.
// Webhook is defined BEFORE authenticate() so Telegram can call it
// without a user token; it is restricted to the configured admin chat.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z, validate, validateParams } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../auth/middleware');
const auditRepo = require('../db/repos/audit');
const usersRepo = require('../db/repos/users');
const settingsRepo = require('../db/repos/settings');
const repo = require('../db/repos/part8');
const service = require('../services/part8');
const { Part8Error } = service;

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
function audit(req, action, targetType, targetId, details = {}) {
  auditRepo.recordAudit({ actorId: req.user.id, actorEmail: req.user.email, action, targetType, targetId, details });
}
function handleError(err, res) {
  if (err instanceof Part8Error) return res.status(err.status).json({ error: err.message });
  throw err;
}
function isOwner(req) { return req.user.role === 'owner'; }
function requireOwner(req, res, next) {
  if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can do this' });
  return next();
}
const idParams = validateParams(z.object({ id: z.coerce.number().int().positive() }));
const HEX = /^#[0-9a-fA-F]{6}$/;

function buildPart8Router(config) {
  const router = express.Router();

  // --- Telegram webhook (no user auth; admin-chat restricted) ---
  router.post('/telegram/webhook', (req, res) => {
    const body = req.body || {};
    const message = body.message || {};
    const chatId = message.chat ? String(message.chat.id) : null;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const cfg = repo.getTelegramConfig();
    const secret = service.telegramWebhookSecret(config);
    // Verification: if a secret is configured, the caller must present
    // it as header x-telegram-bot-api-secret-token or ?secret=.
    if (secret) {
      const presented = req.headers['x-telegram-bot-api-secret-token'] || req.query.secret;
      if (presented !== secret) return res.status(403).json({ ok: false, error: 'Invalid webhook secret' });
    }
    if (!text) return res.json({ ok: true, reply: 'No command received', delivery: 'none' });
    if (cfg && cfg.admin_chat_id && chatId !== String(cfg.admin_chat_id)) {
      return res.json({ ok: true, reply: 'This bot only serves its admin chat.', delivery: 'refused' });
    }
    const stats = service.statistics();
    let reply;
    if (text === '/stats') reply = service.formatStatsMessage(stats);
    else if (text === '/matches') reply = `Active match rooms: ${stats.activeMatchRooms}. Open challenges: ${stats.openChallenges}.`;
    else if (text === '/reports') reply = `Pending reports: ${stats.pendingReports}. Pending disputes: ${stats.pendingDisputes}.`;
    else reply = 'Unknown command. Available: /stats, /matches, /reports.';
    // If a token is configured, attempt a real send as well (best
    // effort; a send failure never changes the reply payload).
    const tokenConfigured = !!(cfg && cfg.token_encrypted);
    if (tokenConfigured && chatId) {
      service.sendTelegramMessage(config, chatId, reply).catch(() => {});
    }
    return res.json({ ok: true, reply, delivery: tokenConfigured ? 'attempted' : 'not_configured' });
  });

  router.use(authenticate(config));

  // --- Site config (public read for players; owner/admin to change) ---
  function siteConfig() {
    const logoPath = settingsRepo.getSetting('site.logo_path');
    return {
      platformName: settingsRepo.getSetting('platform_name') || 'Match Arena',
      platformTagline: settingsRepo.getSetting('platform_tagline') || '',
      buttonColor: settingsRepo.getSetting('site.button_color') || '#2563eb',
      backgroundColor: settingsRepo.getSetting('site.background_color') || '#0b1020',
      homepageText: settingsRepo.getSetting('site.homepage_text') || '',
      logoUrl: logoPath ? '/site-logo' : null,
    };
  }
  router.get('/site-config', (req, res) => { res.json({ siteConfig: siteConfig() }); });
  router.put('/site-config', requirePermission('site.manage'),
    validate(z.object({
      buttonColor: z.string().regex(HEX, 'buttonColor must be a #RRGGBB hex colour').optional(),
      backgroundColor: z.string().regex(HEX, 'backgroundColor must be a #RRGGBB hex colour').optional(),
      homepageText: z.string().max(2000).optional(),
    })), (req, res) => {
      if (req.validated.buttonColor !== undefined) settingsRepo.setSetting('site.button_color', req.validated.buttonColor, req.user.id);
      if (req.validated.backgroundColor !== undefined) settingsRepo.setSetting('site.background_color', req.validated.backgroundColor, req.user.id);
      if (req.validated.homepageText !== undefined) settingsRepo.setSetting('site.homepage_text', req.validated.homepageText, req.user.id);
      audit(req, 'site.config_updated', 'site_config', 'site-config', req.validated);
      res.json({ siteConfig: siteConfig() });
    });
  router.post('/site-config/logo', requirePermission('site.manage'), singleUpload('site-logos', 'logo'), (req, res) => {
    const bad = validateImageFile(req.file);
    if (bad) { deleteFile(req.file); return res.status(400).json({ error: bad }); }
    settingsRepo.setSetting('site.logo_path', req.file.path, req.user.id);
    audit(req, 'site.logo_updated', 'site_config', 'site-logo', {});
    res.status(201).json({ logoUrl: '/site-logo' });
  });
  router.get('/site-logo', (req, res) => {
    const logoPath = settingsRepo.getSetting('site.logo_path');
    if (!logoPath) return res.status(404).json({ error: 'Logo not found' });
    const base = path.resolve(path.join(__dirname, '..', '..', 'data'));
    const stored = path.resolve(logoPath);
    if (!stored.startsWith(base)) return res.status(404).json({ error: 'Logo not found' });
    return res.sendFile(stored);
  });

  // --- Banners ---
  router.get('/site-banners', requirePermission('site.manage'), (req, res) => { res.json({ banners: repo.listBanners({}) }); });
  router.get('/site-banners/active', (req, res) => {
    // Per-request random order for a slideshow: shuffle a copy of the
    // active list on every call; no stored slideshow order exists.
    const banners = repo.listBanners({ activeOnly: true });
    for (let i = banners.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [banners[i], banners[j]] = [banners[j], banners[i]];
    }
    res.json({ banners });
  });
  router.post('/site-banners', requirePermission('site.manage'), singleUpload('site-banners', 'banner'), (req, res) => {
    const bad = validateImageFile(req.file);
    if (bad) { deleteFile(req.file); return res.status(400).json({ error: bad }); }
    const title = typeof req.body.title === 'string' ? req.body.title : '';
    const sortOrder = req.body.sortOrder !== undefined ? Number(req.body.sortOrder) : 0;
    const banner = repo.createBanner({
      title, originalName: req.file.originalname, mime: req.file.mimetype, size: req.file.size,
      storedPath: req.file.path, sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0, active: true, createdBy: req.user.id,
    });
    audit(req, 'site.banner_created', 'site_banner', banner.id, {});
    res.status(201).json({ banner });
  });
  router.put('/site-banners/:id', requirePermission('site.manage'), idParams,
    validate(z.object({ title: z.string().max(200).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() })),
    (req, res) => {
      const banner = repo.updateBanner(req.validatedParams.id, req.validated);
      if (!banner) return res.status(404).json({ error: 'Banner not found' });
      audit(req, 'site.banner_updated', 'site_banner', banner.id, req.validated);
      res.json({ banner });
    });
  router.get('/site-banners/:id/image', idParams, (req, res) => {
    const raw = repo.findBannerRaw(req.validatedParams.id);
    if (!raw) return res.status(404).json({ error: 'Banner not found' });
    const base = path.resolve(path.join(__dirname, '..', '..', 'data'));
    const stored = path.resolve(raw.stored_path);
    if (!stored.startsWith(base)) return res.status(404).json({ error: 'Banner not found' });
    return res.sendFile(stored, { headers: { 'Content-Type': raw.mime } });
  });

  // --- Announcements ---
  router.get('/site-announcements', requirePermission('site.manage'), (req, res) => { res.json({ announcements: repo.listAnnouncements({}) }); });
  router.get('/site-announcements/active', (req, res) => { res.json({ announcements: repo.listAnnouncements({ activeOnly: true }) }); });
  router.post('/site-announcements', requirePermission('site.manage'),
    validate(z.object({
      text: z.string().min(1).max(2000), language: z.enum(['mm', 'en']).optional(),
      active: z.boolean().optional(), startsAt: z.string().nullable().optional(), endsAt: z.string().nullable().optional(),
    })), (req, res) => {
      const a = repo.createAnnouncement({ ...req.validated, createdBy: req.user.id });
      audit(req, 'site.announcement_created', 'site_announcement', a.id, {});
      res.status(201).json({ announcement: a });
    });
  router.put('/site-announcements/:id', requirePermission('site.manage'), idParams,
    validate(z.object({
      text: z.string().min(1).max(2000).optional(), language: z.enum(['mm', 'en']).optional(),
      active: z.boolean().optional(), startsAt: z.string().nullable().optional(), endsAt: z.string().nullable().optional(),
    })), (req, res) => {
      const a = repo.updateAnnouncement(req.validatedParams.id, req.validated);
      if (!a) return res.status(404).json({ error: 'Announcement not found' });
      audit(req, 'site.announcement_updated', 'site_announcement', a.id, req.validated);
      res.json({ announcement: a });
    });

  // --- Versioned documents + agreements ---
  router.post('/documents', requirePermission('site.manage'),
    validate(z.object({ type: z.enum(['terms', 'privacy', 'match_rules']), title: z.string().min(1).max(200), body: z.string().min(1).max(50000) })),
    (req, res) => {
      const doc = repo.createDocument({ ...req.validated, createdBy: req.user.id });
      audit(req, 'document.created', 'document', doc.id, { type: doc.type, version: doc.version });
      res.status(201).json({ document: doc });
    });
  router.get('/documents/current/:type', validateParams(z.object({ type: z.enum(['terms', 'privacy', 'match_rules']) })),
    (req, res) => {
      const doc = repo.currentDocument(req.validatedParams.type);
      if (!doc) return res.status(404).json({ error: 'No version exists for this document type' });
      res.json({ document: doc });
    });
  router.get('/documents/:type', validateParams(z.object({ type: z.enum(['terms', 'privacy', 'match_rules']) })),
    (req, res) => { res.json({ documents: repo.listDocuments(req.validatedParams.type) }); });
  router.post('/agreements/accept', validate(z.object({ documentId: z.number().int().positive() })), (req, res) => {
    const doc = repo.findDocument(req.validated.documentId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const agreement = repo.acceptAgreement(req.user.id, doc.id);
    audit(req, 'agreement.accepted', 'document', doc.id, { version: doc.version });
    res.status(201).json({ agreement });
  });
  router.get('/agreements/me', (req, res) => { res.json({ agreements: repo.listAgreements(req.user.id) }); });

  // --- Statistics / health / suspicious ---
  router.get('/admin/stats', requirePermission('stats.view'), (req, res) => { res.json({ stats: service.statistics() }); });
  router.get('/admin/health', requirePermission('health.view'), (req, res) => { res.json({ health: service.health() }); });
  router.get('/admin/suspicious', requirePermission('suspicious.view'), (req, res) => { res.json({ groups: service.suspiciousGroups() }); });

  // --- Maintenance / emergency (owner-only, confirm-gated) ---
  router.post('/admin/maintenance', requireOwner,
    validate(z.object({ enabled: z.boolean(), message: z.string().max(1000).optional(), reason: z.string().min(1).max(1000), confirm: z.boolean().optional() })),
    (req, res) => {
      const { enabled, message, reason } = req.validated;
      if (enabled) {
        const active = service.activeMatchCount();
        if (active > 0 && req.validated.confirm !== true) {
          return res.status(409).json({ error: 'Active matches exist; confirm is required to enable maintenance', activeMatchCount: active, requiresConfirm: true });
        }
      }
      settingsRepo.setSetting('maintenance_mode', enabled, req.user.id);
      if (message !== undefined) settingsRepo.setSetting('maintenance.message', message, req.user.id);
      settingsRepo.setSetting('maintenance.reason', reason, req.user.id);
      if (enabled && message) {
        repo.createAnnouncement({ text: message, language: 'mm', active: true, createdBy: req.user.id });
      }
      audit(req, enabled ? 'maintenance.enabled' : 'maintenance.disabled', 'maintenance', 'maintenance', { reason, activeMatchCount: service.activeMatchCount() });
      res.json({ maintenance: service.maintenanceInfo() });
    });
  router.post('/admin/emergency', requireOwner,
    validate(z.object({ enabled: z.boolean(), reason: z.string().min(1).max(1000), confirm: z.boolean().optional() })),
    (req, res) => {
      const { enabled, reason } = req.validated;
      if (enabled && req.validated.confirm !== true) {
        return res.status(409).json({ error: 'Confirm is required to enable emergency mode', requiresConfirm: true });
      }
      settingsRepo.setSetting('emergency_mode', enabled, req.user.id);
      settingsRepo.setSetting('emergency.reason', reason, req.user.id);
      if (enabled) {
        const text = `Emergency mode enabled: ${reason}`;
        repo.createAnnouncement({ text, language: 'mm', active: true, createdBy: req.user.id });
        const { getDb } = require('../db');
        for (const row of getDb().prepare('SELECT id FROM users').all()) {
          const { addNotification } = require('../db/repos/matchRooms');
          addNotification(row.id, 'emergency_mode', null, text, { category: 'announcement', targetType: 'announcement', targetId: null });
        }
      }
      audit(req, enabled ? 'emergency.enabled' : 'emergency.disabled', 'emergency', 'emergency', { reason });
      res.json({ emergency: service.emergencyInfo() });
    });

  // --- Sweeper (owner-only, manual) ---
  router.post('/admin/sweep', requireOwner, (req, res) => {
    const result = service.runSweep();
    audit(req, 'sweep.run', 'sweep', 'sweep', result);
    res.json({ sweep: result });
  });

  // --- Backups (owner-only; no API restore by design) ---
  router.post('/admin/backups', requireOwner, (req, res) => {
    try {
      const backup = service.createBackup({ dbPath: config.dbPath, createdBy: req.user.id });
      audit(req, 'backup.created', 'backup', backup.id, { filename: backup.filename });
      res.status(201).json({ backup });
    } catch (err) {
      return res.status(500).json({ error: 'Backup failed' });
    }
  });
  router.get('/admin/backups', requireOwner, (req, res) => { res.json({ backups: repo.listBackups() }); });
  router.get('/admin/backups/:id/download', requireOwner, idParams, (req, res) => {
    const raw = repo.findBackupRaw(req.validatedParams.id);
    if (!raw) return res.status(404).json({ error: 'Backup not found' });
    const base = path.resolve(path.join(__dirname, '..', '..', 'data', 'backups'));
    const stored = path.resolve(raw.stored_path);
    if (!stored.startsWith(base)) return res.status(404).json({ error: 'Backup not found' });
    return res.download(stored, raw.filename);
  });

  // --- Telegram ---
  router.post('/admin/telegram/config', requireOwner,
    validate(z.object({ token: z.string().min(1).max(500).optional(), adminChatId: z.string().min(1).max(100).optional(), webhookSecret: z.string().min(1).max(500).optional() })),
    (req, res) => {
      const { token, adminChatId, webhookSecret } = req.validated;
      repo.setTelegramConfig({
        tokenEncrypted: token !== undefined ? require('../utils/crypto').encryptText(token, config.encryptionKey) : undefined,
        adminChatId: adminChatId !== undefined ? adminChatId : undefined,
        webhookSecretEncrypted: webhookSecret !== undefined ? require('../utils/crypto').encryptText(webhookSecret, config.encryptionKey) : undefined,
        updatedBy: req.user.id,
      });
      audit(req, 'telegram.config_updated', 'telegram_config', 1, { adminChatId: adminChatId !== undefined ? adminChatId : null });
      res.json({ telegram: service.telegramConfigPublic(config) });
    });
  router.get('/admin/telegram/config', requirePermission('telegram.manage'), (req, res) => {
    res.json({ telegram: service.telegramConfigPublic(config) });
  });
  router.post('/admin/telegram/test', requireOwner, async (req, res) => {
    const cfg = repo.getTelegramConfig();
    if (!cfg || !cfg.token_encrypted || !cfg.admin_chat_id) {
      return res.status(503).json({ error: 'Telegram bot token is not configured' });
    }
    const result = await service.sendTelegramMessage(config, cfg.admin_chat_id, 'Match Arena test message.');
    if (!result.ok) return res.status(502).json({ error: result.error });
    audit(req, 'telegram.test_sent', 'telegram_config', 1, {});
    res.json({ sent: true, messageId: result.messageId });
  });
  router.get('/admin/telegram/stats', requirePermission('telegram.manage'), (req, res) => {
    const stats = service.statistics();
    res.json({ message: service.formatStatsMessage(stats), stats });
  });
  router.post('/admin/telegram/announce', requirePermission('telegram.manage'),
    validate(z.object({ text: z.string().min(1).max(2000), language: z.enum(['mm', 'en']).optional() })),
    (req, res) => {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const pending = repo.createTelegramAnnouncement({ text: req.validated.text, language: req.validated.language || 'mm', confirmationCode: code, createdBy: req.user.id });
      audit(req, 'telegram.announce_created', 'telegram_announcement', pending.id, {});
      res.status(201).json({ announcement: { id: pending.id, status: pending.status, confirmationCode: code } });
    });
  router.post('/admin/telegram/announce/:id/confirm', requireOwner, idParams,
    validate(z.object({ confirmationCode: z.string().min(1).max(20) })),
    async (req, res) => {
      const pending = repo.findTelegramAnnouncement(req.validatedParams.id);
      if (!pending) return res.status(404).json({ error: 'Announcement not found' });
      if (pending.status !== 'pending') return res.status(409).json({ error: `Announcement is already ${pending.status}` });
      // The confirmation code is stored in the row; compare via the
      // raw row (the public view deliberately omits it).
      {
        const { getDb } = require('../db');
        const raw = getDb().prepare('SELECT confirmation_code FROM telegram_announcements WHERE id = ?').get(pending.id);
        if (!raw || raw.confirmation_code !== req.validated.confirmationCode) {
          return res.status(400).json({ error: 'Invalid confirmation code' });
        }
      }
      const siteAnnouncement = repo.createAnnouncement({ text: pending.text, language: pending.language, active: true, createdBy: req.user.id });
      let telegramStatus = 'not_configured';
      const cfg = repo.getTelegramConfig();
      if (cfg && cfg.token_encrypted && cfg.admin_chat_id) {
        const result = await service.sendTelegramMessage(config, cfg.admin_chat_id, pending.text);
        telegramStatus = result.ok ? 'sent' : `failed: ${result.error}`;
      }
      const updated = repo.updateTelegramAnnouncement(pending.id, {
        status: 'confirmed', siteAnnouncementId: siteAnnouncement.id, telegramStatus, confirmedAt: new Date().toISOString(),
      });
      audit(req, 'telegram.announce_confirmed', 'telegram_announcement', pending.id, { siteAnnouncementId: siteAnnouncement.id, telegramStatus });
      res.json({ announcement: updated, siteAnnouncement, telegramStatus });
    });

  // --- Help centre ---
  router.post('/help-articles', requirePermission('help.manage'),
    validate(z.object({ category: z.enum(['match_rules', 'account', 'technical', 'dispute_process', 'other']), title: z.string().min(1).max(200), body: z.string().min(1).max(50000), published: z.boolean().optional() })),
    (req, res) => {
      const article = repo.createHelpArticle({ ...req.validated, createdBy: req.user.id });
      audit(req, 'help.article_created', 'help_article', article.id, {});
      res.status(201).json({ article });
    });
  router.get('/help-articles', (req, res) => {
    const staff = ['owner', 'admin', 'moderator', 'support'].includes(req.user.role);
    res.json({ articles: repo.listHelpArticles({ publishedOnly: !staff, category: req.query.category || undefined }) });
  });
  router.get('/help-articles/:id', idParams, (req, res) => {
    const article = repo.findHelpArticle(req.validatedParams.id);
    if (!article) return res.status(404).json({ error: 'Article not found' });
    const staff = ['owner', 'admin', 'moderator', 'support'].includes(req.user.role);
    if (!article.published && !staff) return res.status(404).json({ error: 'Article not found' });
    res.json({ article });
  });
  router.put('/help-articles/:id', requirePermission('help.manage'), idParams,
    validate(z.object({ category: z.enum(['match_rules', 'account', 'technical', 'dispute_process', 'other']).optional(), title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(50000).optional(), published: z.boolean().optional() })),
    (req, res) => {
      const article = repo.updateHelpArticle(req.validatedParams.id, req.validated);
      if (!article) return res.status(404).json({ error: 'Article not found' });
      audit(req, 'help.article_updated', 'help_article', article.id, req.validated);
      res.json({ article });
    });

  // --- Support tickets ---
  router.post('/tickets',
    validate(z.object({ subject: z.string().min(1).max(200), category: z.enum(['match_rules', 'account', 'technical', 'dispute_process', 'other']), message: z.string().min(1).max(5000) })),
    (req, res) => {
      const ticket = repo.createTicket({ reporterId: req.user.id, ...req.validated });
      audit(req, 'ticket.created', 'support_ticket', ticket.id, {});
      res.status(201).json({ ticket });
    });
  router.get('/tickets', (req, res) => { res.json({ tickets: repo.listTicketsFor(req.user) }); });
  router.get('/tickets/:id', idParams, (req, res) => {
    const ticket = repo.findTicket(req.validatedParams.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const staff = ['owner', 'admin', 'moderator', 'support'].includes(req.user.role);
    if (!staff && ticket.reporterId !== req.user.id) return res.status(403).json({ error: 'You cannot view this ticket' });
    res.json({ ticket });
  });
  router.post('/tickets/:id/messages', idParams, validate(z.object({ message: z.string().min(1).max(5000) })), (req, res) => {
    const ticket = repo.findTicket(req.validatedParams.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const staff = ['owner', 'admin', 'moderator', 'support'].includes(req.user.role);
    if (!staff && ticket.reporterId !== req.user.id) return res.status(403).json({ error: 'You cannot reply to this ticket' });
    if (ticket.status === 'closed') return res.status(409).json({ error: 'Ticket is closed' });
    const updated = repo.addTicketMessage(ticket.id, req.user.id, req.validated.message);
    audit(req, 'ticket.replied', 'support_ticket', ticket.id, {});
    res.json({ ticket: updated });
  });
  router.post('/tickets/:id/status', idParams,
    validate(z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']), reason: z.string().max(1000).optional() })),
    (req, res) => {
      const ticket = repo.findTicket(req.validatedParams.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      const staff = ['owner', 'admin', 'moderator', 'support'].includes(req.user.role);
      const { status } = req.validated;
      const isReopen = (ticket.status === 'resolved' || ticket.status === 'closed') && status === 'open';
      if (isReopen && !staff) {
        return res.status(403).json({ error: 'Only staff can reopen a ticket' });
      }
      if (isReopen && !req.validated.reason) {
        return res.status(400).json({ error: 'Reopening a ticket requires a staff reason' });
      }
      if (!staff) {
        if (ticket.reporterId !== req.user.id || status !== 'closed') {
          return res.status(403).json({ error: 'Only the reporter can close their own ticket, and only staff can change other statuses' });
        }
      }
      const updated = repo.setTicketStatus(ticket.id, status);
      audit(req, 'ticket.status_changed', 'support_ticket', ticket.id, { from: ticket.status, to: status });
      res.json({ ticket: updated });
    });

  return router;
}

module.exports = { buildPart8Router };
