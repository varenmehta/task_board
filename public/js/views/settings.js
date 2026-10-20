import { h, mount, icon, toast, ago, modal } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';

const TABS = [['profile', 'Profile', 'user'], ['notifications', 'Notifications', 'bell'], ['integrations', 'Email, phone & AI', 'link'], ['developer', 'API & calendar', 'key'], ['workspace', 'Workspace (admin)', 'shield'], ['audit', 'Audit log (admin)', 'history']];

export async function settingsView(el, tab) {
  if (['workspace', 'audit'].includes(tab) && state.me.role !== 'admin') tab = 'profile';
  const content = h('div', { class: 'grow', style: { maxWidth: '760px' } });
  mount(el, h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Settings'))),
    h('div', { class: 'settings' }, h('nav', { class: 'settings-nav' }, TABS.filter(t => !['workspace', 'audit'].includes(t[0]) || state.me.role === 'admin').map(([k, l, ico]) => h('a', { class: 'nav-item' + (k === tab ? ' active' : ''), href: '#/settings/' + k }, icon(ico, 17), l))), content)));
  const fn = { profile, notifications, integrations, developer, workspace, audit }[tab] || profile;
  await fn(content);
}

const status = (kind, text) => h('span', { class: 'status-pill ' + kind }, text);
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', label), input, hint ? h('div', { class: 'hint' }, hint) : null);
const sw = (checked, onchange, label) => h('label', { class: 'switch', 'aria-label': label }, h('input', { type: 'checkbox', checked, onchange: e => onchange(e.target.checked) }), h('i'));

// ---------- profile ----------
async function profile(box) {
  const me = await api.get('/me');
  const v = { name: me.name, title: me.title || '', slack_id: me.slack_id || '' };
  const pw = { current_password: '', password: '' };
  mount(box,
    h('div', { class: 'card setting-card' }, h('h3', 'Your profile'), h('p', { class: 'muted small', style: { marginBottom: '14px' } }, `${me.email} · ${me.role}`),
      h('div', { class: 'col', style: { gap: '12px' } }, field('Name', h('input', { class: 'input', value: v.name, oninput: e => (v.name = e.target.value) })), field('Job title', h('input', { class: 'input', value: v.title, placeholder: 'e.g. Senior Backend Engineer', oninput: e => (v.title = e.target.value) })),
        field('Slack member ID (optional)', h('input', { class: 'input', value: v.slack_id, placeholder: 'U01ABCDEF', oninput: e => (v.slack_id = e.target.value) }), 'Lets you run /taskboard in Slack. Find it in Slack: profile → ⋯ → Copy member ID.'),
        h('div', h('button', { class: 'btn primary', onclick: async () => { try { Object.assign(state.me, await api.patch('/me', v)); toast('Profile saved', 'success'); } catch (e) { toast(e.message, 'error'); } } }, 'Save profile')))),
    h('div', { class: 'card setting-card' }, h('h3', 'Change password'), h('div', { class: 'col', style: { gap: '12px', marginTop: '12px' } },
      field('Current password', h('input', { class: 'input', type: 'password', autocomplete: 'current-password', oninput: e => (pw.current_password = e.target.value) })), field('New password', h('input', { class: 'input', type: 'password', autocomplete: 'new-password', oninput: e => (pw.password = e.target.value) }), 'At least 8 characters'),
      h('div', h('button', { class: 'btn', onclick: async () => { try { await api.patch('/me', { ...v, ...pw }); toast('Password updated', 'success'); } catch (e) { toast(e.message, 'error'); } } }, 'Update password')))));
}

