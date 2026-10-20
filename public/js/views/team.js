import { h, mount, icon, avatar, toast, modal, menu, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { state, canManage } from '../state.js';
import { reloadLookups } from '../main.js';

const ROLE_INFO = {
  admin: ['Admin', 'Full access: settings, people, all teams and projects'],
  manager: ['Manager', 'Creates teams & projects, manages automations'],
  member: ['Member', 'Creates and edits tasks in their teams’ projects'],
  viewer: ['Viewer', 'Read-only access to their teams’ projects'],
};
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

export function roleChip(role) { return h('span', { class: 'chip ' + ({ admin: 'accent', manager: 'blue', member: '', viewer: 'amber' }[role] || '') }, ROLE_INFO[role]?.[0] || role); }

function colorPicker(initial, onPick) {
  let cur = initial || COLORS[0];
  const wrap = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
  const paint = () => wrap.replaceChildren(...COLORS.map(c => h('button', { type: 'button', 'aria-label': c, style: { width: '26px', height: '26px', borderRadius: '8px', border: c === cur ? '2px solid var(--text)' : '2px solid transparent', background: c, outline: 'none' }, onclick: () => { cur = c; onPick(c); paint(); } })));
  paint(); onPick(cur);
  return wrap;
}

export function projectModal(project, onDone) {
  const editing = !!project;
  const manageable = state.teams.filter(t => t.can_manage);
  if (!editing && !manageable.length) return toast('You need to be a team lead, manager or admin to create projects', 'error');
  const v = { name: project?.name || '', key: project?.key || '', description: project?.description || '', team_id: project?.team_id || manageable[0].id, color: project?.color };
  const name = h('input', { class: 'input', value: v.name, placeholder: 'e.g. Mobile App', oninput: () => { v.name = name.value; if (!editing && !keyTouched) { v.key = name.value.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase(); key.value = v.key; } } });
  let keyTouched = false;
  const key = h('input', { class: 'input', value: v.key, maxlength: 5, disabled: editing, style: { textTransform: 'uppercase' }, oninput: () => { keyTouched = true; v.key = key.value.toUpperCase(); } });
  const desc = h('textarea', { class: 'textarea', style: { minHeight: '64px' }, oninput: () => (v.description = desc.value) }, v.description);
  const team = h('select', { class: 'select', disabled: editing, onchange: () => (v.team_id = +team.value) }, manageable.map(t => h('option', { value: t.id, selected: t.id === v.team_id }, t.name)));
  modal({
    title: editing ? 'Project settings' : 'New project', body: [
      h('div', { class: 'field' }, h('label', 'Name'), name),
      h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', 'Team'), team), h('div', { class: 'field', style: { width: '120px' } }, h('label', 'Key'), key)),
      h('div', { class: 'field' }, h('label', 'Description'), desc), h('div', { class: 'field' }, h('label', 'Color'), colorPicker(v.color, c => (v.color = c))),
      editing ? h('div', { class: 'hint' }, 'Archiving hides the project from boards but keeps all data.') : h('div', { class: 'hint' }, 'The key prefixes task IDs, e.g. ' + (v.key || 'API') + '-12. Everyone in the team gets access.')],
    actions: [{ label: 'Cancel' }, ...(editing ? [{ label: 'Archive', kind: 'danger', onClick: async () => { if (!(await confirmDialog('Archive project?', `“${project.name}” will disappear from the sidebar. An admin can restore it via the API.`, 'Archive'))) return false; await api.patch('/projects/' + project.id, { archived: true }); await reloadLookups(); toast('Project archived'); location.hash = '#/'; } }] : []),
      { label: editing ? 'Save' : 'Create project', kind: 'primary', onClick: async () => {
        try {
          if (editing) { await api.patch('/projects/' + project.id, v); toast('Saved', 'success'); await reloadLookups(); onDone?.(); }
          else { const p = await api.post('/projects', v); await reloadLookups(); location.hash = '#/project/' + p.id; toast(`Created ${p.name}`, 'success'); }
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
  });
}

export function teamModal(team, onDone) {
  const v = { name: team?.name || '', description: team?.description || '', color: team?.color };
  const name = h('input', { class: 'input', value: v.name, placeholder: 'e.g. Platform', oninput: () => (v.name = name.value) });
  const desc = h('input', { class: 'input', value: v.description, placeholder: 'What does this team own?', oninput: () => (v.description = desc.value) });
  modal({ title: team ? 'Edit team' : 'New team', body: [h('div', { class: 'field' }, h('label', 'Name'), name), h('div', { class: 'field' }, h('label', 'Description'), desc), h('div', { class: 'field' }, h('label', 'Color'), colorPicker(v.color, c => (v.color = c)))],
    actions: [{ label: 'Cancel' }, { label: team ? 'Save' : 'Create team', kind: 'primary', onClick: async () => { try { team ? await api.patch('/teams/' + team.id, v) : await api.post('/teams', v); await reloadLookups(); onDone?.(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}

function inviteModal(onDone) {
  const v = { name: '', email: '', role: 'member', team_ids: [] };
  const name = h('input', { class: 'input', placeholder: 'Full name', oninput: () => (v.name = name.value) });
  const email = h('input', { class: 'input', type: 'email', placeholder: 'name@company.com', oninput: () => (v.email = email.value) });
  const role = h('select', { class: 'select', onchange: () => (v.role = role.value) }, Object.entries(ROLE_INFO).map(([k, [l, d]]) => h('option', { value: k, selected: k === 'member' }, `${l} — ${d}`)));
  const teams = h('div', { class: 'col', style: { gap: '6px' } }, state.teams.map(t => h('label', { class: 'row' }, h('input', { type: 'checkbox', onchange: e => { e.target.checked ? v.team_ids.push(t.id) : v.team_ids.splice(v.team_ids.indexOf(t.id), 1); } }), h('span', { class: 'pdot', style: { background: t.color } }), t.name)));
  modal({ title: 'Invite a teammate', body: [h('div', { class: 'field' }, h('label', 'Name'), name), h('div', { class: 'field' }, h('label', 'Email'), email), h('div', { class: 'field' }, h('label', 'Role'), role), h('div', { class: 'field' }, h('label', 'Add to teams'), teams)],
    actions: [{ label: 'Cancel' }, { label: 'Send invite', kind: 'primary', onClick: async () => {
      try {
        const r = await api.post('/users', v); await reloadLookups(); onDone?.();
        modal({ title: 'Invitation ready', body: [h('p', { class: 'muted' }, r.email_status === 'sent' ? `We emailed ${v.email}. You can also share this link:` : 'Email isn’t connected yet (or failed), so share this link with them directly:'), h('input', { class: 'input mono', readonly: true, value: r.invite_link, onfocus: e => e.target.select() })], actions: [{ label: 'Copy link', kind: 'primary', onClick: () => { navigator.clipboard?.writeText(r.invite_link); toast('Copied'); } }] });
      } catch (e) { toast(e.message, 'error'); return false; }
    } }] });
}

export async function teamView(el) {
  const render = async () => {
    await reloadLookups();
    const isAdmin = state.me.role === 'admin';
    const people = state.users;
    const teamCard = t => {
      const addable = people.filter(u => !t.members.some(m => m.id === u.id));
      return h('div', { class: 'card team-card' },
        h('div', { class: 'row' }, h('span', { class: 'pdot', style: { background: t.color, width: '12px', height: '12px' } }), h('h3', { class: 'grow' }, t.name),
          t.can_manage ? h('button', { class: 'icon-btn', 'aria-label': 'Edit team', onclick: () => teamModal(t, render) }, icon('edit', 16)) : null,
          isAdmin ? h('button', { class: 'icon-btn', 'aria-label': 'Delete team', onclick: async () => { if (await confirmDialog('Delete team?', `“${t.name}”, all its projects and tasks will be permanently deleted.`)) { await api.del('/teams/' + t.id).catch(e => toast(e.message, 'error')); render(); } } }, icon('trash', 16)) : null),
        t.description ? h('p', { class: 'muted small' }, t.description) : null,
        h('div', t.members.map(m => h('div', { class: 'member' }, avatar(m, 28), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 550 } }, m.name), h('div', { class: 'small faint' }, m.email)),
          t.can_manage ? h('button', { class: 'chip ' + (m.role === 'lead' ? 'accent' : ''), style: { border: 0, cursor: 'pointer' }, title: 'Change team role', onclick: e => menu(e.currentTarget, [
            { label: 'Team lead', checked: m.role === 'lead', onClick: async () => { await api.put(`/teams/${t.id}/members/${m.id}`, { role: 'lead' }).catch(er => toast(er.message, 'error')); render(); } },
            { label: 'Member', checked: m.role === 'member', onClick: async () => { await api.put(`/teams/${t.id}/members/${m.id}`, { role: 'member' }).catch(er => toast(er.message, 'error')); render(); } }, { divider: true },
            { label: 'Remove from team', danger: true, icon: 'x', onClick: async () => { await api.del(`/teams/${t.id}/members/${m.id}`).catch(er => toast(er.message, 'error')); render(); } }], { align: 'right' }) }, m.role === 'lead' ? 'Lead' : 'Member', icon('chevronDown', 11)) : h('span', { class: 'chip ' + (m.role === 'lead' ? 'accent' : '') }, m.role === 'lead' ? 'Lead' : 'Member')))),
        t.can_manage && addable.length ? h('button', { class: 'btn sm', style: { alignSelf: 'flex-start' }, onclick: e => menu(e.currentTarget, addable.map(u => ({ node: avatar(u, 20), label: u.name, onClick: async () => { await api.put(`/teams/${t.id}/members/${u.id}`, { role: 'member' }).catch(er => toast(er.message, 'error')); render(); } }))) }, icon('plus', 14), 'Add member') : null,
        t.projects.length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, t.projects.map(p => h('a', { href: '#/project/' + p.id, class: 'chip', style: { textDecoration: 'none' } }, h('span', { class: 'pdot', style: { background: p.color } }), p.name))) : null);
    };
    mount(el, h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Teams & people'), h('p', { class: 'muted' }, 'Teams own projects. A person’s role decides what they can do; team membership decides what they can see.')),
        canManage() ? h('button', { class: 'btn', onclick: () => teamModal(null, render) }, icon('plus', 15), 'New team') : null, isAdmin ? h('button', { class: 'btn primary', onclick: () => inviteModal(render) }, icon('mail', 15), 'Invite person') : null),
      h('div', { class: 'grid g3', style: { marginBottom: '22px', alignItems: 'start' } }, state.teams.length ? state.teams.map(teamCard) : h('div', { class: 'empty card' }, h('b', 'No teams yet'), 'Create a team to start organising projects.')),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', `People (${people.length})`)),
        h('div', { class: 'table-wrap', style: { padding: '8px 0 4px' } }, h('table', { class: 't', style: { border: 0, borderRadius: 0 } }, h('thead', h('tr', h('th', 'Name'), h('th', 'Role'), h('th', { class: 'hide-sm' }, 'Teams'), h('th', ''))),
          h('tbody', people.map(u => h('tr', h('td', h('div', { class: 'row' }, avatar(u, 30), h('div', h('div', { style: { fontWeight: 600 } }, u.name, u.id === state.me.id ? h('span', { class: 'small faint' }, ' (you)') : null, u.pending ? h('span', { class: 'chip amber', style: { marginLeft: '6px' } }, 'Invited') : null), h('div', { class: 'small faint' }, u.title || u.email)))),
            h('td', isAdmin && u.id !== state.me.id ? h('button', { class: 'cell-btn', onclick: e => menu(e.currentTarget, Object.entries(ROLE_INFO).map(([k, [l, d]]) => ({ label: `${l} — ${d}`, checked: u.role === k, onClick: async () => { await api.patch('/users/' + u.id, { role: k }).catch(er => toast(er.message, 'error')); render(); } }))) }, roleChip(u.role), icon('chevronDown', 12)) : roleChip(u.role)),
            h('td', { class: 'hide-sm' }, h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px' } }, u.role === 'admin' ? h('span', { class: 'small faint' }, 'All teams') : u.teams.map(x => { const t = state.teams.find(tt => tt.id === x.team_id); return t ? h('span', { class: 'chip' }, t.name) : null; }))),
            h('td', { style: { textAlign: 'right' } }, isAdmin && u.id !== state.me.id ? h('button', { class: 'icon-btn', 'aria-label': 'Remove ' + u.name, onclick: async () => { if (await confirmDialog('Remove ' + u.name + '?', 'They lose access immediately and their tasks become unassigned.', 'Remove')) { await api.del('/users/' + u.id).catch(er => toast(er.message, 'error')); render(); } } }, icon('trash', 16)) : null)))))),
      h('div', { class: 'card card-pad', style: { marginTop: '16px' } }, h('h3', { style: { marginBottom: '10px' } }, 'What each role can do'),
        h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' } }, Object.entries(ROLE_INFO).map(([k, [l, d]]) => h('div', roleChip(k), h('p', { class: 'small muted', style: { marginTop: '6px' } }, d))))))));
  };
  await render();
}
