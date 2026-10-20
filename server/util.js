export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = m => new HttpError(400, m);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);

export const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));

export const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];
export const pickColor = n => COLORS[Math.abs(n) % COLORS.length];

export const handleOf = name => String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
export const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// minimal, safe Markdown → HTML for emails (headings, bullets, **bold**, > quotes); everything is escaped first
export function mdToHtml(md) {
  const inline = t => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/_([^_]+)_/g, '<i>$1</i>');
  const out = []; let list = false;
  for (const line of String(md).split('\n')) {
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul style="padding-left:20px;margin:6px 0">'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) out.push(`<h3 style="margin:16px 0 6px">${inline(h[1])}</h3>`);
    else if (line.trim()) out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
