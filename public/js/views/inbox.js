import { h, mount, icon, ago } from '../dom.js';
import { api } from '../api.js';
import { on } from '../state.js';
import { setUnread } from '../main.js';

const ICON = { assigned: 'user', mention: 'message', comment: 'message', status: 'refresh', due: 'clock', digest: 'mail' };

export async function inboxView(el) {
  const render = async () => {
    const { items, unread } = await api.get('/notifications');
    setUnread(unread);
    mount(el, h('div', { class: 'page', style: { maxWidth: '820px' } },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Inbox'), h('p', { class: 'muted' }, unread ? `${unread} unread` : 'You’re all caught up')),
        h('button', { class: 'btn', disabled: !unread, onclick: async () => { await api.post('/notifications/read', {}); render(); } }, icon('check', 15), 'Mark all read'),
        h('a', { class: 'btn', href: '#/settings/notifications' }, icon('settings', 15), 'Preferences')),
      h('div', { class: 'card', style: { overflow: 'hidden' } }, items.length ? items.map(n => h('div', { class: 'notif' + (n.read ? '' : ' unread'), tabindex: 0, onclick: async () => { if (!n.read) await api.post('/notifications/read', { id: n.id }); if (n.task_id) location.hash = '#/task/' + n.task_id; else render(); } },
        h('div', { class: 'ni' }, icon(ICON[n.type] || 'bell', 17)), h('div', { class: 'grow' }, h('div', { style: { fontWeight: n.read ? 500 : 650 } }, n.title), n.body ? h('div', { class: 'small muted', style: { marginTop: '2px', whiteSpace: 'pre-wrap' } }, n.body.slice(0, 280)) : null), h('span', { class: 'small faint nowrap' }, ago(n.created_at)))) : h('div', { class: 'empty' }, h('b', 'No notifications yet'), 'Assignments, mentions and reminders will show up here — and in your email and phone if you connect them.'))));
  };
  await render();
  return on('notification', render);
}
