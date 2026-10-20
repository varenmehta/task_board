import { h, mount, icon, priorityBadge, statusDot, dueInfo, todayStr } from '../dom.js';
import { api } from '../api.js';
import { state, on, projectById } from '../state.js';
import { openTask } from './task.js';

export async function myTasksView(el) {
  mount(el, h('div', { class: 'page' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' }))));
  const render = async () => {
    const tasks = await api.get('/my-tasks');
    const open = tasks.filter(t => t.status !== 'done');
    const t = todayStr();
    const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const groups = [
      ['Overdue', 'red', open.filter(x => x.due_date && x.due_date < t)],
      ['Today', 'amber', open.filter(x => x.due_date === t)],
      ['This week', 'blue', open.filter(x => x.due_date > t && x.due_date <= week)],
      ['Later', '', open.filter(x => x.due_date > week)],
      ['No due date', '', open.filter(x => !x.due_date)],
    ].filter(g => g[2].length);
    const done = tasks.filter(x => x.status === 'done').slice(-8).reverse();
    const row = x => h('div', { class: 'trow', tabindex: 0, onclick: () => openTask(x.id), onkeydown: e => e.key === 'Enter' && openTask(x.id) },
      h('button', { class: 'check' + (x.status === 'done' ? ' on' : ''), 'aria-label': x.status === 'done' ? 'Reopen' : 'Mark done', onclick: async e => { e.stopPropagation(); await api.patch('/tasks/' + x.id, { status: x.status === 'done' ? 'todo' : 'done' }); render(); } }, x.status === 'done' ? icon('check', 12) : null),
      h('span', { class: 'mono small faint nowrap' }, x.key), h('span', { class: 'grow ellipsis', style: { fontWeight: 550, textDecoration: x.status === 'done' ? 'line-through' : 'none' } }, x.title),
      h('span', { class: 'small faint hide-sm' }, projectById(x.project_id)?.name || x.project_name), statusDot(x.status), priorityBadge(x.priority, true),
      x.due_date ? h('span', { class: 'due small ' + dueInfo(x.due_date, x.status === 'done').state }, dueInfo(x.due_date, x.status === 'done').label) : null);
    mount(el, h('div', { class: 'page', style: { maxWidth: '980px' } },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'My tasks'), h('p', { class: 'muted' }, open.length ? `${open.length} open across ${new Set(open.map(x => x.project_id)).size} project(s)` : 'Nothing assigned to you.'))),
      groups.map(([name, color, list]) => h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-head' }, h('h3', name), h('span', { class: 'chip ' + color }, list.length)), h('div', { class: 'card-body' }, list.map(row)))),
      !groups.length ? h('div', { class: 'card empty' }, h('b', 'Inbox zero 🎉'), 'Ask a teammate or the AI assistant for more work, or take a break.') : null,
      done.length ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Recently completed')), h('div', { class: 'card-body' }, done.map(row))) : null));
  };
  await render();
  return on('task', () => { clearTimeout(el._t); el._t = setTimeout(render, 300); });
}
void state;
