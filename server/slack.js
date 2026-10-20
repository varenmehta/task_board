// Slack slash command (/taskboard …) — verified with Slack's signing secret.
import crypto from 'node:crypto';
import { get, run, getSetting } from './db.js';
import { HttpError } from './util.js';
import { handleCommand } from './commands.js';

export function verifySlack(headers, rawText) {
  const secret = getSetting('slack_signing_secret');
  if (!secret) throw new HttpError(503, 'Slack is not configured');
  const ts = Number(headers['x-slack-request-timestamp']);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw new HttpError(401, 'Stale request');
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${rawText}`).digest('hex');
  const got = String(headers['x-slack-signature'] || '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new HttpError(401, 'Bad signature');
}

const emailCache = new Map();
export const _setSlackLookup = fn => { lookup = fn; };
let lookup = async slackId => {
  const token = getSetting('slack_bot_token');
  if (!token) return null;
  if (emailCache.has(slackId)) return emailCache.get(slackId);
  const r = await fetch('https://slack.com/api/users.info?user=' + encodeURIComponent(slackId), { headers: { Authorization: `Bearer ${token}` } }).then(x => x.json()).catch(() => ({}));
  const email = r.ok ? r.user?.profile?.email?.toLowerCase() || null : null;
  emailCache.set(slackId, email);
  return email;
};

async function resolveUser(slackId) {
  const byId = get('SELECT * FROM users WHERE slack_id=? AND active=1', slackId);
  if (byId) return byId;
  const email = await lookup(slackId);
  return email ? get('SELECT * FROM users WHERE email=? AND active=1', email) : null;
}

export async function handleSlash(body) {
  const user = await resolveUser(body.user_id);
  if (!user) return { response_type: 'ephemeral', text: `I don't know who you are yet. In TaskBoard open *Settings → Profile* and paste your Slack member ID: \`${body.user_id}\``, };
  const text = await handleCommand(user, body.text || 'help');
  return { response_type: 'ephemeral', text };
}
export const linkSlack = (userId, slackId) => run('UPDATE users SET slack_id=? WHERE id=?', slackId || null, userId);
