// Gmail integration via Google OAuth (no SDK, plain fetch).
import { get, run, all, getSetting, parseJSON, insert } from '../db.js';
import { HttpError } from '../util.js';

export const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];
export const LABEL = 'TaskBoard';

export const googleConfigured = () => !!(getSetting('google_client_id') && getSetting('google_client_secret'));
export const redirectUri = base => `${getSetting('base_url') || base}/api/integrations/google/callback`;

export function authUrl(base, state) {
  const p = new URLSearchParams({
    client_id: getSetting('google_client_id'), redirect_uri: redirectUri(base), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getSetting('google_client_id'), client_secret: getSetting('google_client_secret'), ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, j.error_description || j.error || 'Google token request failed');
  return j;
}

export async function exchangeCode(code, base) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(base) });
  const email = t.id_token ? parseJSON(Buffer.from(t.id_token.split('.')[1], 'base64url').toString(), {}).email : null;
  return { email, refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000, scope: t.scope };
}

export const getIntegration = userId => {
  const row = get('SELECT data FROM integrations WHERE user_id=? AND provider=?', userId, 'google');
  return row ? parseJSON(row.data, null) : null;
};
export const saveIntegration = (userId, data) =>
  run('INSERT INTO integrations(user_id,provider,data) VALUES(?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET data=excluded.data', userId, 'google', JSON.stringify(data));

async function accessToken(userId) {
  const g = getIntegration(userId);
  if (!g?.refresh_token) throw new HttpError(400, 'Gmail is not connected');
  if (g.access_token && g.expires_at > Date.now()) return g.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: g.refresh_token });
  saveIntegration(userId, { ...g, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

async function gmail(userId, path, { method = 'GET', body } = {}) {
  const token = await accessToken(userId);
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, j.error?.message || `Gmail API error ${r.status}`);
  return j;
}

const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const wrap = s => Buffer.from(s).toString('base64').replace(/(.{76})/g, '$1\r\n');

export function buildMime({ from, to, subject, text, html }) {
  const boundary = 'tb_' + Math.random().toString(36).slice(2);
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${encHeader(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(text), '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(html), '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

export async function sendViaGmail(senderUserId, { to, subject, text, html }) {
  const g = getIntegration(senderUserId);
  const raw = Buffer.from(buildMime({ from: g.email, to, subject, text, html })).toString('base64url');
  await gmail(senderUserId, 'messages/send', { method: 'POST', body: { raw } });
}

// Which connected Gmail account sends workspace email: the one an admin connected first.
export function senderUserId() {
  const rows = all(`SELECT i.user_id FROM integrations i JOIN users u ON u.id=i.user_id
    WHERE i.provider='google' AND u.active=1 ORDER BY (u.role='admin') DESC, u.id`);
  return rows.find(r => getIntegration(r.user_id)?.refresh_token)?.user_id ?? null;
}

export async function ensureLabel(userId) {
  const { labels = [] } = await gmail(userId, 'labels');
  let l = labels.find(x => x.name === LABEL);
  if (!l) l = await gmail(userId, 'labels', { method: 'POST', body: { name: LABEL } });
  return l.id;
}

function bodyText(payload) {
  const walk = p => {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
    for (const part of p.parts || []) { const t = walk(part); if (t) return t; }
    return '';
  };
  return walk(payload).trim();
}

// Unread emails the user labelled "TaskBoard" -> [{id, subject, from, body}]
export async function fetchLabelledEmails(userId) {
  const labelId = await ensureLabel(userId);
  const list = await gmail(userId, `messages?labelIds=${labelId}&labelIds=UNREAD&maxResults=10`);
  const out = [];
  for (const m of list.messages || []) {
    const full = await gmail(userId, `messages/${m.id}?format=full`);
    const h = n => full.payload?.headers?.find(x => x.name.toLowerCase() === n)?.value || '';
    out.push({ id: m.id, subject: h('subject') || '(no subject)', from: h('from'), body: bodyText(full.payload) || full.snippet || '' });
  }
  return out;
}
export const markRead = (userId, id) => gmail(userId, `messages/${id}/modify`, { method: 'POST', body: { removeLabelIds: ['UNREAD'] } });

export async function revoke(userId) {
  const g = getIntegration(userId);
  if (g?.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(g.refresh_token), { method: 'POST' }).catch(() => {});
  run('DELETE FROM integrations WHERE user_id=? AND provider=?', userId, 'google');
}
