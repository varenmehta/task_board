// SMS / WhatsApp through Twilio's REST API (plain fetch).
import crypto from 'node:crypto';
import { getSetting } from '../db.js';
import { HttpError } from '../util.js';

export const twilioConfigured = () => !!(getSetting('twilio_account_sid') && getSetting('twilio_auth_token') && (getSetting('twilio_from') || getSetting('twilio_whatsapp_from')));

export const normalizePhone = p => {
  const s = String(p || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
};

export async function sendSms(to, body, kind = 'sms') {
  const sid = getSetting('twilio_account_sid'), token = getSetting('twilio_auth_token');
  const wa = kind === 'whatsapp';
  const from = wa ? getSetting('twilio_whatsapp_from') : getSetting('twilio_from');
  if (!sid || !token || !from) throw new HttpError(400, `Twilio ${wa ? 'WhatsApp ' : ''}sender is not configured`);
  const pre = v => (wa ? `whatsapp:${v.replace(/^whatsapp:/, '')}` : v);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: pre(to), From: pre(from), Body: body.slice(0, 1500) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, j.message || `Twilio error ${r.status}`);
}

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export function validSignature(url, params, signature) {
  const token = getSetting('twilio_auth_token');
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
