'use strict';
// Settings repository: key/value rows, values stored as JSON text so a
// setting can be a string, boolean or object without a schema change.
const { getDb } = require('../index');

function getSetting(key) {
  const row = getDb().prepare('SELECT * FROM admin_settings WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function listSettings() {
  return getDb().prepare('SELECT * FROM admin_settings ORDER BY key ASC').all()
    .map((row) => ({ key: row.key, value: safeParse(row.value), updatedBy: row.updated_by, updatedAt: row.updated_at }));
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function setSetting(key, value, updatedBy) {
  getDb().prepare(
    'INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), updatedBy ?? null, new Date().toISOString());
  return getSetting(key);
}

module.exports = { getSetting, listSettings, setSetting };
