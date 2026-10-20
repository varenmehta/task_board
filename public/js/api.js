export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function call(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError(0, navigator.onLine ? 'Could not reach the server' : 'You are offline — changes can’t be saved right now'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/login')) window.dispatchEvent(new Event('tb:unauthorized'));
    throw new ApiError(res.status, data.error || 'Request failed');
  }
  return data;
}
export const api = {
  get: p => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b),
  put: (p, b) => call('PUT', p, b),
  del: p => call('DELETE', p),
};