// ---------- notifications ----------
async function notifications(box) {
  const [me, events, info] = await Promise.all([api.get('/me'), api.get('/notification-events'), api.get('/integrations')]);
  const prefs = me.prefs;
  const save = async patch => { try { const r = await api.put('/me/prefs', patch); Object.assign(prefs, r.prefs); toast('Saved', 'success', 1500); } catch (e) { toast(e.message, 'error'); } };
  const chanNote = [!info.google.connected && info.email_mode === 'simulated' ? 'Email isn’t connected yet — messages are logged only.' : '', !me.phone_verified ? 'Add and verify your phone to receive texts.' : ''].filter(Boolean);
  const matrix = h('table', { class: 'matrix' }, h('thead', h('tr', h('th', 'Notify me when…'), h('th', 'In-app'), h('th', 'Email'), h('th', 'Phone'))),
    h('tbody', Object.entries(events).map(([ev, label]) => h('tr', h('td', label), ...['app', 'email', 'phone'].map(ch => h('td', ev === 'digest' && ch === 'app' ? sw(prefs.matrix[ev][ch], x => save({ matrix: { [ev]: { ...prefs.matrix[ev], [ch]: x } } }), `${label} in-app`) : sw(prefs.matrix[ev][ch], x => { prefs.matrix[ev][ch] = x; save({ matrix: { [ev]: { ...prefs.matrix[ev], [ch]: x } } }); }, `${label} ${ch}`)))))));
  const hours = Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === +prefs.digest_hour }, `${String(i).padStart(2, '0')}:00`));
  mount(box,
    h('div', { class: 'card setting-card' }, h('h3', 'Where should we reach you?'), h('p', { class: 'muted small', style: { marginBottom: '10px' } }, 'Pick a channel for each kind of update. In-app always works; email and phone need a connection (next tab).'),
      chanNote.map(n => h('div', { class: 'chip amber', style: { marginBottom: '8px', marginRight: '6px' } }, n)), h('div', { style: { overflowX: 'auto' } }, matrix)),
    h('div', { class: 'card setting-card' }, h('h3', 'Phone & briefing preferences'),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Text me only for urgent & high-priority work'), h('div', { class: 'small muted' }, 'Mentions always come through. Keeps your phone quiet.')), sw(prefs.phone_urgent_only, x => save({ phone_urgent_only: x }), 'Urgent only')),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Phone channel'), h('div', { class: 'small muted' }, 'WhatsApp needs a Twilio WhatsApp sender.')), h('select', { class: 'select', style: { width: '140px' }, onchange: e => save({ phone_channel: e.target.value }) }, ['sms', 'whatsapp'].map(c => h('option', { value: c, selected: prefs.phone_channel === c }, c === 'sms' ? 'SMS' : 'WhatsApp')))),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Daily briefing time'), h('div', { class: 'small muted' }, 'Your overdue, due-today and in-progress work, with an AI-written heads-up.')), h('select', { class: 'select', style: { width: '120px' }, onchange: e => save({ digest_hour: +e.target.value, tz_offset: new Date().getTimezoneOffset() }) }, hours)),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Weekdays only')), sw(prefs.digest_weekdays_only, x => save({ digest_weekdays_only: x, tz_offset: new Date().getTimezoneOffset() }), 'Weekdays only')),
      h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/integrations/test', { channel: 'briefing' }).catch(e => ({ status: e.message })); toast(r.status === 'sent' ? 'Briefing emailed — check your inbox' : r.status === 'simulated' ? 'Briefing generated (logged in delivery log — connect Gmail to send)' : r.status); } }, icon('mail', 14), 'Send me a preview briefing'))),
    pushCard());
}

