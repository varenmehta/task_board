import { all, insert, parseJSON } from './db.js';

export function audit(actor, action, target = null, detail = {}, req = null) {
  try {
    const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
    insert('INSERT INTO audit(user_id,action,target,detail,ip) VALUES(?,?,?,?,?)', actor?.id ?? actor ?? null, action, target, JSON.stringify(detail), ip);
  } catch (e) { console.error('[audit]', e.message); }
}

export function listAudit({ action, user_id, limit = 100, before } = {}) {
  const where = [], params = [];
  if (action) { where.push('a.action LIKE ?'); params.push(action + '%'); }
  if (user_id) { where.push('a.user_id=?'); params.push(Number(user_id)); }
  if (before) { where.push('a.id<?'); params.push(Number(before)); }
  return all(`SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`, ...params, Math.min(500, Number(limit) || 100))
    .map(a => ({ ...a, detail: parseJSON(a.detail, {}) }));
}
