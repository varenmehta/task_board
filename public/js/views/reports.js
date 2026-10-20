import { h, mount, icon, toast } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';

const iso = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export async function reportsView(el) {
  const q = { range: 30, project_id: '', team_id: '' };
  const render = async () => {
    const to = new Date(), from = new Date(Date.now() - q.range * 86400000);
    const params = new URLSearchParams({ from: iso(from), to: iso(to), ...(q.project_id && { project_id: q.project_id }), ...(q.team_id && { team_id: q.team_id }) });
    let r;
    try { r = await api.get('/reports?' + params); } catch (e) { return mount(el, h('div', { class: 'page' }, h('div', { class: 'empty' }, e.message))); }
    const max = Math.max(1, ...r.weekly.map(w => Math.max(w.created, w.completed)));
    const tile = (v, l) => h('div', { class: 'card stat' }, h('span', { class: 'v' }, v ?? '—'), h('span', { class: 'l' }, l));
    const sel = (opts, cur, on) => h('select', { class: 'select', style: { width: 'auto', minWidth: '150px' }, onchange: e => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(cur) }, l)));
    const maxL = Math.max(1, ...r.labels.map(l => l.count)), maxA = Math.max(1, ...r.aging.map(a => a.count));
    mount(el, h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Reports'), h('p', { class: 'muted' }, `${r.from} → ${r.to}`)),
        sel([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 6 months']], q.range, v => { q.range = +v; render(); }),
        sel([['', 'All teams'], ...state.teams.map(t => [t.id, t.name])], q.team_id, v => { q.team_id = v; q.project_id = ''; render(); }),
        sel([['', 'All projects'], ...state.projects.filter(p => !q.team_id || p.team_id === +q.team_id).map(p => [p.id, p.name])], q.project_id, v => { q.project_id = v; render(); }),
        h('a', { class: 'btn', href: `/api/reports/export?type=tasks&${params}` }, icon('download', 14), 'Tasks CSV'), h('a', { class: 'btn', href: `/api/reports/export?type=time&${params}` }, icon('download', 14), 'Time CSV')),
      r.empty ? h('div', { class: 'card empty' }, h('b', 'No data'), 'Nothing in your projects for this range.') : [
        h('div', { class: 'grid g4', style: { marginBottom: '16px' } }, tile(r.summary.completed, 'Completed'), tile(r.summary.created, 'Created'), tile(r.summary.cycle_median != null ? r.summary.cycle_median + ' d' : '—', 'Median cycle time'), tile(r.summary.hours_logged + ' h', 'Time logged')),
        h('div', { class: 'grid g2', style: { marginBottom: '16px' } },
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Weekly throughput'), h('span', { class: 'grow' }), h('span', { class: 'legend' }, h('span', h('i', { style: { background: 'var(--accent)' } }), 'Completed'), h('span', h('i', { style: { background: 'var(--surface-3)' } }), 'Created'))),
            h('div', { class: 'card-body' }, r.weekly.length ? h('div', { class: 'spark', style: { height: '140px' } }, r.weekly.map(w => h('div', { style: { flex: 1, display: 'flex', alignItems: 'flex-end', gap: '3px', height: '100%' }, title: `Week of ${w.week}: ${w.completed} done, ${w.created} created${w.cycle_avg != null ? `, avg cycle ${w.cycle_avg}d` : ''}` }, h('i', { class: 'c', style: { height: (w.created / max * 100) + '%' } }), h('i', { style: { height: (w.completed / max * 100) + '%' } })))) : h('p', { class: 'muted' }, 'No activity in this range.'))),
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Open work by age')), h('div', { class: 'card-body col', style: { gap: '8px' } }, r.aging.map(a => h('div', h('div', { class: 'row small' }, h('span', { class: 'grow' }, a.label), h('b', a.count)), h('div', { class: 'bar' }, h('i', { style: { width: (a.count / maxA * 100) + '%', background: a.label.startsWith('30') ? 'var(--red)' : 'var(--accent)' } }))))))),
        h('div', { class: 'grid g2' },
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'People')), h('div', { class: 'table-wrap', style: { padding: '4px 0 8px' } }, h('table', { class: 't', style: { border: 0, borderRadius: 0 } }, h('thead', h('tr', h('th', 'Person'), h('th', 'Done'), h('th', 'Est. h'), h('th', 'Logged h'), h('th', 'Cycle d'))),
            h('tbody', r.people.map(p => h('tr', h('td', { style: { fontWeight: 550 } }, p.name), h('td', p.completed), h('td', p.hours_estimated ?? '—'), h('td', p.hours_logged || '—'), h('td', p.cycle_avg ?? '—'))))))),
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Completed by label')), h('div', { class: 'card-body col', style: { gap: '8px' } }, r.labels.length ? r.labels.map(l => h('div', h('div', { class: 'row small' }, h('span', { class: 'grow' }, '#' + l.label), h('b', l.count)), h('div', { class: 'bar' }, h('i', { style: { width: (l.count / maxL * 100) + '%', background: '#8b5cf6' } })))) : h('p', { class: 'muted' }, 'No labelled work completed.'))))]));
  };
  await render();
}
void toast;
