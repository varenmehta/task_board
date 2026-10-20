// OpenID Connect sign-in (Okta, Azure AD/Entra, Auth0, Keycloak, Google …) with optional auto-provisioning.
import crypto from 'node:crypto';
import { get, insert, getSetting, parseJSON } from './db.js';
import { sign, verify } from './auth.js';
import { HttpError, pickColor } from './util.js';
import { ORG_ROLES } from './config.js';

export function ssoConfig(base) {
  const issuer = getSetting('oidc_issuer'), id = getSetting('oidc_client_id'), secret = getSetting('oidc_client_secret');
  if (issuer && id && secret) return { issuer: issuer.replace(/\/$/, ''), id, secret, label: getSetting('sso_label') || 'SSO', redirect: `${getSetting('base_url') || base}/api/auth/sso/callback` };
  if (getSetting('google_login') === '1' && getSetting('google_client_id') && getSetting('google_client_secret'))
    return { issuer: 'https://accounts.google.com', id: getSetting('google_client_id'), secret: getSetting('google_client_secret'), label: 'Google', redirect: `${getSetting('base_url') || base}/api/auth/sso/callback` };
  return null;
}

const discoveryCache = new Map();
async function discover(issuer) {
  const hit = discoveryCache.get(issuer);
  if (hit && hit.exp > Date.now()) return hit.doc;
  const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new HttpError(502, 'Could not reach the identity provider');
  const doc = await r.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new HttpError(502, 'Identity provider returned an invalid configuration');
  discoveryCache.set(issuer, { doc, exp: Date.now() + 3600_000 });
  return doc;
}

export async function startUrl(cfg) {
  const doc = await discover(cfg.issuer);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = sign({ n: nonce, k: 'sso' }, 600);
  const q = new URLSearchParams({ client_id: cfg.id, redirect_uri: cfg.redirect, response_type: 'code', scope: 'openid email profile', state, nonce });
  return { url: `${doc.authorization_endpoint}?${q}`, state, nonce };
}

export async function finish(cfg, code, state) {
  const st = verify(state);
  if (!st || st.k !== 'sso') throw new HttpError(400, 'Sign-in session expired — try again');
  const doc = await discover(cfg.issuer);
  const r = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirect, client_id: cfg.id, client_secret: cfg.secret }) });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new HttpError(401, tok.error_description || 'The identity provider rejected the sign-in');
  // The ID token comes straight from the token endpoint over TLS, so (per OIDC Core §3.1.3.7) we validate its claims
  // rather than its signature.
  const claims = parseJSON(Buffer.from(tok.id_token.split('.')[1] || '', 'base64url').toString(), null);
  if (!claims) throw new HttpError(401, 'Invalid ID token');
  const aud = [].concat(claims.aud);
  if (claims.iss?.replace(/\/$/, '') !== (doc.issuer || cfg.issuer).replace(/\/$/, '') || !aud.includes(cfg.id) || claims.exp * 1000 < Date.now() || claims.nonce !== st.n) throw new HttpError(401, 'ID token failed validation');
  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email) || claims.email_verified === false) throw new HttpError(401, 'Your identity provider did not return a verified email');
  return { email, name: claims.name || email.split('@')[0] };
}

export function userForSso({ email, name }) {
  const existing = get('SELECT * FROM users WHERE email=? AND active=1', email);
  if (existing) return existing;
  if (get('SELECT 1 FROM users WHERE email=? AND active=0', email)) throw new HttpError(403, 'This account has been deactivated');
  const domains = getSetting('sso_allowed_domains').split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!domains.length || !domains.includes(email.split('@')[1])) throw new HttpError(403, 'No TaskBoard account for this email — ask an admin to invite you');
  const role = ORG_ROLES.includes(getSetting('sso_default_role')) && getSetting('sso_default_role') !== 'admin' ? getSetting('sso_default_role') : 'member';
  const id = insert('INSERT INTO users(email,name,role,color,title) VALUES(?,?,?,?,?)', email, String(name).slice(0, 80), role, pickColor(get('SELECT COUNT(*) n FROM users').n + 2), '');
  return get('SELECT * FROM users WHERE id=?', id);
}
