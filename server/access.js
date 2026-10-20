import { all, get } from './db.js';

// Org roles: admin > manager > member > viewer > guest.  Team roles: lead | member.
// Project roles (explicit, optional): manager | editor | commenter | viewer.
//
// Effective project role = explicit project_members entry if present (it can both grant access
// to outsiders such as clients, and restrict a team member), otherwise derived from team membership.
// Org-level "viewer" caps everything at viewer; "guest" caps at commenter.
const RANK = { viewer: 1, commenter: 2, editor: 3, manager: 4 };

export const teamRole = (u, teamId) => get('SELECT role FROM team_members WHERE team_id=? AND user_id=?', teamId, u.id)?.role;

export function projectRole(u, p) {
  if (!u || !p) return null;
  if (u.role === 'admin') return 'manager';
  const explicit = get('SELECT role FROM project_members WHERE project_id=? AND user_id=?', p.id, u.id)?.role;
  let role = null;
  if (explicit) role = explicit;
  else {
    const tr = teamRole(u, p.team_id);
    if (tr) role = tr === 'lead' || u.role === 'manager' ? 'manager' : 'editor';
  }
  if (!role) return null;
  const cap = u.role === 'viewer' ? 'viewer' : u.role === 'guest' ? 'commenter' : null;
  return cap && RANK[role] > RANK[cap] ? cap : role;
}

export const canViewProject = (u, p) => !!projectRole(u, p);
export const canCommentProject = (u, p) => !!projectRole(u, p);
export const canEditProject = (u, p) => RANK[projectRole(u, p)] >= RANK.editor;
export const canManageProject = (u, p) => projectRole(u, p) === 'manager';
export const canManageTeam = (u, teamId) =>
  u.role === 'admin' || (!['viewer', 'guest'].includes(u.role) && (teamRole(u, teamId) === 'lead' || (u.role === 'manager' && !!teamRole(u, teamId))));

export function visibleProjects(u, { archived = false } = {}) {
  const uid = Number(u.id);
  const where = u.role === 'admin' ? '' : `AND (p.team_id IN (SELECT team_id FROM team_members WHERE user_id=${uid}) OR p.id IN (SELECT project_id FROM project_members WHERE user_id=${uid}))`;
  const rows = all(`SELECT p.*, t.name AS team_name, t.color AS team_color FROM projects p JOIN teams t ON t.id=p.team_id
    WHERE p.archived=? ${where} ORDER BY t.name, p.name`, archived ? 1 : 0);
  // an explicit "no access" is impossible (rows are removed instead), but org caps may still apply
  return rows.filter(p => projectRole(u, p));
}

// People who can be assigned work in a project: team members, admins, explicit editors/managers.
export function projectMembers(projectOrTeamId) {
  const project = typeof projectOrTeamId === 'object' ? projectOrTeamId : null;
  const teamId = project ? project.team_id : projectOrTeamId;
  return all(`SELECT DISTINCT u.id, u.name, u.email, u.color, u.role FROM users u
    LEFT JOIN team_members tm ON tm.user_id=u.id AND tm.team_id=?
    LEFT JOIN project_members pm ON pm.user_id=u.id AND pm.project_id=?
    WHERE u.active=1 AND u.role NOT IN ('viewer','guest') AND (
      (tm.user_id IS NOT NULL AND (pm.role IS NULL OR pm.role IN ('manager','editor'))) OR u.role='admin' OR pm.role IN ('manager','editor'))
    ORDER BY u.name`, teamId, project?.id ?? -1);
}

// Everyone who can *see* the project (for live updates, mentions).
export function usersWhoCanView(project) {
  const ids = new Set(all(`SELECT id FROM users WHERE active=1 AND role='admin'`).map(r => r.id));
  for (const r of all('SELECT user_id FROM team_members WHERE team_id=?', project.team_id)) ids.add(r.user_id);
  for (const r of all('SELECT user_id FROM project_members WHERE project_id=?', project.id)) ids.add(r.user_id);
  return [...ids];
}

export const teamLeads = teamId => all(`SELECT u.* FROM users u JOIN team_members tm ON tm.user_id=u.id
  WHERE tm.team_id=? AND tm.role='lead' AND u.active=1`, teamId);
