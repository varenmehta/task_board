import { h, mount, icon, modal, toast, todayStr, priorityBadge, avatar } from '../dom.js';
import { api } from '../api.js';
import { userById } from '../state.js';
import { voiceButton } from '../voice.js';

// Paste meeting notes → review extracted action items → create them all.
export function notesImportModal(ctl) {
  const ta = h('textarea', { class: 'textarea', style: { minHeight: '180px' }, placeholder: 'Paste meeting notes, a Slack thread, or an email…\n\n- TODO: Update the onboarding checklist by Friday\n- Priya to review the OpenAPI spec\n- [ ] Write release notes tomorrow' });
  const out = h('div', { class: 'col' });
  const mic = voiceButton(() => ta);
  let rows = [];
  const go = h('button', { class: 'btn ai', onclick: async () => {
    if (!ta.value.trim()) return;
    go.disabled = true; go.replaceChildren(h('span', { class: 'spinner' }), 'Reading…');
    try {
      const r = await api.post('/ai/extract', { project_id: ctl.pid, text: ta.value, today: todayStr() });
      rows = r.tasks.map(t => ({ t, cb: h('input', { type: 'checkbox', checked: true }) }));
      mount(out, h('div', { class: 'row' }, h('span', { class: 'ai-badge' }, icon('sparkles', 12), r.ai ? 'AI extracted' : 'Pattern-matched'), h('span', { class: 'small muted' }, `${rows.length} action item${rows.length === 1 ? '' : 's'}`)),
        rows.length ? rows.map(({ t, cb }) => h('label', { class: 'row', style: { alignItems: 'flex-start', padding: '4px 0' } }, cb, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 550 } }, t.title), h('div', { class: 'row small', style: { gap: '8px', marginTop: '2px' } }, priorityBadge(t.priority, true), t.due_date ? h('span', { class: 'chip' }, t.due_date) : null, t.assignee_id ? h('span', { class: 'row', style: { gap: '4px' } }, avatar(userById(t.assignee_id), 16), userById(t.assignee_id)?.name) : null)))) : h('div', { class: 'empty', style: { padding: '14px' } }, 'No action items found. Try lines starting with TODO:, Action:, or “Name to …”.'));
    } catch (e) { toast(e.message, 'error'); }
    go.disabled = false; go.replaceChildren(icon('sparkles', 14), 'Find action items');
  } }, icon('sparkles', 14), 'Find action items');
  modal({ title: '✨ Create tasks from notes', width: 640, body: [ta, h('div', { class: 'row' }, go, mic, h('span', { class: 'grow' })), out],
    actions: [{ label: 'Cancel' }, { label: 'Create selected', kind: 'primary', onClick: async () => {
      const picked = rows.filter(r => r.cb.checked).map(r => r.t);
      if (!picked.length) { toast('Nothing selected', 'error'); return false; }
      let n = 0;
      for (const t of picked) { try { await api.post(`/projects/${ctl.pid}/tasks`, { ...t, status: ctl.project.statuses.find(s => s.id === 'todo')?.id || ctl.project.statuses[0].id }); n++; } catch (e) { toast(`“${t.title.slice(0, 30)}”: ${e.message}`, 'error'); } }
      toast(`Created ${n} task${n === 1 ? '' : 's'}`, 'success'); await ctl.reload();
    } }] });
}
