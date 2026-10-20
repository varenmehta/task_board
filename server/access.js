import { all, get } from './db.js';

// Org roles: admin > manager > member > viewer. Team roles: lead | member.
// Access to a project follows team membership; admins see everything.

export const teamRole = (u, teamId) => get('SELECT role FROM team_members WHERE team_id=? AND user_id=?', teamId, u.id)?.role;
export const canViewProject = (u, p) => u.role === 'admin' || !!teamRole(u, p.team_id);
export const canEditProject = (u, p) => u.role !== 'viewer' && canViewProject(u, p);
export const canManageTeam = (u, teamId) =>
  u.role === 'admin' || (u.role !== 'viewer' && (teamRole(u, teamId) === 'lead' || (u.role === 'manager' && !!teamRole(u, teamId))));

export function visibleProjects(u, { archived = false } = {}) {
  const sql = `SELECT p.*, t.name AS team_name, t.color AS team_color FROM projects p JOIN teams t ON t.id=p.team_id
    WHERE p.archived=? ${u.role === 'admin' ? '' : 'AND p.team_id IN (SELECT team_id FROM team_members WHERE user_id=' + Number(u.id) + ')'}
    ORDER BY t.name, p.name`;
  return all(sql, archived ? 1 : 0);
}

export function projectMembers(projectOrTeamId) {
  const teamId = typeof projectOrTeamId === 'object' ? projectOrTeamId.team_id : projectOrTeamId;
  return all(`SELECT DISTINCT u.id, u.name, u.email, u.color, u.role FROM users u
    LEFT JOIN team_members tm ON tm.user_id=u.id AND tm.team_id=?
    WHERE u.active=1 AND (tm.user_id IS NOT NULL OR u.role='admin') ORDER BY u.name`, teamId);
}

export const usersWhoCanView = project => projectMembers(project).map(u => u.id);
export const teamLeads = teamId => all(`SELECT u.* FROM users u JOIN team_members tm ON tm.user_id=u.id
  WHERE tm.team_id=? AND tm.role='lead' AND u.active=1`, teamId);
