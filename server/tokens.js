import crypto from 'node:crypto';
import { all, get, run, insert } from './db.js';
import { bad, notFound, forbidden } from './util.js';
import { audit } from './audit.js';

const hash = t => crypto.createHash('sha256').update(t).digest('hex');
export const looksLikeToken = h => /^Bearer tb_[A-Za-z0-9_-]{20,}$/.test(String(h || ''));

export function createToken(user, { name, scope = 'write', days } = {}, req) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw bad('Give the token a name');
  if (!['read', 'write'].includes(scope)) throw bad('Invalid scope');
  if (user.role === 'viewer' || user.role === 'guest') scope = 'read';
  if (get('SELECT COUNT(*) n FROM api_tokens WHERE user_id=?', user.id).n >= 20) throw bad('You can have at most 20 tokens');
  const token = 'tb_' + crypto.randomBytes(30).toString('base64url');
  const expires = days ? new Date(Date.now() + Math.min(Number(days), 730) * 86400000).toISOString() : null;
  const id = insert('INSERT INTO api_tokens(user_id,name,hash,prefix,scope,expires_at) VALUES(?,?,?,?,?,?)', user.id, n, hash(token), token.slice(0, 10), scope, expires);
  audit(user, 'token.created', n, { id, scope }, req);
  return { id, token, prefix: token.slice(0, 10), scope, expires_at: expires };
}
export const listTokens = userId => all('SELECT id,name,prefix,scope,expires_at,last_used,created_at FROM api_tokens WHERE user_id=? ORDER BY id DESC', userId);
export function revokeToken(user, id, req) {
  const t = get('SELECT * FROM api_tokens WHERE id=?', id);
  if (!t || (t.user_id !== user.id && user.role !== 'admin')) throw notFound('Token not found');
  run('DELETE FROM api_tokens WHERE id=?', id);
  audit(user, 'token.revoked', t.name, { id }, req);
}

// returns { user, scope } or null
export function authenticateBearer(header) {
  if (!looksLikeToken(header)) return null;
  const row = get('SELECT t.*, u.active FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.hash=?', hash(header.slice(7)));
  if (!row || !row.active) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
  const user = get('SELECT * FROM users WHERE id=? AND active=1', row.user_id);
  if (!user) return null;
  if (!row.last_used || Date.now() - new Date(row.last_used).getTime() > 60000) run("UPDATE api_tokens SET last_used=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", row.id);
  return { user, scope: user.role === 'viewer' || user.role === 'guest' ? 'read' : row.scope, tokenId: row.id };
}
void forbidden;
