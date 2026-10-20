import { h, mount, icon, toast } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';

const hero = () => h('div', { class: 'auth-hero' },
  h('div', { class: 'row', style: { gap: '10px', fontWeight: 700, fontSize: '18px' } }, h('span', { class: 'logo', style: { width: '34px', height: '34px', borderRadius: '10px', background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center' } }, icon('board', 19)), 'TaskBoard'),
  h('h1', 'One board for every team, project and role.'),
  h('p', 'Plan work, hand it off, and let automation and AI handle the follow-ups — in your browser, your inbox and your phone.'),
  h('div', { class: 'feat' },
    h('div', icon('sparkles', 18), h('span', 'AI that drafts tasks from plain English, breaks down epics, and flags risks before they bite.')),
    h('div', icon('mail', 18), h('span', 'Connect Gmail for notifications, a daily briefing — and turn emails into tasks.')),
    h('div', icon('phone', 18), h('span', 'Get SMS/WhatsApp alerts and reply “done API-12” to update from anywhere.')),
    h('div', icon('shield', 18), h('span', 'Teams, projects and roles keep the right people on the right work.'))));

function field(label, input, hint) { return h('div', { class: 'field' }, h('label', label), input, hint ? h('div', { class: 'hint' }, hint) : null); }

export async function renderAuth(root, mode, onAuthed) {
  const err = h('div', { class: 'error-msg hide' });
  const showErr = m => { err.textContent = m; err.classList.remove('hide'); };
  const input = (name, type = 'text', props = {}) => h('input', { class: 'input', name, type, required: true, ...props });
  let form;

  async function submit(e, fn, btn) {
    e.preventDefault();
    err.classList.add('hide');
    btn.disabled = true;
    try { onAuthed(await fn()); } catch (ex) { showErr(ex.message); btn.disabled = false; }
  }

  if (mode === 'setup') {
    const f = { workspace: input('workspace', 'text', { value: 'Acme Engineering' }), name: input('name', 'text', { autocomplete: 'name' }), email: input('email', 'email', { autocomplete: 'email' }), password: input('password', 'password', { minlength: 8, autocomplete: 'new-password' }) };
    const demo = h('input', { type: 'checkbox', checked: true });
    const btn = h('button', { class: 'btn primary', style: { height: '40px' } }, 'Create workspace');
    form = h('form', { class: 'auth-card', onsubmit: e => submit(e, () => api.post('/setup', { workspace: f.workspace.value, name: f.name.value, email: f.email.value, password: f.password.value, demo: demo.checked }), btn) },
      h('div', h('h2', 'Set up your workspace'), h('p', { class: 'muted', style: { marginTop: '4px' } }, 'You’ll be the admin. Invite your team afterwards.')),
      field('Workspace name', f.workspace), field('Your name', f.name), field('Work email', f.email), field('Password', f.password, 'At least 8 characters'),
      h('label', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } }, demo, h('span', h('b', 'Load sample data'), h('div', { class: 'hint' }, 'Two teams, four projects, sample tasks and teammates (password demo1234) so you can explore roles right away.'))),
      err, btn);
  } else if (mode === 'invite') {
    const token = location.hash.split('/')[2];
    let info = null;
    try { info = await api.get('/invite/' + token); } catch (e) { form = h('div', { class: 'auth-card' }, h('h2', 'Invitation unavailable'), h('p', { class: 'muted' }, e.message), h('a', { href: '#/' }, 'Go to sign in')); }
    if (info) {
      const f = { name: input('name', 'text', { value: info.name }), password: input('password', 'password', { minlength: 8, autocomplete: 'new-password' }) };
      const btn = h('button', { class: 'btn primary', style: { height: '40px' } }, 'Join workspace');
      form = h('form', { class: 'auth-card', onsubmit: e => submit(e, () => api.post('/invite/' + token, { name: f.name.value, password: f.password.value }), btn) },
        h('div', h('h2', 'Welcome aboard 👋'), h('p', { class: 'muted', style: { marginTop: '4px' } }, 'Set a password for ', h('b', info.email))), field('Your name', f.name), field('Choose a password', f.password, 'At least 8 characters'), err, btn);
    }
  } else {
    const f = { email: input('email', 'email', { autocomplete: 'username' }), password: input('password', 'password', { autocomplete: 'current-password' }) };
    const btn = h('button', { class: 'btn primary', style: { height: '40px' } }, 'Sign in');
    form = h('form', { class: 'auth-card', onsubmit: e => submit(e, () => api.post('/login', { email: f.email.value, password: f.password.value }), btn) },
      h('div', h('h2', 'Welcome back'), h('p', { class: 'muted', style: { marginTop: '4px' } }, 'Sign in to your workspace.')), field('Email', f.email), field('Password', f.password), err, btn,
      !state.demo ? null : h('div', { class: 'demo-box' }, h('b', 'Sample workspace? '), 'Try a role: ',
        ...[['Manager', 'priya@demo.taskboard.dev'], ['Engineer', 'marcus@demo.taskboard.dev'], ['Viewer', 'dana@demo.taskboard.dev']].map(([r, em]) => h('button', { type: 'button', onclick: () => { f.email.value = em; f.password.value = 'demo1234'; } }, `${r} — ${em}`))));
  }
  mount(root, h('div', { class: 'auth' }, hero(), h('div', { class: 'auth-form' }, form)));
  void toast;
}
