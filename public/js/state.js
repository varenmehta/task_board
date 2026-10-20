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
export const membersOfTeam = teamId => state.users.filter(u => u.role === 'admin' || u.teams.some(t => t.team_id === teamId));
export const membersOfProject = pid => { const p = projectById(pid); return p ? membersOfTeam(p.team_id) : []; };
