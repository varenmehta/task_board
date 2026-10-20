import { h, mount, icon, avatar, dueInfo, priorityBadge, statusDot, toast, todayStr } from '../dom.js';
import { api } from '../api.js';
import { state, on } from '../state.js';
import { openTask } from './task.js';
import { toggleAssistant } from './assistant.js';

export async function dashboardView(el, scope = {}) {
  mount(el, h('div', { class: 'page' }, h('div', { class: 'grid g4' }, [1, 2, 3, 4].map(() => h('div', { class: 'card skeleton', style: { height: '88px' } })))));
  let d;
  try { d = await api.get('/dashboard' + (scope.team_id || scope.user_id ? `?${new URLSearchParams(scope)}` : '')); } catch (e) { mount(el, h('div', { class: 'page' }, h('div', { class: 'empty' }, e.message))); return; }
  const hr = new Date().getHours();
  const hello = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const stat = (v, l, cls = '') => h('div', { class: 'card stat ' + cls }, h('span', { class: 'v' }, v), h('span', { class: 'l' }, l));

  const brief = h('div', { class: 'card hero-ai card-pad' });
  const runBrief = async () => {
    mount(brief, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, 'Reviewing your boards…')));
    try {
      const r = await api.post('/ai/risks', { today: todayStr() });
      mount(brief, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'ai-badge' }, icon('sparkles', 12), r.ai ? 'AI briefing' : 'Smart briefing'), h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', onclick: runBrief }, icon('refresh', 14), 'Refresh')),
        r.summary ? h('p', { style: { fontWeight: 550, marginBottom: '8px' } }, r.summary) : null,
        r.risks.length ? r.risks.slice(0, 4).map(x => h('div', { class: 'risk', style: { cursor: x.task_id ? 'pointer' : 'default' }, onclick: () => x.task_id && openTask(x.task_id) }, h('span', { class: 'lvl ' + x.level }), h('div', x.key ? h('b', { class: 'mono small' }, x.key + ' ') : null, x.reason))) : h('p', { class: 'muted' }, '🎉 Nothing needs attention — your boards look healthy.'),
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: () => toggleAssistant('Give me a standup summary') }, 'Ask the assistant →')));
    } catch (e) { mount(brief, h('p', { class: 'muted' }, 'Briefing unavailable: ' + e.message)); }
  };
  runBrief();

  const maxV = Math.max(1, ...d.velocity.map(v => Math.max(v.done, v.created)));
  const maxW = Math.max(1, ...d.workload.map(w => w.open));
  mount(el, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', `${hello}, ${state.me.name.split(' ')[0]} 👋`), h('p', { class: 'muted' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))),
      state.me.role !== 'guest' ? h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Team scope', onchange: e => dashboardView(el, { ...scope, team_id: e.target.value || undefined }) }, [h('option', { value: '' }, 'All teams'), ...state.teams.map(t => h('option', { value: t.id, selected: String(scope.team_id) === String(t.id) }, t.name))]) : null,
      state.me.role !== 'guest' ? h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'Person scope', onchange: e => dashboardView(el, { ...scope, user_id: e.target.value || undefined }) }, [h('option', { value: '' }, 'My tasks'), ...state.users.filter(u => u.id !== state.me.id).map(u => h('option', { value: u.id, selected: String(scope.user_id) === String(u.id) }, u.name))]) : null),
    h('div', { class: 'grid g4', style: { marginBottom: '16px' } }, stat(d.totals.open, 'Open tasks'), stat(d.totals.overdue, 'Overdue', d.totals.overdue ? 'warn' : ''), stat(d.totals.done_week, 'Completed this week'), stat(d.totals.unassigned, 'Unassigned')),
    h('div', { class: 'grid g2', style: { marginBottom: '16px' } },
      h('div', { class: 'col', style: { gap: '16px' } }, brief,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', scope.user_id ? `Up next for ${state.users.find(u => u.id === +scope.user_id)?.name?.split(' ')[0] || 'them'}` : 'Up next for you'), h('span', { class: 'grow' }), h('a', { href: '#/my-tasks', class: 'small' }, 'View all')),
          h('div', { class: 'card-body' }, d.mine.length ? d.mine.map(t => { const due = dueInfo(t.due_date, false); return h('div', { class: 'trow', tabindex: 0, onclick: () => openTask(t.id), onkeydown: e => e.key === 'Enter' && openTask(t.id) }, statusDot(t.status, t.status_category), h('span', { class: 'mono small faint' }, t.key), h('span', { class: 'grow ellipsis', style: { fontWeight: 550 } }, t.title), priorityBadge(t.priority, true), due ? h('span', { class: 'due small ' + due.state }, due.label) : null); }) : h('div', { class: 'empty' }, h('b', 'You’re all caught up'), 'Nothing is assigned to you right now.')))),
      h('div', { class: 'col', style: { gap: '16px' } },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Throughput · 14 days'), h('span', { class: 'grow' }), h('span', { class: 'legend' }, h('span', h('i', { style: { background: 'var(--accent)' } }), 'Done'), h('span', h('i', { style: { background: 'var(--surface-3)' } }), 'Created'))),
          h('div', { class: 'card-body' }, h('div', { class: 'spark', style: { height: '96px' } }, d.velocity.map(v => h('div', { style: { flex: 1, display: 'flex', alignItems: 'flex-end', gap: '2px', height: '100%' }, title: `${v.date}: ${v.done} done, ${v.created} created` }, h('i', { class: 'c', style: { height: (v.created / maxV * 100) + '%' } }), h('i', { style: { height: (v.done / maxV * 100) + '%' } })))))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Team workload')), h('div', { class: 'card-body col', style: { gap: '10px' } }, d.workload.length ? d.workload.map(w => h('div', h('div', { class: 'row', style: { marginBottom: '3px' } }, avatar(w, 20), h('span', { class: 'grow' }, w.name), w.overdue ? h('span', { class: 'chip red' }, w.overdue + ' overdue') : null, h('span', { class: 'small faint' }, w.open + ' open')), h('div', { class: 'bar' }, h('i', { style: { width: (w.open / maxW * 100) + '%', background: w.overdue ? 'var(--red)' : w.open >= 6 ? 'var(--amber)' : 'var(--accent)' } })))) : h('p', { class: 'muted' }, 'No assigned work yet.'))))),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Projects')), h('div', { class: 'card-body' }, d.projects.length ? h('div', { class: 'grid g3' }, d.projects.map(p => {
      const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      return h('a', { href: '#/project/' + p.id, class: 'card card-pad', style: { textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: 'none' } },
        h('div', { class: 'row' }, h('span', { class: 'proj-key', style: { background: p.color } }, p.key), h('b', { class: 'grow ellipsis' }, p.name), p.overdue ? h('span', { class: 'chip red' }, p.overdue + ' overdue') : null),
        h('div', { class: 'small faint' }, p.team_name), h('div', { class: 'progress', style: { height: '6px' } }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'row small muted' }, `${pct}% complete`, h('span', { class: 'grow' }), `${p.doing} in progress · ${p.total - p.done} open`));
    })) : h('div', { class: 'empty' }, h('b', 'No projects yet'), 'Create one from the sidebar.')))));
  const off = on('task', () => { clearTimeout(el._t); el._t = setTimeout(() => dashboardView(el, scope), 600); });
  return off;
}
void toast;