function urlB64ToUint8(s) { const pad = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
function pushCard() {
  const card = h('div', { class: 'card setting-card' });
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const paint = async () => {
    const sub = supported ? await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null) : null;
    mount(card, h('h3', 'Push notifications on this device'), h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Get alerts even when TaskBoard is closed'), h('div', { class: 'small muted' }, supported ? 'Works on desktop browsers and on phones once TaskBoard is installed to your home screen (Share/⋮ → Add to Home Screen).' : 'This browser does not support push notifications.')),
      !supported ? null : sub ? h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/push/test').catch(e => ({ sent: 0, e })); toast(r.sent ? 'Sent — check your notifications' : 'Nothing delivered'); } }, 'Send test'), h('button', { class: 'btn sm danger', onclick: async () => { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); paint(); } }, 'Turn off'))
        : h('button', { class: 'btn primary sm', onclick: async () => {
          try {
            if (await Notification.requestPermission() !== 'granted') return toast('Notifications were blocked in your browser settings', 'error');
            const reg = await navigator.serviceWorker.ready;
            const { key } = await api.get('/push/key');
            const s2 = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
            await api.post('/push/subscribe', s2.toJSON()); toast('Push enabled on this device', 'success'); paint();
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Enable')));
  };
  paint();
  return card;
}

// ---------- developer: API tokens, calendar feed ----------
async function developer(box) {
  const [tokens, cal] = await Promise.all([api.get('/tokens'), api.get('/me/calendar')]);
  const copy = v => navigator.clipboard?.writeText(v).then(() => toast('Copied'), () => toast(v));
  const newToken = () => {
    const v = { name: '', scope: 'write', days: '' };
    modal({ title: 'New API token', body: [field('Name', h('input', { class: 'input', placeholder: 'e.g. CI pipeline', oninput: e => (v.name = e.target.value) })),
      field('Access', h('select', { class: 'select', onchange: e => (v.scope = e.target.value) }, [['write', 'Read & write (acts as you)'], ['read', 'Read-only']].map(([k, l]) => h('option', { value: k }, l)))),
      field('Expires', h('select', { class: 'select', onchange: e => (v.days = e.target.value) }, [['', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In a year']].map(([k, l]) => h('option', { value: k }, l))))],
    actions: [{ label: 'Cancel' }, { label: 'Create token', kind: 'primary', onClick: async () => { try { const r = await api.post('/tokens', { ...v, days: v.days ? +v.days : undefined }); modal({ title: 'Your new token', width: 560, body: [h('p', { class: 'muted small' }, 'Copy it now — it will not be shown again.'), h('input', { class: 'input mono', readonly: true, value: r.token, onfocus: e => e.target.select() })], actions: [{ label: 'Copy', kind: 'primary', onClick: () => { copy(r.token); return false; }, keepOpen: true }, { label: 'Done' }] }); developer(box); } catch (e) { toast(e.message, 'error'); return false; } } }] });
  };
  mount(box,
    h('div', { class: 'card setting-card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'API tokens'), h('button', { class: 'btn primary sm', onclick: newToken }, icon('plus', 14), 'New token')),
      h('p', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Use the REST API from scripts and CI: ', h('code', 'curl -H "Authorization: Bearer tb_…" ' + location.origin + '/api/projects'), '. Tokens carry your permissions and are rate-limited to 600 requests/minute.'),
      tokens.length ? tokens.map(t => h('div', { class: 'setting-row' }, icon('key', 16), h('div', { class: 'grow' }, h('b', t.name), h('div', { class: 'small faint' }, `${t.prefix}… · ${t.scope} · ${t.last_used ? 'used ' + t.last_used.slice(0, 10) : 'never used'}${t.expires_at ? ' · expires ' + t.expires_at.slice(0, 10) : ''}`)), h('button', { class: 'btn sm danger', onclick: async () => { await api.del('/tokens/' + t.id); developer(box); } }, 'Revoke'))) : h('p', { class: 'faint small' }, 'No tokens yet.'),
      h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Common endpoints'), h('pre', { class: 'mono small', style: { background: 'var(--surface-2)', padding: '10px', borderRadius: '8px', overflow: 'auto' } }, ['GET    /api/projects', 'GET    /api/projects/:id/board', 'POST   /api/projects/:id/tasks      {title, priority, assignee_id, due_date, labels…}', 'PATCH  /api/tasks/:id               {status, priority, …}', 'POST   /api/tasks/:id/comments      {body}', 'GET    /api/my-tasks', 'GET    /api/search?q=…', 'POST   /api/tasks/bulk              {ids, patch}', 'GET    /api/reports?from=&to='].join('\n')))),
    h('div', { class: 'card setting-card' }, h('h3', 'Calendar feed'), h('p', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Subscribe in Google Calendar, Apple Calendar or Outlook to see your task due dates, sprint boundaries and releases next to your meetings. Treat the link like a password.'),
      h('div', { class: 'row' }, h('input', { class: 'input mono', readonly: true, value: cal.url, onfocus: e => e.target.select() }), h('button', { class: 'btn', onclick: () => copy(cal.url) }, icon('copy', 14), 'Copy'), h('button', { class: 'btn', onclick: async () => { if (confirm('Generate a new link? The old one stops working.')) { await api.post('/me/calendar/rotate'); developer(box); } } }, 'Reset')),
      h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Google Calendar: Other calendars → + → From URL. It refreshes roughly every few hours.')));
}

// ---------- audit log ----------
async function audit(box) {
  const rows = await api.get('/audit?limit=200');
  mount(box, h('div', { class: 'card setting-card' }, h('h3', 'Audit log'), h('p', { class: 'muted small', style: { margin: '2px 0 10px' } }, 'Security-relevant events: sign-ins, role changes, integrations, tokens, settings.'),
    rows.length ? h('div', { class: 'table-wrap', style: { padding: 0 } }, h('table', { class: 't' }, h('thead', h('tr', h('th', 'When'), h('th', 'Who'), h('th', 'Action'), h('th', 'Target'), h('th', { class: 'hide-sm' }, 'IP'))),
      h('tbody', rows.map(r => h('tr', h('td', { class: 'small nowrap' }, ago(r.created_at)), h('td', r.user_name || '—'), h('td', h('span', { class: 'chip ' + (r.action.includes('failed') ? 'red' : r.action.startsWith('settings') || r.action.includes('role') ? 'amber' : '') }, r.action)), h('td', { class: 'small ellipsis', style: { maxWidth: '240px' } }, r.target || ''), h('td', { class: 'small faint hide-sm' }, r.ip || '')))))) : h('p', { class: 'faint' }, 'Nothing recorded yet.')));
}

// ---------- integrations ----------
async function integrations(box) {
  const [info, me, outbox, projects] = await Promise.all([api.get('/integrations'), api.get('/me'), api.get('/outbox'), api.get('/projects')]);
  const g = info.google;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('connected')) { toast('Gmail connected 🎉', 'success'); history.replaceState(null, '', '#/settings/integrations'); }
  if (params.get('error')) { toast('Gmail connection failed: ' + params.get('error'), 'error', 7000); history.replaceState(null, '', '#/settings/integrations'); }

  const gmailCard = h('div', { class: 'card setting-card' }, h('div', { class: 'row' }, h('span', { class: 'chip red', style: { height: '30px', width: '30px', justifyContent: 'center', padding: 0 } }, icon('mail', 16)), h('h3', { class: 'grow' }, 'Gmail'), g.connected ? status('ok', 'Connected') : g.configured ? status('off', 'Not connected') : status('sim', 'Needs admin setup')),
    h('p', { class: 'muted small', style: { margin: '8px 0 12px' } }, 'Send notifications and your daily briefing from Gmail, and turn emails into tasks automatically: just apply the ', h('b', `“${g.label}”`), ' label to any email.'),
    g.connected ? h('div', { class: 'col' },
      h('div', { class: 'small' }, 'Connected as ', h('b', g.email), g.sender ? h('span', { class: 'chip accent', style: { marginLeft: '8px' } }, 'Workspace sender') : null),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Email → task'), h('div', { class: 'small muted' }, `Unread emails labelled “${g.label}” become tasks (checked every ~2 min).`)), sw(me.prefs.email_to_task, async x => { await api.put('/me/prefs', { email_to_task: x }); }, 'Email to task')),
      h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('b', 'Default project for emails & texts')), h('select', { class: 'select', style: { width: '200px' }, onchange: e => api.put('/me/prefs', { default_project_id: e.target.value ? +e.target.value : null }).then(() => toast('Saved', 'success', 1500)) }, [h('option', { value: '' }, 'First available'), ...projects.filter(p => p.can_edit).map(p => h('option', { value: p.id, selected: me.prefs.default_project_id === p.id }, p.name))])),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/integrations/test', { channel: 'email' }); toast(r.status === 'sent' ? 'Test email sent — check your inbox' : 'Logged (' + r.status + ')'); integrations(box); } }, 'Send test email'),
        h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/integrations/test', { channel: 'inbox' }).catch(e => ({ created: e.message })); toast(typeof r.created === 'number' ? `Checked inbox — ${r.created} new task(s)` : r.created); } }, 'Check inbox now'),
        h('button', { class: 'btn sm danger', onclick: async () => { await api.del('/integrations/google'); toast('Disconnected'); integrations(box); } }, 'Disconnect')))
      : h('div', { class: 'row' }, h('a', { class: 'btn primary' + (g.configured ? '' : ' disabled'), href: g.configured ? '/api/integrations/google/start' : '#/settings/workspace', onclick: e => { if (!g.configured) { e.preventDefault(); toast(state.me.role === 'admin' ? 'Add your Google OAuth credentials in the Workspace tab first' : 'Ask an admin to add Google credentials in Settings → Workspace', 'error', 5000); if (state.me.role === 'admin') location.hash = '#/settings/workspace'; } } }, icon('mail', 15), 'Connect Gmail'),
        info.email_mode === 'simulated' ? h('span', { class: 'small faint' }, 'Until connected, emails are only recorded in the delivery log.') : null));

  const phoneCard = () => {
    const card = h('div', { class: 'card setting-card' });
    const paint = (stage = me.phone_verified ? 'done' : me.phone ? 'code' : 'enter') => {
      const num = h('input', { class: 'input', placeholder: '+1 415 555 0123', value: me.phone || '', 'aria-label': 'Phone number' });
      const code = h('input', { class: 'input', placeholder: '6-digit code', inputmode: 'numeric', maxlength: 6, style: { width: '160px' }, 'aria-label': 'Verification code' });
      mount(card, h('div', { class: 'row' }, h('span', { class: 'chip green', style: { height: '30px', width: '30px', justifyContent: 'center', padding: 0 } }, icon('phone', 16)), h('h3', { class: 'grow' }, 'Phone (SMS / WhatsApp)'), me.phone_verified ? status('ok', 'Verified') : status('off', 'Not verified'), info.phone_mode === 'simulated' ? status('sim', 'Simulated') : null),
        h('p', { class: 'muted small', style: { margin: '8px 0 12px' } }, 'Get alerts by text and control tasks by replying: ', h('code', 'list'), ', ', h('code', 'done API-12'), ', ', h('code', 'start API-12'), ', ', h('code', 'add fix login bug tomorrow !high'), '.'),
        stage === 'done' ? h('div', { class: 'col' }, h('div', 'Linked to ', h('b', me.phone)), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/integrations/test', { channel: 'phone' }).catch(e => ({ status: e.message })); toast(r.status === 'sent' ? 'Test message sent' : r.status === 'simulated' ? 'Logged — connect Twilio to send for real' : r.status); integrations(box); } }, 'Send test message'),
          h('button', { class: 'btn sm danger', onclick: async () => { Object.assign(me, await api.del('/me/phone')); paint('enter'); } }, 'Remove number')))
          : stage === 'code' ? h('div', { class: 'col' }, h('div', { class: 'small' }, 'We sent a code to ', h('b', me.phone), info.phone_mode === 'simulated' ? ' (simulated — see the delivery log below for the code).' : '.'), h('div', { class: 'row' }, code, h('button', { class: 'btn primary', onclick: async () => { try { Object.assign(me, await api.post('/me/phone/verify', { code: code.value })); toast('Phone verified', 'success'); integrations(box); } catch (e) { toast(e.message, 'error'); } } }, 'Verify'), h('button', { class: 'btn ghost', onclick: () => paint('enter') }, 'Change number')))
          : h('div', { class: 'row' }, num, h('button', { class: 'btn primary', onclick: async () => { try { await api.post('/me/phone', { phone: num.value }); me.phone = num.value; me.phone_verified = false; paint('code'); integrations.refreshLog?.(); } catch (e) { toast(e.message, 'error'); } } }, 'Send code')),
        info.twilio_configured ? h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Two-way replies: set your Twilio number’s incoming-message webhook to ', h('code', location.origin + info.webhook_path)) : h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Twilio isn’t configured yet — an admin can add it under Workspace. Until then, texts are recorded in the delivery log.'));
    };
    paint();
    return card;
  };

  const aiCard = h('div', { class: 'card setting-card' }, h('div', { class: 'row' }, h('span', { class: 'chip accent', style: { height: '30px', width: '30px', justifyContent: 'center', padding: 0 } }, icon('sparkles', 16)), h('h3', { class: 'grow' }, 'AI assistant'), info.ai_mode === 'claude' ? status('ok', 'Claude enabled') : status('sim', 'Offline mode')),
    h('p', { class: 'muted small', style: { marginTop: '8px' } }, info.ai_mode === 'claude' ? 'Natural-language task creation, subtask breakdown, description rewriting, owner suggestions, risk analysis, standups and a conversational assistant are powered by Claude.' : 'Smart date/priority/@person parsing, templates and rule-based risk detection work offline. ' + (state.me.role === 'admin' ? 'Add an Anthropic API key under Workspace to unlock the full AI features.' : 'Ask an admin to add an Anthropic API key to unlock the full AI features.')));

  const logCard = h('div', { class: 'card setting-card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Delivery log'), h('button', { class: 'btn ghost sm', onclick: () => integrations(box) }, icon('refresh', 14), 'Refresh')), h('p', { class: 'muted small' }, 'Every email and text the system sends or would send.'),
    h('div', { style: { marginTop: '8px' } }, outbox.length ? outbox.slice(0, 14).map(o => h('div', { class: 'outbox-row' }, h('span', { class: 'chip' }, o.channel), h('div', { style: { minWidth: 0 } }, h('div', { class: 'ellipsis', style: { fontWeight: 550 } }, o.subject || o.body.split('\n')[0]), h('div', { class: 'small faint ellipsis' }, `${o.recipient} · ${ago(o.created_at)}${o.error ? ' · ' + o.error : ''}`)), h('span', { class: 'chip ' + ({ sent: 'green', failed: 'red', simulated: 'amber' }[o.status]) }, o.status))) : h('div', { class: 'faint small', style: { padding: '12px 0' } }, 'Nothing sent yet.')));
  integrations.refreshLog = () => setTimeout(() => api.get('/outbox').then(() => integrations(box)), 300);
  mount(box, gmailCard, phoneCard(), aiCard, logCard);
}

// ---------- workspace (admin) ----------
async function workspace(box) {
  const { values, redirect_uri } = await api.get('/settings');
  const v = {};
  const text = (k, label, ph, hint) => field(label, h('input', { class: 'input', value: values[k] || '', placeholder: ph || '', oninput: e => (v[k] = e.target.value) }), hint);
  const secret = (k, label, ph, hint) => field(label, h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: values[k].set ? (values[k].from_env ? 'Set via environment variable' : '•••••••• saved — leave blank to keep') : ph, disabled: values[k].from_env, oninput: e => (v[k] = e.target.value) }), hint);
  const save = async () => { try { await api.put('/settings', v); toast('Settings saved', 'success'); const b = await api.get('/bootstrap'); state.aiMode = b.ai_mode; state.workspace = b.workspace; workspace(box); } catch (e) { toast(e.message, 'error'); } };
  const section = (title, sub, ...kids) => h('div', { class: 'card setting-card' }, h('h3', title), h('p', { class: 'muted small', style: { margin: '2px 0 14px' } }, sub), h('div', { class: 'col', style: { gap: '12px' } }, ...kids));
  mount(box,
    section('General', 'Branding and the public address used in emails and links.', text('workspace_name', 'Workspace name', 'Acme Engineering'), text('base_url', 'Public URL', 'https://tasks.yourcompany.com', 'Used in email links and OAuth. Leave blank to auto-detect.')),
    section('Google (Gmail)', 'Lets each person connect Gmail. Create an OAuth client at console.cloud.google.com → APIs & Services → Credentials (Web application) and enable the Gmail API.',
      field('Authorized redirect URI — copy into Google', h('input', { class: 'input mono', readonly: true, value: (values.base_url || location.origin) + new URL(redirect_uri, location.origin).pathname, onfocus: e => e.target.select() })),
      text('google_client_id', 'Client ID', '123456-abc.apps.googleusercontent.com'), secret('google_client_secret', 'Client secret', 'GOCSPX-…')),
    section('Twilio (SMS & WhatsApp)', 'From console.twilio.com. Set the incoming-message webhook of your number to the URL shown on the Integrations tab.',
      text('twilio_account_sid', 'Account SID', 'AC…'), secret('twilio_auth_token', 'Auth token', ''), h('div', { class: 'row' }, h('div', { class: 'grow' }, text('twilio_from', 'SMS number', '+14155550100')), h('div', { class: 'grow' }, text('twilio_whatsapp_from', 'WhatsApp sender', '+14155238886', 'Optional (Twilio sandbox or approved sender)')))),
    section('Single sign-on (OpenID Connect)', 'Okta, Microsoft Entra ID, Auth0, Keycloak, Google Workspace… Register this redirect URI with your provider: ' + (values.base_url || location.origin) + '/api/auth/sso/callback',
      text('oidc_issuer', 'Issuer URL', 'https://acme.okta.com  ·  https://login.microsoftonline.com/<tenant>/v2.0', 'We read /.well-known/openid-configuration from here.'), h('div', { class: 'row' }, h('div', { class: 'grow' }, text('oidc_client_id', 'Client ID', '')), h('div', { class: 'grow' }, secret('oidc_client_secret', 'Client secret', ''))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, text('sso_label', 'Button label', 'Okta')), h('div', { class: 'grow' }, text('sso_allowed_domains', 'Auto-create accounts for domains', 'acme.com, acme.io', 'Leave empty to allow only invited people.')), h('div', { style: { width: '140px' } }, field('New-user role', h('select', { class: 'select', onchange: e => (v.sso_default_role = e.target.value) }, ['member', 'viewer', 'guest', 'manager'].map(r => h('option', { value: r, selected: (values.sso_default_role || 'member') === r }, r)))))),
      h('label', { class: 'row' }, h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: values.google_login === '1', onchange: e => (v.google_login = e.target.checked ? '1' : '0') }), h('i')), h('span', 'Or: offer “Sign in with Google” using the Google credentials above (add the redirect URI there too)')),
      h('p', { class: 'hint' }, 'SAML is not supported; most identity providers offer OIDC alongside it. Password sign-in stays available for invited users.')),
    section('Slack slash command', 'Create a Slack app with a slash command /taskboard pointing at ' + (values.base_url || location.origin) + '/api/hooks/slack. Teammates can then run list, done KEY, add …',
      secret('slack_signing_secret', 'Signing secret', ''), secret('slack_bot_token', 'Bot token (optional)', 'xoxb-…', 'With users:read.email scope, people are matched to TaskBoard by email automatically; otherwise they paste their Slack member ID in Profile.')),
    section('AI (Anthropic Claude)', 'Powers the assistant, task drafting, breakdowns, risk analysis and briefings. Without a key, offline smart-parsing is used.',
      secret('anthropic_api_key', 'API key', 'sk-ant-…', 'Get one at console.anthropic.com. Stored on your server only.'), text('anthropic_model', 'Model', 'claude-sonnet-5-5', 'Leave blank for the default.')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Save settings'),
      h('button', { class: 'btn', onclick: async () => { const r = await api.post('/admin/run-scheduler').catch(e => ({ error: e.message })); toast(r.error || `Scheduler ran: ${r.reminders} reminder(s), ${r.digests} briefing(s), ${r.inbox} email task(s)`); } }, icon('zap', 14), 'Run scheduler now')));
}
void modal;
