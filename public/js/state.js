// Shared client state + tiny pub/sub.
export const state = {
  me: null, workspace: 'TaskBoard', statuses: [], aiMode: 'local',
  projects: [], users: [], teams: [], unread: 0, demo: false,
};
const subs = new Map();
export const on = (evt, fn) => { if (!subs.has(evt)) subs.set(evt, new Set()); subs.get(evt).add(fn); return () => subs.get(evt).delete(fn); };
export const emit = (evt, data) => subs.get(evt)?.forEach(fn => fn(data));
export const userById = id => state.users.find(u => u.id === id);
export const projectById = id => state.projects.find(p => p.id === id);
export const isViewer = () => state.me?.role === 'viewer';
export const canManage = () => ['admin', 'manager'].includes(state.me?.role);
export const statusesOf = pid => projectById(pid)?.statuses || state.statuses;
export const membersOfProject = pid => { const p = projectById(pid); return p ? state.users.filter(u => p.member_ids?.includes(u.id)) : []; };
export const roleOf = pid => projectById(pid)?.role || null;
export const canEditIn = pid => !!projectById(pid)?.can_edit;
