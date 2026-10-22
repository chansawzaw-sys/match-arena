'use strict';
// Part 8 repository: the only place that reads/writes site banners,
// announcements, Telegram config/pending announcements, versioned
// documents, agreements, help articles, support tickets and backups.
// Routes never touch SQL; the service in src/services/part8.js owns
// the rules (active windows, versioning, two-step confirm, etc.).
const { getDb } = require('../index');
const usersRepo = require('./users');

function publicBanner(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, originalName: row.original_name, mime: row.mime,
    size: row.size, url: `/site-banners/${row.id}`, sortOrder: row.sort_order,
    active: row.active === 1, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function createBanner({ title, originalName, mime, size, storedPath, sortOrder = 0, active = true, createdBy }) {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    'INSERT INTO site_banners (title, original_name, mime, size, stored_path, sort_order, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(title || '', originalName, mime, size, storedPath, sortOrder, active ? 1 : 0, createdBy ?? null, now, now);
  return findBanner(r.lastInsertRowid);
}
function findBanner(id) { return publicBanner(getDb().prepare('SELECT * FROM site_banners WHERE id = ?').get(id)); }
function findBannerRaw(id) { return getDb().prepare('SELECT * FROM site_banners WHERE id = ?').get(id); }
function listBanners({ activeOnly = false } = {}) {
  const rows = getDb().prepare(
    `SELECT * FROM site_banners ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order ASC, id ASC`,
  ).all();
  return rows.map(publicBanner);
}
function updateBanner(id, changes) {
  const cur = findBannerRaw(id);
  if (!cur) return null;
  const next = {
    title: changes.title !== undefined ? changes.title : cur.title,
    sortOrder: changes.sortOrder !== undefined ? changes.sortOrder : cur.sort_order,
    active: changes.active !== undefined ? (changes.active ? 1 : 0) : cur.active,
  };
  getDb().prepare('UPDATE site_banners SET title = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.sortOrder, next.active, new Date().toISOString(), id);
  return findBanner(id);
}

function publicAnnouncement(row) {
  if (!row) return null;
  return {
    id: row.id, text: row.text, language: row.language, active: row.active === 1,
    startsAt: row.starts_at ?? null, endsAt: row.ends_at ?? null,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function createAnnouncement({ text, language = 'mm', active = true, startsAt = null, endsAt = null, createdBy }) {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    'INSERT INTO site_announcements (text, language, active, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(text, language, active ? 1 : 0, startsAt, endsAt, createdBy ?? null, now, now);
  return findAnnouncement(r.lastInsertRowid);
}
function findAnnouncement(id) { return publicAnnouncement(getDb().prepare('SELECT * FROM site_announcements WHERE id = ?').get(id)); }
function listAnnouncements({ activeOnly = false } = {}) {
  let rows = getDb().prepare('SELECT * FROM site_announcements ORDER BY id DESC').all().map(publicAnnouncement);
  if (activeOnly) {
    const now = new Date().toISOString();
    rows = rows.filter((a) => a.active
      && (!a.startsAt || a.startsAt <= now) && (!a.endsAt || a.endsAt >= now));
  }
  return rows;
}
function updateAnnouncement(id, changes) {
  const cur = getDb().prepare('SELECT * FROM site_announcements WHERE id = ?').get(id);
  if (!cur) return null;
  const next = {
    text: changes.text !== undefined ? changes.text : cur.text,
    language: changes.language !== undefined ? changes.language : cur.language,
    active: changes.active !== undefined ? (changes.active ? 1 : 0) : cur.active,
    startsAt: changes.startsAt !== undefined ? changes.startsAt : cur.starts_at,
    endsAt: changes.endsAt !== undefined ? changes.endsAt : cur.ends_at,
  };
  getDb().prepare('UPDATE site_announcements SET text = ?, language = ?, active = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?')
    .run(next.text, next.language, next.active, next.startsAt, next.endsAt, new Date().toISOString(), id);
  return findAnnouncement(id);
}

function getTelegramConfig() {
  return getDb().prepare('SELECT * FROM telegram_config WHERE id = 1').get() || null;
}
function setTelegramConfig({ tokenEncrypted = null, adminChatId = null, webhookSecretEncrypted = null, updatedBy }) {
  const cur = getTelegramConfig();
  const next = {
    tokenEncrypted: tokenEncrypted !== undefined ? tokenEncrypted : (cur ? cur.token_encrypted : null),
    adminChatId: adminChatId !== undefined ? adminChatId : (cur ? cur.admin_chat_id : null),
    webhookSecretEncrypted: webhookSecretEncrypted !== undefined ? webhookSecretEncrypted : (cur ? cur.webhook_secret_encrypted : null),
  };
  getDb().prepare(
    'INSERT INTO telegram_config (id, token_encrypted, admin_chat_id, webhook_secret_encrypted, updated_by, updated_at) VALUES (1, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET token_encrypted = excluded.token_encrypted, admin_chat_id = excluded.admin_chat_id, webhook_secret_encrypted = excluded.webhook_secret_encrypted, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).run(next.tokenEncrypted, next.adminChatId, next.webhookSecretEncrypted, updatedBy ?? null, new Date().toISOString());
  return getTelegramConfig();
}

function createTelegramAnnouncement({ text, language = 'mm', confirmationCode, createdBy }) {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    'INSERT INTO telegram_announcements (text, language, status, confirmation_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(text, language, 'pending', confirmationCode, createdBy ?? null, now);
  return findTelegramAnnouncement(r.lastInsertRowid);
}
function findTelegramAnnouncement(id) {
  const row = getDb().prepare('SELECT * FROM telegram_announcements WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id, text: row.text, language: row.language, status: row.status,
    siteAnnouncementId: row.site_announcement_id ?? null, telegramStatus: row.telegram_status ?? null,
    createdBy: row.created_by, createdAt: row.created_at, confirmedAt: row.confirmed_at ?? null,
  };
}
function updateTelegramAnnouncement(id, changes) {
  const cur = getDb().prepare('SELECT * FROM telegram_announcements WHERE id = ?').get(id);
  if (!cur) return null;
  getDb().prepare('UPDATE telegram_announcements SET status = ?, site_announcement_id = ?, telegram_status = ?, confirmed_at = ? WHERE id = ?')
    .run(changes.status !== undefined ? changes.status : cur.status,
      changes.siteAnnouncementId !== undefined ? changes.siteAnnouncementId : cur.site_announcement_id,
      changes.telegramStatus !== undefined ? changes.telegramStatus : cur.telegram_status,
      changes.confirmedAt !== undefined ? changes.confirmedAt : cur.confirmed_at, id);
  return findTelegramAnnouncement(id);
}
function listTelegramAnnouncements() {
  return getDb().prepare('SELECT * FROM telegram_announcements ORDER BY id DESC').all()
    .map((r) => findTelegramAnnouncement(r.id));
}

function createDocument({ type, title, body, createdBy }) {
  const row = getDb().prepare('SELECT MAX(version) AS v FROM documents WHERE type = ?').get(type);
  const version = (row && row.v ? row.v : 0) + 1;
  const now = new Date().toISOString();
  const r = getDb().prepare(
    'INSERT INTO documents (type, version, title, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(type, version, title, body, createdBy ?? null, now);
  return findDocument(r.lastInsertRowid);
}
function findDocument(id) {
  const row = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, type: row.type, version: row.version, title: row.title, body: row.body, createdBy: row.created_by, createdAt: row.created_at };
}
function currentDocument(type) {
  return findDocument(getDb().prepare('SELECT id FROM documents WHERE type = ? ORDER BY version DESC LIMIT 1').get(type)?.id ?? -1);
}
function listDocuments(type) {
  return getDb().prepare('SELECT * FROM documents WHERE type = ? ORDER BY version ASC').all(type).map((r) => findDocument(r.id));
}
function acceptAgreement(userId, documentId) {
  const now = new Date().toISOString();
  getDb().prepare('INSERT OR IGNORE INTO agreements (user_id, document_id, created_at) VALUES (?, ?, ?)')
    .run(userId, documentId, now);
  const row = getDb().prepare('SELECT * FROM agreements WHERE user_id = ? AND document_id = ?').get(userId, documentId);
  return { id: row.id, userId: row.user_id, documentId: row.document_id, createdAt: row.created_at };
}
function hasAccepted(userId, documentId) {
  return !!getDb().prepare('SELECT 1 FROM agreements WHERE user_id = ? AND document_id = ?').get(userId, documentId);
}
function listAgreements(userId) {
  return getDb().prepare('SELECT * FROM agreements WHERE user_id = ? ORDER BY id DESC').all(userId)
    .map((r) => ({ id: r.id, userId: r.user_id, documentId: r.document_id, createdAt: r.created_at }));
}

function createHelpArticle({ category, title, body, published = false, createdBy }) {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    'INSERT INTO help_articles (category, title, body, published, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(category, title, body, published ? 1 : 0, createdBy ?? null, now, now);
  return findHelpArticle(r.lastInsertRowid);
}
function findHelpArticle(id) {
  const row = getDb().prepare('SELECT * FROM help_articles WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, category: row.category, title: row.title, body: row.body, published: row.published === 1, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
function listHelpArticles({ publishedOnly = false, category } = {}) {
  const conditions = [];
  const params = [];
  if (publishedOnly) conditions.push('published = 1');
  if (category) { conditions.push('category = ?'); params.push(category); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM help_articles ${where} ORDER BY id ASC`).all(...params).map((r) => findHelpArticle(r.id));
}
function updateHelpArticle(id, changes) {
  const cur = getDb().prepare('SELECT * FROM help_articles WHERE id = ?').get(id);
  if (!cur) return null;
  getDb().prepare('UPDATE help_articles SET category = ?, title = ?, body = ?, published = ?, updated_at = ? WHERE id = ?')
    .run(changes.category !== undefined ? changes.category : cur.category,
      changes.title !== undefined ? changes.title : cur.title,
      changes.body !== undefined ? changes.body : cur.body,
      changes.published !== undefined ? (changes.published ? 1 : 0) : cur.published,
      new Date().toISOString(), id);
  return findHelpArticle(id);
}

function createTicket({ reporterId, subject, category, message }) {
  const now = new Date().toISOString();
  const db = getDb();
  const run = db.transaction(() => {
    const r = db.prepare('INSERT INTO support_tickets (reporter_id, subject, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(reporterId, subject, category, 'open', now, now);
    db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, message, created_at) VALUES (?, ?, ?, ?)')
      .run(r.lastInsertRowid, reporterId, message, now);
    return r.lastInsertRowid;
  });
  return findTicket(run());
}
function findTicket(id) {
  const row = getDb().prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id, reporterId: row.reporter_id, subject: row.subject, category: row.category,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    messages: getDb().prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC').all(id)
      .map((m) => ({ id: m.id, ticketId: m.ticket_id, authorId: m.author_id, message: m.message, createdAt: m.created_at })),
  };
}
function listTicketsFor(viewer) {
  const staff = ['owner', 'admin', 'moderator', 'support'].includes(viewer.role);
  const rows = staff
    ? getDb().prepare('SELECT * FROM support_tickets ORDER BY id DESC').all()
    : getDb().prepare('SELECT * FROM support_tickets WHERE reporter_id = ? ORDER BY id DESC').all(viewer.id);
  return rows.map((r) => findTicket(r.id));
}
function addTicketMessage(ticketId, authorId, message) {
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO ticket_messages (ticket_id, author_id, message, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, authorId, message, now);
  getDb().prepare('UPDATE support_tickets SET updated_at = ? WHERE id = ?').run(now, ticketId);
  return findTicket(ticketId);
}
function setTicketStatus(id, status) {
  getDb().prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return findTicket(id);
}

function createBackup({ filename, storedPath, size, createdBy }) {
  const now = new Date().toISOString();
  const r = getDb().prepare('INSERT INTO backups (filename, stored_path, size, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(filename, storedPath, size, createdBy ?? null, now);
  const row = getDb().prepare('SELECT * FROM backups WHERE id = ?').get(r.lastInsertRowid);
  return { id: row.id, filename: row.filename, size: row.size, createdBy: row.created_by, createdAt: row.created_at };
}
function listBackups() {
  return getDb().prepare('SELECT * FROM backups ORDER BY id DESC').all()
    .map((r) => ({ id: r.id, filename: r.filename, size: r.size, createdBy: r.created_by, createdAt: r.created_at }));
}
function findBackupRaw(id) { return getDb().prepare('SELECT * FROM backups WHERE id = ?').get(id); }
function lastBackupAt() {
  const row = getDb().prepare('SELECT MAX(created_at) AS t FROM backups').get();
  return row ? row.t : null;
}

function publicUserDisplay(row) {
  if (!row) return null;
  const u = usersRepo.publicUser(row);
  return { id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, rankTier: u.rankTier, mlbbId: u.mlbbId, serverId: u.serverId };
}

module.exports = {
  createBanner, findBanner, findBannerRaw, listBanners, updateBanner,
  createAnnouncement, findAnnouncement, listAnnouncements, updateAnnouncement,
  getTelegramConfig, setTelegramConfig, createTelegramAnnouncement, findTelegramAnnouncement,
  updateTelegramAnnouncement, listTelegramAnnouncements,
  createDocument, findDocument, currentDocument, listDocuments, acceptAgreement, hasAccepted, listAgreements,
  createHelpArticle, findHelpArticle, listHelpArticles, updateHelpArticle,
  createTicket, findTicket, listTicketsFor, addTicketMessage, setTicketStatus,
  createBackup, listBackups, findBackupRaw, lastBackupAt, publicUserDisplay,
};
