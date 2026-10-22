'use strict';
// Audit log repository: append-only in Part 1 (no update/delete endpoint).
const { getDb } = require('../index');

function recordAudit({ actorId, actorEmail, action, targetType = null, targetId = null, details = {} }) {
  getDb().prepare(
    'INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(actorId ?? null, actorEmail ?? null, action, targetType, targetId != null ? String(targetId) : null,
    JSON.stringify(details), new Date().toISOString());
}

function listAudit({ actorId, action, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (actorId) { conditions.push('actor_id = ?'); params.push(actorId); }
  if (action) { conditions.push('action = ?'); params.push(action); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 200), offset);
  const totalRow = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params);
  return {
    entries: rows.map((r) => ({
      id: r.id, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action,
      targetType: r.target_type, targetId: r.target_id,
      details: (() => { try { return JSON.parse(r.details); } catch { return {}; } })(),
      createdAt: r.created_at,
    })),
    total: totalRow.n,
  };
}

module.exports = { recordAudit, listAudit };
