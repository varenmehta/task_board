import { DEFAULT_STATUSES } from './config.js';
import { parseJSON } from './db.js';
import { bad } from './util.js';

const cache = new Map(); // project id -> { raw, list }

export function projectStatuses(project) {
  if (!project) return DEFAULT_STATUSES;
  const hit = cache.get(project.id);
  if (hit && hit.raw === project.statuses) return hit.list;
  const list = project.statuses ? parseJSON(project.statuses, DEFAULT_STATUSES) : DEFAULT_STATUSES;
  cache.set(project.id, { raw: project.statuses, list });
  return list;
}
export const statusIds = project => projectStatuses(project).map(s => s.id);
export const doneId = 'done';
export const defaultStatus = project => {
  const l = projectStatuses(project);
  return (l.find(s => s.id === 'todo') || l.find(s => s.category === 'todo') || l[0]).id;
};
export const startedStatus = project => {
  const l = projectStatuses(project);
  return (l.find(s => s.id === 'in_progress') || l.find(s => s.category === 'doing'))?.id ?? null;
};
export const reviewStatus = project => {
  const l = projectStatuses(project);
  return (l.find(s => s.id === 'review') || [...l].reverse().find(s => s.category === 'doing'))?.id ?? null;
};
export const statusMeta = (project, id) => projectStatuses(project).find(s => s.id === id) || { id, label: id, category: 'todo' };

export function validateStatuses(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 12) throw bad('A project needs between 2 and 12 columns');
  const seen = new Set();
  const out = list.map(s => {
    const id = String(s.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    const label = String(s.label || '').trim().slice(0, 30);
    if (!id || !label) throw bad('Every column needs a name');
    if (seen.has(id)) throw bad('Column ids must be unique');
    seen.add(id);
    const category = id === 'done' ? 'done' : ['todo', 'doing'].includes(s.category) ? s.category : 'todo';
    const wip = s.wip == null || s.wip === '' ? null : Math.max(1, Math.min(99, Math.floor(Number(s.wip)) || 1));
    return { id, label, category, wip };
  });
  if (!seen.has('done')) throw bad('The “Done” column cannot be removed');
  if (out.every(s => s.id === 'done')) throw bad('Add at least one open column');
  return out;
}
