// Outbound email/SMS with a delivery log. When a provider is not configured the
// message is recorded as "simulated" so the app is fully usable out of the box.
import { insert, run, getSetting } from './db.js';
import { googleConfigured, senderUserId, sendViaGmail } from './channels/google.js';
import { twilioConfigured, sendSms } from './channels/twilio.js';
import { esc } from './util.js';

function log(userId, channel, recipient, subject, body, status, error) {
  return insert('INSERT INTO outbox(user_id,channel,recipient,subject,body,status,error) VALUES(?,?,?,?,?,?,?)',
    userId, channel, recipient, subject, body.slice(0, 2000), status, error ?? null);
}

export const emailMode = () => (googleConfigured() && senderUserId() ? 'live' : 'simulated');
export const phoneMode = () => (twilioConfigured() ? 'live' : 'simulated');

export function emailHtml({ heading, body, ctaText, ctaUrl }) {
  const name = esc(getSetting('workspace_name') || 'TaskBoard');
  return `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1f2a">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;border:1px solid #e6e8ef">
<tr><td style="padding:22px 28px;border-bottom:1px solid #eef0f5;font-weight:700;color:#4f46e5">&#9638; ${name}</td></tr>
<tr><td style="padding:28px"><h2 style="margin:0 0 12px;font-size:20px">${esc(heading)}</h2>
<div style="font-size:15px;line-height:1.6;color:#454b5c">${body}</div>
${ctaUrl ? `<p style="margin:24px 0 0"><a href="${esc(ctaUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;display:inline-block">${esc(ctaText || 'Open')}</a></p>` : ''}
</td></tr></table>
<p style="font-size:12px;color:#8b90a0;margin-top:16px">You can change what you receive in Settings → Notifications.</p>
</td></tr></table></body></html>`;
}

export async function sendEmail({ userId = null, to, subject, text, html }) {
  if (!to) return 'skipped';
  const sender = googleConfigured() ? senderUserId() : null;
  if (!sender) { log(userId, 'email', to, subject, text, 'simulated'); return 'simulated'; }
  try {
    await sendViaGmail(sender, { to, subject, text, html: html || `<p>${esc(text)}</p>` });
    log(userId, 'email', to, subject, text, 'sent');
    return 'sent';
  } catch (e) {
    log(userId, 'email', to, subject, text, 'failed', e.message);
    return 'failed';
  }
}

export async function sendPhone({ userId = null, to, text, kind = 'sms' }) {
  if (!to) return 'skipped';
  if (!twilioConfigured()) { log(userId, kind, to, null, text, 'simulated'); return 'simulated'; }
  try {
    await sendSms(to, text, kind);
    log(userId, kind, to, null, text, 'sent');
    return 'sent';
  } catch (e) {
    log(userId, kind, to, null, text, 'failed', e.message);
    return 'failed';
  }
}

export const pruneOutbox = () => run(`DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT 500)`);
