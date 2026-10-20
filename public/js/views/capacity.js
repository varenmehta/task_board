import { h, mount, icon, avatar, toast, modal, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';

const fmt = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export async function capacityView(el) {
  const ctl = { weeks: 6, from: undefined };
  const render = async () => {
    let r;
    try { r = await api.get(`/capacity?weeks=${ctl.weeks}${ctl.from ? '&from=' + ctl.from : ''}`); } catch (e) { return mount(el, h('div', { class: 'page' }, h('div', { class: 'empty' }, e.message))); }
    const me = state.me;
    const heat = u => (u > 110 ? 'var(--red)' : u > 85 ? 'var(--amber)' : u > 0 ? 'var(--green)' : 'var(--surface-3)');
    const shift = n => { const d = new Date(r.start + 'T00:00:00'); d.setDate(d.getDate() + n * 7); ctl.from = d.toISOString().slice(0, 10); render(); };
    mount(el, h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Capacity & time off'), h('p', { class: 'muted' }, 'Planned work (estimates by due date) against what each person can realistically do each week.')),
        h('button', { class: 'btn', onclick: () => shift(-4) }, icon('chevronRight', 14, 'flip'), 'Earlier'), h('button', { class: 'btn', onclick: () => { ctl.from = undefined; render(); } }, 'This week'), h('button', { class: 'btn', onclick: () => shift(4) }, 'Later', icon('chevronRight', 14)),
        h('button', { class: 'btn primary', onclick: () => timeOffModal(r, render) }, icon('plus', 15), 'Add time off')),
      h('div', { class: 'card', style: { overflow: 'auto' } }, h('table', { class: 't', style: { border: 0, borderRadius: 0, minWidth: '640px' } },
        h('thead', h('tr', h('th', 'Person'), ...r.weeks.map(w => h('th', { style: { textAlign: 'center' } }, fmt(w))), h('th', { title: 'Open work with no due date' }, 'No date'))),
        h('tbody', r.people.map(p => h('tr', h('td', h('div', { class: 'row' }, avatar(p, 26), h('div', h('div', { style: { fontWeight: 600 } }, p.name), h('div', { class: 'small faint' }, `${p.capacity_hours}h / week`)))),
          ...p.weeks.map(w => h('td', { style: { textAlign: 'center' }, title: `${w.planned}h planned of ${w.capacity}h · ${w.logged}h logged${w.off_days ? ` · ${w.off_days} day(s) off` : ''}` },
            h('div', { style: { background: heat(w.utilization), color: w.utilization ? '#fff' : 'var(--text-3)', borderRadius: '8px', padding: '6px 4px', fontWeight: 650, fontSize: '12px', minWidth: '64px', opacity: w.capacity === 0 ? .5 : 1 } }, w.capacity === 0 ? 'off' : `${w.planned}/${w.capacity}h`), w.off_days ? h('div', { class: 'small faint' }, `🌴 ${w.off_days}d`) : null)),
          h('td', { class: 'small muted' }, p.unscheduled_tasks ? `${p.unscheduled_hours}h · ${p.unscheduled_tasks} tasks` : '—')))))),
      h('div', { class: 'legend', style: { margin: '10px 4px' } }, h('span', h('i', { style: { background: 'var(--green)' } }), 'Comfortable (≤ 85%)'), h('span', h('i', { style: { background: 'var(--amber)' } }), 'Tight (85–110%)'), h('span', h('i', { style: { background: 'var(--red)' } }), 'Overbooked')),
      h('div', { class: 'grid g2', style: { marginTop: '16px' } },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Upcoming time off')), h('div', { class: 'card-body' }, r.time_off.length ? r.time_off.map(o => h('div', { class: 'setting-row' }, h('span', '🌴'), h('div', { class: 'grow' }, h('b', o.name), h('div', { class: 'small faint' }, `${fmt(o.start_date)}${o.end_date !== o.start_date ? ' – ' + fmt(o.end_date) : ''} · ${o.kind}${o.note ? ' · ' + o.note : ''}`)),
          (o.user_id === me.id || ['admin', 'manager'].includes(me.role)) ? h('button', { class: 'icon-btn', 'aria-label': 'Remove', onclick: async () => { if (await confirmDialog('Remove time off?', 'Capacity for these days is restored.', 'Remove')) { await api.del('/time-off/' + o.id); render(); } } }, icon('trash', 16)) : null)) : h('p', { class: 'faint' }, 'Nobody is out. 🎉'))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Your weekly capacity')), h('div', { class: 'card-body' }, h('p', { class: 'muted small', style: { marginBottom: '8px' } }, 'Focused hours you can put into planned work each week (meetings, support and interruptions excluded). Used by sprint planning.'),
          h('div', { class: 'row' }, h('input', { class: 'input', type: 'number', min: 1, max: 60, style: { width: '110px' }, value: r.people.find(p => p.user_id === me.id)?.capacity_hours || 30, id: 'cap-input' }), h('span', 'hours / week'), h('button', { class: 'btn', onclick: async () => { await api.put('/me/prefs', { capacity_hours: +document.getElementById('cap-input').value }).catch(e => toast(e.message, 'error')); toast('Saved', 'success'); render(); } }, 'Save')))))));
  };
  await render();
}

function timeOffModal(r, done) {
  const me = state.me, canOthers = ['admin', 'manager'].includes(me.role);
  const v = { user_id: me.id, start_date: '', end_date: '', kind: 'vacation', note: '' };
  const f = (l, n) => h('div', { class: 'field' }, h('label', l), n);
  modal({ title: 'Add time off', body: [
    canOthers ? f('Who', h('select', { class: 'select', onchange: e => (v.user_id = +e.target.value) }, r.people.map(p => h('option', { value: p.user_id, selected: p.user_id === me.id }, p.name)))) : null,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, f('From', h('input', { class: 'input', type: 'date', onchange: e => { v.start_date = e.target.value; if (!v.end_date) v.end_date = v.start_date; } }))), h('div', { class: 'grow' }, f('To', h('input', { class: 'input', type: 'date', onchange: e => (v.end_date = e.target.value) })))),
    f('Type', h('select', { class: 'select', onchange: e => (v.kind = e.target.value) }, ['vacation', 'sick', 'holiday', 'other'].map(k => h('option', { value: k }, k)))), f('Note (optional)', h('input', { class: 'input', oninput: e => (v.note = e.target.value) }))],
  actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: async () => { try { await api.post('/time-off', v); toast('Time off added', 'success'); done(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}
